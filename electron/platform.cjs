'use strict';

/**
 * macOS and Linux adapters for the desktop primitives Windows implements with
 * its native helper. Every command is spawned with an argument vector (never a
 * shell), and a missing CLI tool produces an explicit install hint instead of a
 * silent no-op. Windows never reaches this module.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

let execImpl = execFile;
let platformName = process.platform;
const toolCache = new Map();
let appCache = { at: 0, apps: null };

function _setExec(fn) {
  execImpl = typeof fn === 'function' ? fn : execFile;
}

function _setPlatform(name) {
  platformName = String(name || process.platform);
  toolCache.clear();
  appCache = { at: 0, apps: null };
}

function isMac() {
  return platformName === 'darwin';
}

function isLinux() {
  return platformName === 'linux';
}

function run(file, args, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      execImpl(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errOut = String(stderr || '');
        if (err) {
          finish({ ok: false, stdout: out, stderr: errOut, error: (errOut || (err && err.message) || 'command failed').trim().slice(0, 600) });
          return;
        }
        finish({ ok: true, stdout: out, stderr: errOut });
      });
    } catch (err) {
      finish({ ok: false, stdout: '', stderr: '', error: err && err.message ? err.message : String(err) });
    }
  });
}

function osascript(lines, timeout = 15000) {
  const args = [];
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    args.push('-e', line);
  }
  return run('osascript', args, timeout);
}

function jxa(script, timeout = 20000) {
  return run('osascript', ['-l', 'JavaScript', '-e', script], timeout);
}

function hasTool(name) {
  const key = `${platformName}:${name}`;
  if (toolCache.has(key)) return toolCache.get(key);
  // hasTool is synchronous by contract for capability checks; use a cached probe
  // populated by probeTools() and fall back to synchronous PATH scanning.
  const hit = findOnPath(name);
  toolCache.set(key, hit);
  return hit;
}

function _setTools(map) {
  for (const [name, found] of Object.entries(map || {})) {
    toolCache.set(`${platformName}:${name}`, found === true);
  }
}

function findOnPath(name) {
  const extras = isMac()
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
    : ['/usr/local/bin', '/snap/bin', path.join(os.homedir(), '.local/bin')];
  const dirs = [...String(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extras];
  const exts = platformName === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const full = path.join(dir, `${name}${ext}`);
        const st = fs.statSync(full);
        if (st.isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function missingTool(name, hint) {
  return { ok: false, error: `${name} is required for this action but was not found on PATH. ${hint}` };
}

/* --------------------------------- input ---------------------------------- */

const MAC_MODIFIERS = {
  CTRL: 'control down',
  CONTROL: 'control down',
  SHIFT: 'shift down',
  ALT: 'option down',
  OPTION: 'option down',
  WIN: 'command down',
  META: 'command down',
  CMD: 'command down',
  COMMAND: 'command down',
};

const MAC_KEY_CODES = {
  ENTER: 36,
  RETURN: 36,
  TAB: 48,
  ESC: 53,
  ESCAPE: 53,
  SPACE: 49,
  BACKSPACE: 51,
  BKSP: 51,
  DELETE: 51,
  FORWARDDELETE: 117,
  HOME: 115,
  END: 119,
  PAGEUP: 116,
  PAGEDOWN: 121,
  UP: 126,
  DOWN: 125,
  LEFT: 123,
  RIGHT: 124,
  CAPS: 57,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
};

const LINUX_KEYS = {
  CTRL: 'ctrl',
  CONTROL: 'ctrl',
  SHIFT: 'shift',
  ALT: 'alt',
  OPTION: 'alt',
  WIN: 'super',
  META: 'super',
  CMD: 'super',
  COMMAND: 'super',
  ENTER: 'Return',
  RETURN: 'Return',
  TAB: 'Tab',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  SPACE: 'space',
  BACKSPACE: 'BackSpace',
  BKSP: 'BackSpace',
  DELETE: 'Delete',
  DEL: 'Delete',
  INSERT: 'Insert',
  INS: 'Insert',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'Page_Up',
  PAGEDOWN: 'Page_Down',
  UP: 'Up',
  DOWN: 'Down',
  LEFT: 'Left',
  RIGHT: 'Right',
  CAPS: 'Caps_Lock',
  PRINTSCREEN: 'Print',
  PRTSC: 'Print',
  MEDIAPLAY: 'XF86AudioPlay',
  PLAYPAUSE: 'XF86AudioPlay',
  MEDIANEXT: 'XF86AudioNext',
  NEXTTRACK: 'XF86AudioNext',
  MEDIAPREV: 'XF86AudioPrev',
  PREVTRACK: 'XF86AudioPrev',
  MEDIASTOP: 'XF86AudioStop',
  VOLUMEUP: 'XF86AudioRaiseVolume',
  VOLUMEDOWN: 'XF86AudioLowerVolume',
  VOLUMEMUTE: 'XF86AudioMute',
  MUTE: 'XF86AudioMute',
  BROWSERBACK: 'XF86Back',
  BROWSERFORWARD: 'XF86Forward',
  BROWSERREFRESH: 'XF86Reload',
};

const LINUX_MOUSE_BUTTON = { left: 1, middle: 2, right: 3 };
const BUTTON_NAMES = { 0: 'left', 1: 'right', 2: 'middle', left: 'left', middle: 'middle', right: 'right' };

function buttonName(value) {
  return BUTTON_NAMES[String(value ?? 'left').toLowerCase()] || 'left';
}

function quoteArgv(value) {
  return String(value);
}

function applescriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function splitCombo(parts) {
  const modifiers = [];
  const base = [];
  for (const raw of parts) {
    const key = String(raw || '').trim().toUpperCase();
    if (!key) continue;
    if (MAC_MODIFIERS[key]) modifiers.push(key);
    else base.push(key);
  }
  return { modifiers, base };
}

function macKeyLine(key, modifiers) {
  const using = modifiers.length ? ` using {${modifiers.map((m) => MAC_MODIFIERS[m]).join(', ')}}` : '';
  const code = MAC_KEY_CODES[key];
  if (code !== undefined) return `key code ${code}${using}`;
  if (/^[A-Z0-9]$/.test(key)) return `keystroke ${applescriptString(key.toLowerCase())}${using}`;
  if (/^F([1-9]|1[0-2])$/.test(key)) return `key code ${MAC_KEY_CODES[key]}${using}`;
  return null;
}

function linuxKeyName(key) {
  if (LINUX_KEYS[key]) return LINUX_KEYS[key];
  if (/^[A-Z]$/.test(key)) return key.toLowerCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  return null;
}

async function pressKeys(parts) {
  if (!Array.isArray(parts) || !parts.length) return { ok: false, error: 'Give keys like "CTRL+S" or "ENTER".' };
  if (isMac()) {
    const { modifiers, base } = splitCombo(parts);
    if (base.length !== 1) return { ok: false, error: 'Use one non-modifier key per combination, e.g. CTRL+SHIFT+S.' };
    const line = macKeyLine(base[0], modifiers);
    if (!line) return { ok: false, error: `Unknown or unsupported key "${base[0]}" on macOS.` };
    const r = await osascript(['tell application "System Events"', line, 'end tell']);
    if (!r.ok) return { ok: false, error: `macOS input failed: ${r.error}` };
    return { ok: true, output: `Pressed ${parts.join('+')} on the focused window.` };
  }
  if (!hasTool('xdotool')) return missingTool('xdotool', 'Install it with: sudo apt install xdotool (or your distro equivalent).');
  const names = [];
  for (const raw of parts) {
    const key = String(raw || '').trim().toUpperCase();
    if (!key) continue;
    const mapped = linuxKeyName(key);
    if (!mapped) return { ok: false, error: `Unknown or unsupported key "${raw}" on Linux.` };
    names.push(mapped);
  }
  if (!names.length) return { ok: false, error: 'Give keys like "CTRL+S" or "ENTER".' };
  // xdotool joins modifiers with '+' and accepts one final key.
  const r = await run('xdotool', ['key', '--clearmodifiers', names.join('+')]);
  if (!r.ok) return { ok: false, error: `Linux input failed: ${r.error}` };
  return { ok: true, output: `Pressed ${parts.join('+')} on the focused window.` };
}

async function typeText(text) {
  const value = String(text ?? '');
  if (!value) return { ok: false, error: 'Nothing to type.' };
  if (isMac()) {
    const lines = value.replace(/\r\n/g, '\n').split('\n');
    const script = ['tell application "System Events"'];
    lines.forEach((line, i) => {
      if (i > 0) script.push('key code 36');
      if (line) script.push(`keystroke ${applescriptString(line)}`);
    });
    script.push('end tell');
    const r = await osascript(script, 60000);
    if (!r.ok) return { ok: false, error: `macOS typing failed: ${r.error}` };
    return { ok: true, output: `Typed ${value.length} char(s) into the focused window. Screenshot to check the result.` };
  }
  if (!hasTool('xdotool')) return missingTool('xdotool', 'Install it with: sudo apt install xdotool (or your distro equivalent).');
  const r = await run('xdotool', ['type', '--clearmodifiers', '--delay', '0', '--', value], 60000);
  if (!r.ok) return { ok: false, error: `Linux typing failed: ${r.error}` };
  return { ok: true, output: `Typed ${value.length} char(s) into the focused window. Screenshot to check the result.` };
}

async function macMouse(cmd) {
  if (!hasTool('cliclick')) {
    return missingTool('cliclick', 'Install it with: brew install cliclick. It is required for mouse control on macOS.');
  }
  const button = buttonName(cmd.button);
  const count = Math.max(1, Math.min(3, Math.round(Number(cmd.count) || 1)));
  if (cmd.action === 'move') {
    const r = await run('cliclick', ['m:' + `${Math.round(cmd.x)},${Math.round(cmd.y)}`]);
    if (!r.ok) return { ok: false, error: `macOS mouse move failed: ${r.error}` };
    return { ok: true, output: `Moved the pointer to ${cmd.x},${cmd.y}.` };
  }
  if (cmd.action === 'click') {
    if (button === 'middle') return { ok: false, error: 'Middle-click is not supported on macOS.' };
    const op = button === 'right' ? 'rc' : count === 2 ? 'dc' : 'c';
    const steps = [];
    for (let i = 0; i < (count === 3 ? 3 : 1); i += 1) steps.push(`${op}:${Math.round(cmd.x)},${Math.round(cmd.y)}`);
    const r = await run('cliclick', steps);
    if (!r.ok) return { ok: false, error: `macOS click failed: ${r.error}` };
    return { ok: true, output: `${button} click x${count} at ${cmd.x},${cmd.y}.` };
  }
  if (cmd.action === 'drag') {
    const script = [
      'm:' + `${Math.round(cmd.x1)},${Math.round(cmd.y1)}`,
      'w:100',
      'dd:' + `${Math.round(cmd.x2)},${Math.round(cmd.y2)}`,
    ];
    const r = await run('cliclick', script);
    if (!r.ok) return { ok: false, error: `macOS drag failed: ${r.error}` };
    return { ok: true, output: `Dragged from ${cmd.x1},${cmd.y1} to ${cmd.x2},${cmd.y2}.` };
  }
  return { ok: false, error: `Mouse action "${cmd.action}" is not supported on macOS.` };
}

async function linuxMouse(cmd) {
  if (!hasTool('xdotool')) return missingTool('xdotool', 'Install it with: sudo apt install xdotool (or your distro equivalent).');
  const at = cmd.x != null && cmd.y != null ? ['mousemove', '--sync', String(Math.round(cmd.x)), String(Math.round(cmd.y))] : [];
  const button = LINUX_MOUSE_BUTTON[buttonName(cmd.button)];
  if (cmd.action === 'move') {
    const r = await run('xdotool', at);
    if (!r.ok) return { ok: false, error: `Linux mouse move failed: ${r.error}` };
    return { ok: true, output: `Moved the pointer to ${cmd.x},${cmd.y}.` };
  }
  if (cmd.action === 'click') {
    const count = Math.max(1, Math.min(3, Math.round(Number(cmd.count) || 1)));
    const args = [...at, 'click', '--repeat', String(count), String(button)];
    const r = await run('xdotool', args);
    if (!r.ok) return { ok: false, error: `Linux click failed: ${r.error}` };
    return { ok: true, output: `${cmd.button || 'left'} click x${count} at ${cmd.x},${cmd.y}.` };
  }
  if (cmd.action === 'down' || cmd.action === 'up') {
    const verb = cmd.action === 'down' ? 'mousedown' : 'mouseup';
    const r = await run('xdotool', [...at, verb, String(button)]);
    if (!r.ok) return { ok: false, error: `Linux ${verb} failed: ${r.error}` };
    return { ok: true, output: `Mouse button ${cmd.button || 'left'} ${cmd.action === 'down' ? 'held' : 'released'}.` };
  }
  if (cmd.action === 'drag') {
    const steps = [
      ['mousemove', '--sync', String(Math.round(cmd.x1)), String(Math.round(cmd.y1))],
      ['mousedown', String(button)],
      ['mousemove', '--sync', String(Math.round(cmd.x2)), String(Math.round(cmd.y2))],
      ['mouseup', String(button)],
    ];
    for (const args of steps) {
      const r = await run('xdotool', args);
      if (!r.ok) return { ok: false, error: `Linux drag failed: ${r.error}` };
    }
    return { ok: true, output: `Dragged from ${cmd.x1},${cmd.y1} to ${cmd.x2},${cmd.y2}.` };
  }
  return { ok: false, error: `Mouse action "${cmd.action}" is not supported on Linux.` };
}

async function input(cmd = {}) {
  if (cmd.action === 'scroll') return scroll(cmd);
  if (cmd.action === 'type') return typeText(cmd.text ?? '');
  if (cmd.action === 'key' && Array.isArray(cmd.keys)) return pressKeys(cmd.keys);
  if (isMac()) return macMouse(cmd);
  if (isLinux()) return linuxMouse(cmd);
  return { ok: false, error: `Desktop input is not available on ${platformName}.` };
}

async function scroll(cmd = {}) {
  if (cmd.action !== 'scroll') return { ok: false, error: 'Unsupported scroll request.' };
  const clicks = Math.round(Number(cmd.delta) / 120) || 0;
  if (!clicks) return { ok: false, error: 'amount must be a non-zero number of wheel clicks.' };
  if (isMac()) return { ok: false, error: 'Wheel scrolling is not supported on macOS yet; use key presses or the app itself.' };
  if (!hasTool('xdotool')) return missingTool('xdotool', 'Install it with: sudo apt install xdotool (or your distro equivalent).');
  const button = clicks > 0 ? '4' : '5';
  const at = cmd.x != null && cmd.y != null ? ['mousemove', '--sync', String(Math.round(cmd.x)), String(Math.round(cmd.y))] : [];
  const r = await run('xdotool', [...at, 'click', '--repeat', String(Math.abs(clicks)), button]);
  if (!r.ok) return { ok: false, error: `Linux scroll failed: ${r.error}` };
  return { ok: true, output: `Scrolled ${clicks > 0 ? 'up' : 'down'} ${Math.abs(clicks)} click(s).` };
}

/* -------------------------------- windows --------------------------------- */

const MAC_WINDOWS_SCRIPT = `
(function () {
  var se = Application('System Events');
  var procs = se.applicationProcesses.whose({ visible: true })();
  var out = [];
  for (var pi = 0; pi < procs.length; pi++) {
    var p = procs[pi];
    var name = '';
    var pid = 0;
    var front = false;
    try { name = p.name(); } catch (e) {}
    try { pid = p.unixId(); } catch (e) {}
    try { front = p.frontmost(); } catch (e) {}
    var wins = [];
    try { wins = p.windows(); } catch (e) { wins = []; }
    for (var wi = 0; wi < wins.length; wi++) {
      var w = wins[wi];
      var title = '';
      var pos = null;
      var size = null;
      var minimized = false;
      try { title = w.name() || ''; } catch (e) {}
      try { pos = w.position(); } catch (e) {}
      try { size = w.size(); } catch (e) {}
      try { minimized = w.attributes.byName('AXMinimized').value(); } catch (e) {}
      if (!title && !pos) continue;
      out.push({
        title: String(title),
        x: pos ? Math.round(pos[0]) : 0,
        y: pos ? Math.round(pos[1]) : 0,
        w: size ? Math.round(size[0]) : 0,
        h: size ? Math.round(size[1]) : 0,
        pid: pid,
        cls: String(name),
        foreground: !!(front && wi === 0),
        state: minimized ? 'minimized' : 'normal',
        idx: wi
      });
    }
  }
  return JSON.stringify(out);
})()
`;

function decodeMacHandle(handle) {
  const n = Math.round(Number(handle));
  if (!Number.isFinite(n) || n < 0) return null;
  return { pid: Math.floor(n / 1000), idx: n % 1000 };
}

async function macWindows() {
  const r = await jxa(MAC_WINDOWS_SCRIPT, 25000);
  if (!r.ok) return { ok: false, error: `Could not list macOS windows: ${r.error}` };
  let rows;
  try {
    rows = JSON.parse(r.stdout.trim() || '[]');
  } catch (err) {
    return { ok: false, error: `Could not read the macOS window list: ${err && err.message ? err.message : String(err)}` };
  }
  return {
    ok: true,
    data: rows.map((row) => ({
      title: row.title || '',
      hwnd: Number(row.pid) * 1000 + Number(row.idx || 0),
      pid: Number(row.pid) || 0,
      x: Number(row.x) || 0,
      y: Number(row.y) || 0,
      w: Number(row.w) || 0,
      h: Number(row.h) || 0,
      state: row.state || 'normal',
      cls: row.cls || '',
      foreground: !!row.foreground,
    })),
  };
}

function parseWmctrl(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/i.exec(line);
    if (!m) continue;
    rows.push({
      handle: m[1].toLowerCase(),
      desktop: Number(m[2]),
      pid: Number(m[3]),
      x: Number(m[4]),
      y: Number(m[5]),
      w: Number(m[6]),
      h: Number(m[7]),
      host: m[8],
      title: m[9] || '',
    });
  }
  return rows;
}

async function linuxWindows() {
  if (!hasTool('wmctrl')) return missingTool('wmctrl', 'Install it with: sudo apt install wmctrl (or your distro equivalent).');
  const listed = await run('wmctrl', ['-lpG'], 20000);
  if (!listed.ok) return { ok: false, error: `Could not list Linux windows: ${listed.error}` };
  const rows = parseWmctrl(listed.stdout);
  let active = 0;
  if (hasTool('xdotool')) {
    const a = await run('xdotool', ['getactivewindow']);
    if (a.ok) {
      const n = Number(String(a.stdout).trim());
      if (Number.isFinite(n) && n > 0) active = n;
    }
  }
  return {
    ok: true,
    data: rows.map((row) => {
      const hwnd = parseInt(row.handle, 16);
      return {
        title: row.title,
        hwnd: Number.isFinite(hwnd) ? hwnd : 0,
        pid: row.pid,
        x: row.x,
        y: row.y,
        w: row.w,
        h: row.h,
        state: 'normal',
        cls: '',
        foreground: active > 0 && hwnd === active,
      };
    }),
  };
}

async function windows() {
  if (isMac()) return macWindows();
  if (isLinux()) return linuxWindows();
  return { ok: false, error: `Window listing is not available on ${platformName}.` };
}

const MAC_WINDOW_ACTION_SCRIPT = `
(function () {
  var op = OP_NAME;
  var pid = PID_VALUE;
  var idx = IDX_VALUE;
  var se = Application('System Events');
  var procs = se.applicationProcesses.whose({ unixId: pid })();
  if (!procs.length) return JSON.stringify({ error: 'That process is no longer running.' });
  var p = procs[0];
  if (op === 'focus') {
    p.frontmost = true;
    return JSON.stringify({ result: 'focused' });
  }
  var wins = [];
  try { wins = p.windows(); } catch (e) { wins = []; }
  var w = wins[idx];
  if (!w) return JSON.stringify({ error: 'That window is no longer open.' });
  if (op === 'minimize') {
    w.attributes.byName('AXMinimized').value = true;
    return JSON.stringify({ result: 'minimized' });
  }
  if (op === 'close') {
    w.attributes.byName('AXCloseButton').actions.byName('AXPress').perform();
    return JSON.stringify({ result: 'closed' });
  }
  if (op === 'maximize') {
    w.attributes.byName('AXZoomButton').actions.byName('AXPress').perform();
    return JSON.stringify({ result: 'zoomed' });
  }
  if (op === 'restore') {
    var full = false;
    try { full = w.attributes.byName('AXFullScreen').value(); } catch (e) {}
    if (full) w.attributes.byName('AXFullScreen').value = false;
    else w.attributes.byName('AXZoomButton').actions.byName('AXPress').perform();
    return JSON.stringify({ result: 'restored' });
  }
  return JSON.stringify({ error: 'Unsupported window action.' });
})()
`;

async function windowAction(cmd = {}) {
  const op = String(cmd.op || cmd.action || '').toLowerCase();
  const handle = cmd.handle;
  if (isMac()) {
    const decoded = decodeMacHandle(handle);
    if (!decoded) return { ok: false, error: 'Give a window handle from window_list.' };
    const script = MAC_WINDOW_ACTION_SCRIPT.replace('OP_NAME', JSON.stringify(op))
      .replace('PID_VALUE', String(decoded.pid))
      .replace('IDX_VALUE', String(decoded.idx));
    const r = await jxa(script, 20000);
    if (!r.ok) return { ok: false, error: `macOS window action failed: ${r.error}` };
    let data;
    try {
      data = JSON.parse(r.stdout.trim() || '{}');
    } catch {
      data = {};
    }
    if (data.error) return { ok: false, error: data.error };
    return { ok: true, data };
  }
  if (isLinux()) {
    if (!hasTool('wmctrl')) return missingTool('wmctrl', 'Install it with: sudo apt install wmctrl (or your distro equivalent).');
    const hex = `0x${Math.round(Number(handle)).toString(16)}`;
    let args;
    if (op === 'focus') args = ['-ia', hex];
    else if (op === 'close') args = ['-ic', hex];
    else if (op === 'minimize' && hasTool('xdotool')) return run('xdotool', ['windowminimize', String(Math.round(Number(handle)))]).then((r) => (r.ok ? { ok: true, data: { result: 'minimized' } } : { ok: false, error: r.error }));
    else if (op === 'maximize') args = ['-ir', hex, '-b', 'add,maximized_vert,maximized_horz'];
    else if (op === 'restore') args = ['-ir', hex, '-b', 'remove,maximized_vert,maximized_horz'];
    else if (op === 'minimize') return { ok: false, error: 'Minimize on Linux needs xdotool: sudo apt install xdotool.' };
    else return { ok: false, error: `Unsupported window action "${op}".` };
    const r = await run('wmctrl', args);
    if (!r.ok) return { ok: false, error: `Linux window action failed: ${r.error}` };
    return { ok: true, data: { result: op } };
  }
  return { ok: false, error: `Window actions are not available on ${platformName}.` };
}

/* ------------------------------- processes -------------------------------- */

async function processes() {
  const listed = await run('ps', ['-axo', 'pid=,rss=,comm='], 20000);
  if (!listed.ok) return { ok: false, error: `Could not list processes: ${listed.error || 'ps failed'}` };
  const rows = [];
  for (const line of String(listed.stdout).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const full = m[3].trim();
    rows.push({ pid: Number(m[1]), memMB: Math.round((Number(m[2]) / 1024) * 10) / 10, name: path.basename(full), title: '', cpu: 0 });
  }
  const own = new Set([process.pid, process.ppid]);
  return { ok: true, data: rows.filter((row) => !own.has(row.pid)) };
}

async function killProcess(pid) {
  const n = Math.round(Number(pid));
  if (!Number.isFinite(n) || n <= 1) return { ok: false, error: 'Refusing to stop that process.' };
  if (n === process.pid) return { ok: false, error: 'Refusing to stop the ORVEX process itself.' };
  try {
    process.kill(n, 'SIGTERM');
    return { ok: true, data: { name: `pid ${n}` } };
  } catch (err) {
    return { ok: false, error: `Could not stop pid ${n}: ${err && err.message ? err.message : String(err)}` };
  }
}

/* ----------------------------------- OCR ---------------------------------- */

function parseTsv(text) {
  const lines = new Map();
  let width = 0;
  let height = 0;
  for (const row of String(text || '').split(/\r?\n/)) {
    if (!row.trim()) continue;
    const f = row.split('\t');
    if (f.length < 12 || f[0] !== '5') continue;
    const conf = Number(f[10]);
    if (!Number.isFinite(conf) || conf < 0) continue;
    const word = f[11];
    if (!word || !word.trim()) continue;
    const key = `${f[1]}-${f[2]}-${f[3]}-${f[4]}`;
    const left = Number(f[6]) || 0;
    const top = Number(f[7]) || 0;
    const w = Number(f[8]) || 0;
    const h = Number(f[9]) || 0;
    const current = lines.get(key) || { text: '', x: left, y: top, right: left + w, bottom: top + h };
    current.text = current.text ? `${current.text} ${word}` : word;
    current.x = Math.min(current.x, left);
    current.y = Math.min(current.y, top);
    current.right = Math.max(current.right, left + w);
    current.bottom = Math.max(current.bottom, top + h);
    lines.set(key, current);
    width = Math.max(width, current.right);
    height = Math.max(height, current.bottom);
  }
  const out = [...lines.values()]
    .map((line) => ({ x: line.x, y: line.y, w: line.right - line.x, h: line.bottom - line.y, text: line.text }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return { lines: out, width, height, text: out.map((line) => line.text).join('\n') };
}

async function ocr(file, lang = '') {
  if (!hasTool('tesseract')) {
    return { ok: false, error: 'OCR on macOS and Linux needs tesseract. Install it (brew install tesseract / sudo apt install tesseract-ocr) and retry.' };
  }
  const args = [file, 'stdout'];
  if (lang) args.push('-l', String(lang));
  args.push('tsv');
  const r = await run('tesseract', args, 120000);
  if (!r.ok) return { ok: false, error: `OCR failed: ${r.error}` };
  const parsed = parseTsv(r.stdout);
  return { ok: true, data: { ...parsed, lang: lang || 'default' } };
}

/* --------------------------------- volume --------------------------------- */

async function macVolume(level, mute) {
  if (level != null) {
    const r = await osascript(`set volume output volume ${level}`);
    if (!r.ok) return { ok: false, error: `macOS volume change failed: ${r.error}` };
  }
  if (mute != null) {
    const r = await osascript(`set volume output muted ${mute ? 'true' : 'false'}`);
    if (!r.ok) return { ok: false, error: `macOS mute change failed: ${r.error}` };
  }
  const read = await osascript(['set v to get volume settings', 'return (output volume of v) & "|" & (output muted of v)']);
  if (!read.ok) return { ok: false, error: `macOS volume read failed: ${read.error}` };
  const [vol, muted] = String(read.stdout).trim().split('|');
  return { ok: true, data: { supported: true, level: Number(vol), mute: String(muted).trim() === 'true' } };
}

async function linuxVolume(level, mute) {
  if (hasTool('pactl')) {
    if (level != null) await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${level}%`]);
    if (mute != null) await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', mute ? '1' : '0']);
    const vol = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
    const M = vol.ok ? /(\d+)%/.exec(vol.stdout) : null;
    const mut = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
    if (M) {
      return {
        ok: true,
        data: { supported: true, level: Number(M[1]), mute: /yes/i.test(mut.ok ? mut.stdout : '') },
      };
    }
  }
  if (hasTool('amixer')) {
    if (level != null) await run('amixer', ['-q', 'sset', 'Master', `${level}%`]);
    if (mute != null) await run('amixer', ['-q', 'sset', 'Master', mute ? 'mute' : 'unmute']);
    const get = await run('amixer', ['get', 'Master']);
    const M = get.ok ? /\[(\d+)%\]/.exec(get.stdout) : null;
    if (M) {
      return { ok: true, data: { supported: true, level: Number(M[1]), mute: /\[off\]/i.test(get.stdout) } };
    }
  }
  return { ok: true, data: { supported: false, reason: 'pactl/amixer were not found' } };
}

async function volume(cmd = {}) {
  const level = cmd.level != null ? Math.round(Number(cmd.level)) : null;
  const mute = cmd.mute != null ? !!cmd.mute : null;
  if (isMac()) return macVolume(level, mute);
  if (isLinux()) return linuxVolume(level, mute);
  return { ok: false, error: `Volume control is not available on ${platformName}.` };
}

/* -------------------------------- brightness ------------------------------ */

async function macBrightness(level) {
  if (!hasTool('brightness')) {
    return { ok: true, data: { supported: false, reason: 'the brightness CLI is not installed (brew install brightness)' } };
  }
  if (level != null) await run('brightness', [String((level / 100).toFixed(2))]);
  const r = await run('brightness', ['-l']);
  if (!r.ok) return { ok: true, data: { supported: false, reason: r.error } };
  const hits = [...String(r.stdout).matchAll(/([\d.]+)\s*$/gm)].map((m) => Number(m[1]));
  const value = hits.length ? hits[hits.length - 1] : null;
  if (value == null) return { ok: true, data: { supported: false, reason: 'brightness did not report a level' } };
  return { ok: true, data: { supported: true, level: Math.round(value * 100) } };
}

async function linuxBrightness(level) {
  if (!hasTool('brightnessctl')) {
    return { ok: true, data: { supported: false, reason: 'brightnessctl is not installed (sudo apt install brightnessctl)' } };
  }
  if (level != null) await run('brightnessctl', ['set', `${level}%`]);
  const r = await run('brightnessctl', ['-m']);
  if (!r.ok) return { ok: true, data: { supported: false, reason: r.error } };
  const parts = String(r.stdout).trim().split(',');
  const percent = Number(String(parts[3] || '').replace('%', ''));
  if (!Number.isFinite(percent)) return { ok: true, data: { supported: false, reason: 'brightnessctl did not report a percentage' } };
  return { ok: true, data: { supported: true, level: Math.round(percent) } };
}

async function brightness(cmd = {}) {
  const level = cmd.level != null ? Math.round(Number(cmd.level)) : null;
  if (isMac()) return macBrightness(level);
  if (isLinux()) return linuxBrightness(level);
  return { ok: false, error: `Brightness control is not available on ${platformName}.` };
}

/* ---------------------------------- apps ---------------------------------- */

function scanMacApps() {
  const dirs = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
  const apps = [];
  const seen = new Set();
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      const name = entry.name.slice(0, -4);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      apps.push({ name, appId: path.join(dir, entry.name) });
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

function scanLinuxApps() {
  const dirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(os.homedir(), '.local/share/applications'),
  ];
  const apps = [];
  const seen = new Set();
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop'));
    } catch {
      continue;
    }
    for (const file of entries) {
      const full = path.join(dir, file);
      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (/^Hidden=true$/m.test(text) || /^NoDisplay=true$/m.test(text)) continue;
      const name = (/^Name=(.+)$/m.exec(text) || [])[1];
      if (!name || !name.trim()) continue;
      if (seen.has(name.trim().toLowerCase())) continue;
      seen.add(name.trim().toLowerCase());
      apps.push({ name: name.trim(), appId: full });
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

async function apps(force = false) {
  if (force || !appCache.apps || Date.now() - appCache.at > 5 * 60 * 1000) {
    appCache = { at: Date.now(), apps: isMac() ? scanMacApps() : isLinux() ? scanLinuxApps() : [] };
  }
  return { ok: true, apps: appCache.apps };
}

async function appLaunch(args = {}) {
  const target = String(args.path || args.appId || '').trim();
  if (isMac()) {
    const name = String(args.name || args.app || '').trim();
    let bundle = target;
    if (!bundle && name) {
      const found = (await apps()).apps.find((a) => a.name.toLowerCase() === name.toLowerCase());
      bundle = found ? found.appId : '';
      if (!bundle) return { ok: false, error: `No app named "${name}" was found in /Applications.` };
    }
    if (!bundle) return { ok: false, error: 'Give an app name or bundle path.' };
    const r = await run('open', ['-a', bundle], 30000);
    if (!r.ok) return { ok: false, error: `Could not open ${bundle}: ${r.error}` };
    return { ok: true, output: `Opened ${path.basename(bundle).replace(/\.app$/, '')}.` };
  }
  if (isLinux()) {
    const name = String(args.name || args.app || '').trim();
    let desktop = target;
    if (!desktop && name) {
      const found = (await apps()).apps.find((a) => a.name.toLowerCase() === name.toLowerCase());
      desktop = found ? found.appId : '';
    }
    if (!desktop) return { ok: false, error: 'Give an app name or a .desktop path.' };
    if (hasTool('gtk-launch')) {
      const r = await run('gtk-launch', [path.basename(desktop)], 30000);
      if (r.ok) return { ok: true, output: `Launched ${path.basename(desktop)}.` };
    }
    const r = await run('xdg-open', [desktop], 30000);
    if (!r.ok) return { ok: false, error: `Could not launch ${desktop}: ${r.error}` };
    return { ok: true, output: `Launched ${path.basename(desktop)}.` };
  }
  return { ok: false, error: `App launching is not available on ${platformName}.` };
}

/* ------------------------------ JSON requests ----------------------------- */

async function inputJson(cmd = {}, timeout) {
  const action = String(cmd.action || '').toLowerCase();
  if (action === 'windows') return windows();
  if (action === 'win') return windowAction({ handle: cmd.handle, op: cmd.op });
  if (action === 'procs') {
    const all = await processes();
    if (!all.ok) return all;
    return { ok: true, data: all.data };
  }
  if (action === 'kill') return killProcess(cmd.pid);
  if (action === 'volume') return volume(cmd);
  if (action === 'brightness') return brightness(cmd);
  return { ok: false, error: `The ${action || 'empty'} request is not supported on ${platformName}.` };
}

function capabilities() {
  const needs = isMac()
    ? ['osascript', 'cliclick', 'tesseract']
    : isLinux()
      ? ['xdotool', 'wmctrl', 'tesseract']
      : [];
  return {
    platform: platformName,
    input: isMac() ? hasTool('osascript') : isLinux() ? hasTool('xdotool') : false,
    mouse: isMac() ? hasTool('cliclick') : isLinux() ? hasTool('xdotool') : false,
    windows: isMac() ? hasTool('osascript') : isLinux() ? hasTool('wmctrl') : false,
    ocr: hasTool('tesseract'),
    missing: needs.filter((tool) => !hasTool(tool)),
  };
}

module.exports = {
  input,
  inputJson,
  pressKeys,
  typeText,
  scroll,
  windows,
  windowAction,
  processes,
  killProcess,
  ocr,
  volume,
  brightness,
  apps,
  appLaunch,
  capabilities,
  parseTsv,
  parseWmctrl,
  _internals: {
    applescriptString,
    splitCombo,
    macKeyLine,
    linuxKeyName,
    decodeMacHandle,
  },
  _setExec,
  _setPlatform,
  _setTools,
};
