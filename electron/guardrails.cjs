'use strict';

/**
 * Safety layer for ORVEX's OS tools.
 * Full-auto execution, with hard blocks on system folders, credentials and
 * destructive shell commands. Everything that passes is written to the audit log.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const security = require('./security.cjs');

const SENSITIVE_NAMES = new Set([
  'login data',
  'login data-journal',
  'cookies',
  'cookies-journal',
  'web data',
  'wallet.dat',
  'ntds.dit',
  'sam',
  'system',
  'security',
  'keychain',
  'id_rsa',
  'id_dsa',
  'id_ed25519',
  'id_ecdsa',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.psql_history',
  'consolehost_history.txt',
  'credentials',
  'credentials.json',
  'secrets.json',
  'protected storage',
  'logins.json',
  'key3.db',
  'key4.db',
  'signons.sqlite',
  '.aws',
  '.azure',
  '.docker',
  '.kube',
  '.gnupg',
  '.terraform.d',
]);

/** \\\\host\\share — Windows network paths are not covered by the drive-root checks. */
function uncInfo(target) {
  const match = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(target);
  return match ? { host: match[1].toLowerCase().replace(/:\d+$/, ''), share: match[2].toLowerCase() } : null;
}

function isLocalHost(host) {
  if (!host || host === '.' || host === '(local)') return true;
  if (['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host)) return true;
  const name = String(os.hostname() || '').toLowerCase();
  return !!name && (host === name || host === name.replace(/\..*$/, ''));
}

function systemRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    const env = process.env;
    [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData].forEach((r) => r && roots.push(r));
    roots.push('C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData');
    roots.push('C:\\$Recycle.Bin', 'C:\\Recovery', 'C:\\Boot');
  } else {
    roots.push('/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/var/lib');
  }
  return [...new Set(roots.map((r) => path.resolve(r).toLowerCase()))];
}

function isUnder(target, root) {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Windows accepts \\?\, \\.\ and \\?\UNC\ prefixes that point at the same file
 * as the plain path. Strip them so the policy below sees what the OS will open.
 * Device/global-namespace paths (GLOBALROOT, PIPE, Volume{...}) stay blocked.
 */
function normalizeWindowsPath(value) {
  if (process.platform !== 'win32') return { path: value, device: false };
  let out = value
    .replace(/^[\\/]{2}(?:\?\?|\?)[\\/]UNC[\\/]/i, '\\\\')
    .replace(/^[\\/]{2}(?:\?\?|\?|\.)[\\/]/, '');
  const prefixed = out !== value;
  if (prefixed && !/^[a-z]:([\\/]|$)/i.test(out) && !/^\\\\[^\\/]/.test(out)) {
    return { path: out, device: true };
  }
  if (/^\\\\[.?]{1,2}[\\/]|(^|[\\/])globalroot([\\/]|$)/i.test(out)) return { path: out, device: true };
  return { path: out, device: false };
}

/** Resolve 8.3 names and junctions so a short name cannot hide a system folder. */
function canonicalPath(resolved) {
  let current = resolved;
  const tail = [];
  for (let depth = 0; depth < 16; depth += 1) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse());
    } catch {
      /* the full path does not exist — try the nearest real ancestor */
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    tail.push(path.basename(current));
    current = parent;
  }
  return resolved;
}

/** Returns null when the path is allowed, or a human-readable block reason. */
function checkPath(rawPath, mode) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return 'Path is empty.';
  let resolved;
  try {
    const cleaned = normalizeWindowsPath(rawPath.trim().replace(/^["']|["']$/g, ''));
    if (cleaned.device) return 'Blocked: Windows device and global-namespace paths are off-limits.';
    resolved = path.resolve(cleaned.path);
  } catch {
    return 'Path could not be resolved.';
  }

  if (process.platform === 'win32' && resolved.replace(/^[a-z]:/i, '').includes(':')) {
    return 'Blocked: NTFS alternate data streams ("file:stream") are off-limits.';
  }

  // Network paths are judged before realpath: canonicalising a dead share can
  // block for seconds on SMB timeouts.
  const unc = uncInfo(resolved);
  if (unc) {
    if (unc.share.endsWith('$')) {
      return `Blocked: "${resolved}" is an administrative network share (${unc.share}). Those expose system and credential files.`;
    }
    if (isLocalHost(unc.host)) {
      return `Blocked: "${resolved}" points back at this PC through the network. Use the local path instead.`;
    }
    const remoteParts = resolved.toLowerCase().split(/[\\/]+/);
    for (const part of remoteParts) {
      if (SENSITIVE_NAMES.has(part)) {
        return `Blocked: "${resolved}" looks like a credentials store. ORVEX does not read passwords or keys.`;
      }
    }
    if (/\.(pem|pfx|p12)$/i.test(resolved)) return 'Blocked: private keys are off-limits.';
    return null;
  }

  const lower = canonicalPath(resolved).toLowerCase();

  for (const root of systemRoots()) {
    if (isUnder(lower, root)) {
      return `Blocked: "${resolved}" is inside a system folder (${root}). ORVEX does not touch system files.`;
    }
  }

  const parts = lower.split(path.sep);
  for (const part of parts) {
    if (SENSITIVE_NAMES.has(part)) {
      return `Blocked: "${resolved}" looks like a credentials store. ORVEX does not read passwords or keys.`;
    }
  }
  if (/\.(pem|pfx|p12)$/.test(lower) || /(^|[\\/])\.ssh([\\/]|$)/.test(lower)) {
    return 'Blocked: private keys are off-limits.';
  }

  if (process.platform === 'win32') {
    if (/^[a-z]:\\?$/i.test(resolved)) return `Blocked: "${resolved}" is a whole drive. Pick a folder.`;
    if (isUnder(lower, path.resolve(process.env.SystemDrive || 'C:\\').toLowerCase())) {
      // C:\ itself is blocked; C:\Users\... is fine.
      const rootOfDrive = path.parse(resolved).root.toLowerCase();
      if (lower.replace(/\\+$/, '') === rootOfDrive.replace(/\\+$/, '')) {
        return `Blocked: "${resolved}" is a whole drive. Pick a folder.`;
      }
    }
  }

  // Writes are allowed anywhere the user can normally write; system roots above
  // are already excluded, and a directory named "System32" is rejected there.
  return null;
}

const COMMAND_BLOCKLIST = [
  [/\bformat(\.com)?\s+[a-z]:/i, 'disk formatting'],
  [/\bdiskpart\b/i, 'disk partitioning'],
  [/\bbcdedit\b/i, 'boot configuration edits'],
  [/\bvssadmin\b[^\n]*\bdelete\b/i, 'shadow-copy deletion'],
  [/\bwmic\b[^\n]*\bshadowcopy\b[^\n]*\bdelete\b/i, 'shadow-copy deletion'],
  [/\bwbadmin\b[^\n]*\bdelete\b/i, 'backup deletion'],
  [/\bcipher\b[^\n]*\/w/i, 'disk wiping'],
  [/\breg(\.exe)?\s+(delete|add)\s+HKLM/i, 'HKLM registry edits'],
  [/\bnet\s+user\b/i, 'account changes'],
  [/\bnet\s+localgroup\b/i, 'group changes'],
  [/\btakeown\b/i, 'ownership changes'],
  [/\bicacls\b[^\n]*\/(grant|deny|setowner|reset)\b/i, 'permission changes'],
  [/\bshutdown\b/i, 'shutdown/restart'],
  [/\bRestart-Computer\b/i, 'shutdown/restart'],
  [/\bStop-Computer\b/i, 'shutdown/restart'],
  [/-encodedcommand\b/i, 'encoded PowerShell'],
  [/\s-(?:ec|enc)\b/i, 'encoded PowerShell'],
  [/(?:^|[\s"'`])-e\s+["']?[A-Za-z0-9+/]{16,}={0,2}\b/, 'encoded PowerShell'],
  [/\bFromBase64String\b/i, 'encoded PowerShell'],
  [/\bcertutil(\.exe)?\b[^\n]*\s-(urlcache|decode|encode)\b/i, 'certutil download/decode tricks'],
  [/\bbitsadmin(\.exe)?\b[^\n]*\/transfer\b/i, 'BITS job downloads'],
  [/\bmshta(\.exe)?\b[^\n]*(https?:|javascript:|vbscript:)/i, 'mshta script execution'],
  [/\bregsvr32(\.exe)?\b[^\n]*\/i:https?:/i, 'regsvr32 remote script execution'],
  [/\brundll32(\.exe)?\b[^\n]*javascript:/i, 'rundll32 script execution'],
  [/\bwmic(\.exe)?\s+process\s+(call|delete)\b/i, 'remote process creation'],
  [/\binstallutil(\.exe)?\b/i, 'installutil code execution'],
  [/\bhh(\.exe)?\s+https?:/i, 'HTML Help remote content'],
  [/\bpubprn(\.vbs)?\b/i, 'scriptlet execution'],
  [/\bDownload(?:String|File)\b/i, 'download-and-run PowerShell'],
  [/\bStart-BitsTransfer\b/i, 'BITS job downloads'],
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+[\\/](\s|$)/i, 'root deletion'],
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+(~|\$home)(\s|$)/i, 'home-folder deletion'],
  [/\b(rd|rmdir)\s+\/s\b/i, 'recursive directory deletion'],
  [/\b(del|erase)\b[^\n]*\/s\b/i, 'recursive delete'],
  [/\bRemove-Item\b[^\n]*-Recurse/i, 'recursive delete'],
  [/\bmkfs\b/i, 'filesystem creation'],
  [/\bdd\b[^\n]*of=\/dev\//i, 'raw disk write'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(bash|sh|iex|Invoke-Expression)\b/i, 'remote code execution'],
  [/\biex\s*\(/i, 'remote code execution'],
  [/>\s*[a-z]:\\(windows|program files|programdata)/i, 'overwriting system folders'],
  [
    /(^|[^\w])[a-z]:\\(windows|program files( \(x86\))?|programdata|recovery|boot|system volume information)([\\/\s"']|$)/i,
    'system folder access',
  ],
  [/%(systemroot|windir)%/i, 'system folder access'],
];

/** Quoted strings and bare absolute-path operands inside a command line. */
const PATH_TOKEN_RE = /"([^"\r\n]+)"|'([^'\r\n]+)'|((?:[a-z]:[\\/]|\\\\|\/\/)[^\s|&<>;"']+)/gi;

/**
 * Run every absolute path the command touches through checkPath, so
 * `copy "…\Login Data" x` or `type \\localhost\C$\Windows\…` is still caught
 * even when the command itself is not on the blocklist.
 */
function commandPathBlock(cmd) {
  const seen = new Set();
  PATH_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = PATH_TOKEN_RE.exec(cmd))) {
    const token = (match[1] || match[2] || match[3] || '').trim();
    if (!token || !/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(token)) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const blocked = checkPath(token, 'read');
    if (blocked) return blocked;
    if (seen.size >= 24) break;
  }
  return null;
}

/** Returns null when the command is allowed, otherwise the block reason. */
function checkCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return 'Command is empty.';
  if (cmd.length > 4000) return 'Command is too long (4k chars max).';
  // cmd.exe and PowerShell both let escapes and extension variants hide the
  // real program name (`n^et user`, `net.exe user`), so match on de-escaped,
  // extension-less copies too.
  const variants = new Set([cmd]);
  variants.add(cmd.replace(/\^(.)/g, '$1').replace(/`(.)/g, '$1'));
  variants.add(cmd.replace(/\.(exe|com|bat|cmd)\b/gi, ''));
  variants.add(cmd.replace(/\^(.)/g, '$1').replace(/`(.)/g, '$1').replace(/\.(exe|com|bat|cmd)\b/gi, ''));
  for (const variant of variants) {
    for (const [re, label] of COMMAND_BLOCKLIST) {
      if (re.test(variant)) {
        return `Blocked: ${label} is on ORVEX's dangerous-command list. If you really need this, run it yourself.`;
      }
    }
  }
  const pathBlocked = commandPathBlock(cmd);
  if (pathBlocked) return pathBlocked;
  return security.commandPolicyBlock(cmd);
}

/**
 * Things ORVEX may do but not silently: dangerous-but-legit operations that need
 * a human nod. Guardrails still hard-block the really destructive ones above.
 */
const APPROVAL_COMMANDS = [
  [/\bRemove-Item\b/i, 'deletes files'],
  [/\b(rd|rmdir)\b/i, 'removes a folder'],
  [/\b(del|erase)\b/i, 'deletes files'],
  [/\b(taskkill|Stop-Process)\b/i, 'stops a running program'],
  [/\bsc(\.exe)?\s+(create|delete|config|stop|start|failure)\b/i, 'changes a Windows service'],
  [/\bschtasks\b/i, 'changes a scheduled task'],
  [/\breg(\.exe)?\s+(add|delete|import)\b/i, 'changes the per-user registry'],
  [/\bnetsh\b/i, 'changes network settings'],
  [/\bgit\s+push\b/i, 'publishes commits to a remote'],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, 'publishes a package'],
  [/\b(winget|choco|scoop)\s+(install|uninstall|upgrade)\b/i, 'installs or removes software'],
  [/\b(Install-Package|Install-Module|Uninstall-Package|Uninstall-Module)\b/i, 'installs or removes software'],
  [/\bpip3?\s+(install|uninstall)\b/i, 'installs or removes Python packages'],
  [/\b(curl|wget|iwr|invoke-webrequest)\b[^\n]*(\s-o\s|\s--output\s|-outfile\s)/i, 'downloads a file from the internet'],
  [/\b(msiexec|start-process)\b[^\n]*\.(exe|msi|bat|cmd|ps1)\b/i, 'runs an installer or script'],
  [/\bSet-ItemProperty\b|\bNew-ItemProperty\b/i, 'changes registry or system properties'],
  [/\bicacls\b|\btakeown\b/i, 'changes file permissions'],
  [/\bstop-service\b|\bstart-service\b/i, 'starts or stops a Windows service'],
];

const RISKY_WRITE_EXT = /\.(exe|msi|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|hta|scr|reg|lnk|jar|dll|sys|cpl|msc)$/i;

/** Returns null when the call can run unattended, or why a human should confirm it. */
function needsApproval(tool, args) {
  const a = args || {};
  if (tool === 'shell_exec') {
    const cmd = String(a.command || '');
    for (const [re, why] of APPROVAL_COMMANDS) {
      if (re.test(cmd)) return `This command ${why}.`;
    }
    if (/(?:\||>|&|;)\s*[^|>&;]*\.(exe|bat|cmd|ps1|vbs|vbe|js|jse|wsf|hta|scr)\b/i.test(cmd)) {
      return 'This command runs another executable or script.';
    }
    if (/(?:^|[\s;&|])(?:start|call)\s+[^\n]*\.(exe|bat|cmd|ps1|vbs|msi)\b/i.test(cmd)) {
      return 'This command launches another executable or script.';
    }
    if (/(?:^|[\s;&|])(?:powershell|pwsh)(?:\.exe)?\b/i.test(cmd)) {
      return 'This command runs a PowerShell session.';
    }
  }
  if (tool === 'fs_write') {
    const target = String(a.path || '');
    if (RISKY_WRITE_EXT.test(target)) return 'Writing this file type can execute code on this PC.';
    if (/[\\/]startup([\\/]|$)|start menu[\\/]programs[\\/]startup/i.test(target)) {
      return 'This file sits in a Windows startup folder.';
    }
  }
  if (tool === 'app_open') {
    if (RISKY_WRITE_EXT.test(String(a.target || ''))) return 'This opens an executable or script.';
  }
  if (tool === 'process_kill') {
    return 'This stops a running program.';
  }
  if (tool === 'app_launch') {
    return 'This launches a program on this PC.';
  }
  if ((tool === 'file_backup' || tool === 'file_versions') && String(a.op || '').toLowerCase() === 'restore') {
    return 'This overwrites the current file with an older copy.';
  }
  if (tool === 'file_archive' && String(a.op || '').toLowerCase() === 'unzip') {
    return 'This writes an archive\'s files onto this PC.';
  }
  if (tool === 'media_generate_image' || tool === 'media_edit_image') {
    return 'This calls a paid image provider and saves the result.';
  }
  if (tool === 'media_library' && String(a.op || '').toLowerCase() === 'delete') {
    return 'This deletes a file from the media library.';
  }
  if (tool === 'window_action' && String(a.action || '').toLowerCase() === 'close') {
    return 'This closes a window that may have unsaved work.';
  }
  return null;
}

/** Only http(s) and mailto links may be opened externally. */
function checkUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return 'Only http(s) and mailto links can be opened.';
    return null;
  } catch {
    return 'Not a valid URL.';
  }
}

module.exports = { checkPath, checkCommand, checkUrl, needsApproval, systemRoots };
