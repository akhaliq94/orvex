'use strict';

/**
 * Real browser control for the engine, using the Chrome/Edge already installed
 * on the machine (playwright-core, no bundled browser download). A dedicated
 * profile keeps logins between runs without touching the user's main profile.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

let context = null;
let launching = null;
let page = null;
let dataDir = null;

function init(opts) {
  dataDir = opts && opts.dataDir ? opts.dataDir : null;
}

function baseDir() {
  if (dataDir) return dataDir;
  try {
    return require('electron').app.getPath('userData');
  } catch {
    return process.cwd();
  }
}

/** Chrome first, then Edge/Brave — whichever this machine actually has. */
function findExecutable() {
  const env = process.env;
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.ProgramW6432].filter(Boolean);
  const rels = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  for (const rel of rels) {
    for (const root of roots) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function checkHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return 'That is not a valid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'The browser tool only accepts http(s) URLs.';
  }
  return null;
}

/** Search endpoints a one-call browser_task can target. */
const SEARCH_SITES = {
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
};

const SITE_ALIASES = {
  yt: 'youtube',
  'youtube.com': 'youtube',
  'www.youtube.com': 'youtube',
  'google.com': 'google',
  'www.google.com': 'google',
  'bing.com': 'bing',
  'www.bing.com': 'bing',
  ddg: 'duckduckgo',
  'duckduckgo.com': 'duckduckgo',
  'github.com': 'github',
  'www.github.com': 'github',
};

/** Build the URL for "open <site> and search <query>" without any model round trip. */
function searchUrlFor(site, query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Provide the search query.');
  const raw = String(site || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    if (raw.includes('{query}')) return raw.replace(/\{query\}/g, encodeURIComponent(q));
    return `${raw}${raw.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`;
  }
  const key = SITE_ALIASES[raw.toLowerCase()] || raw.toLowerCase();
  const build = SEARCH_SITES[key] || SEARCH_SITES.google;
  return build(q);
}

function isYouTube(url) {
  try {
    return /(^|\.)youtube\.com$/i.test(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

/** Click the first video in a YouTube result list and start playback. */
async function playFirstResult(p) {
  const selectors = ['ytd-video-renderer a#video-title', 'ytd-rich-item-renderer a#video-title', 'a#video-title', 'a.yt-simple-endpoint[href*="/watch"]'];
  let clicked = false;
  for (const selector of selectors) {
    const locator = p.locator(selector).first();
    if (await locator.count()) {
      await locator.click({ timeout: 8000 });
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error('No video result was found on that page.');

  await p.waitForURL(/\/watch/, { timeout: 15000 }).catch(() => {});
  await p.waitForSelector('video', { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(800);

  const playback = await p
    .evaluate(async () => {
      const video = document.querySelector('video');
      if (!video) return { found: false };
      try {
        if (video.paused) await video.play();
      } catch {
        return { found: true, paused: video.paused, blocked: true };
      }
      return { found: true, paused: video.paused, muted: video.muted, seconds: Math.round(video.currentTime || 0) };
    })
    .catch(() => ({ found: false }));

  return { title: (await p.title().catch(() => '')), url: p.url(), playback };
}

function friendly(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/Executable doesn't exist|Failed to launch/i.test(msg)) {
    return `Could not start Chrome/Edge (${msg.split('\n')[0]}). Close any ORVEX browser window and try again.`;
  }
  if (/Timeout/i.test(msg)) return `Timed out: ${msg.split('\n')[0]}`;
  return msg.split('\n')[0];
}

async function ensureContext() {
  if (context) return context;
  if (launching) return launching;
  launching = (async () => {
    let chromium;
    try {
      ({ chromium } = require('playwright-core'));
    } catch {
      throw new Error('playwright-core is missing — run npm install in the ORVEX folder.');
    }
    const executablePath = findExecutable();
    if (!executablePath) throw new Error('No Chrome, Edge or Brave installation was found on this PC.');
    const profile = path.join(baseDir(), 'browser-profile');
    await fsp.mkdir(profile, { recursive: true });
    context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: false,
      viewport: null,
      args: ['--start-maximized', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
    });
    page = context.pages()[0] || (await context.newPage());
    context.on('close', () => {
      context = null;
      launching = null;
      page = null;
    });
    return context;
  })();
  try {
    return await launching;
  } catch (err) {
    launching = null;
    throw err;
  }
}

async function currentPage() {
  const ctx = await ensureContext();
  if (page && !page.isClosed()) return page;
  page = ctx.pages().filter((p) => !p.isClosed()).pop() || (await ctx.newPage());
  return page;
}

/**
 * Gives every visible interactive element a stable [data-orvex-id] and returns a
 * compact list. The model clicks by that id, so stale/ambiguous text is avoidable.
 */
async function snapshot(p) {
  return p.evaluate(() => {
    const selector =
      'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
    document.querySelectorAll('[data-orvex-id]').forEach((el) => el.removeAttribute('data-orvex-id'));
    const lines = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
      const id = String(lines.length + 1);
      el.setAttribute('data-orvex-id', id);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? el.type || 'input' : tag);
      const raw =
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.innerText ||
        el.value ||
        el.getAttribute('name') ||
        el.getAttribute('title') ||
        '';
      const label = String(raw).replace(/\s+/g, ' ').trim().slice(0, 70);
      const href = tag === 'a' && el.href ? ` → ${String(el.href).slice(0, 120)}` : '';
      lines.push(`[${id}] ${role}${label ? ` "${label}"` : ''}${href}`);
      if (lines.length >= 80) break;
    }
    const head = `Page: ${document.title || '(untitled)'} — ${location.href}`;
    return `${head}\n${lines.length ? lines.join('\n') : '(no interactive elements found — use browser_text)'}`;
  });
}

function clip(text, max = 6000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

async function locate(p, args) {
  const id = args.id !== undefined && args.id !== null ? String(args.id).trim() : '';
  const text = String(args.text || '').trim();
  if (id && /^\d+$/.test(id)) return { locator: p.locator(`[data-orvex-id="${id}"]`), label: `[${id}]` };
  if (!text) throw new Error('Provide the element id from the last snapshot, or its visible text.');
  const interactive = p.locator('a, button, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"]').filter({ hasText: text });
  if (await interactive.count()) return { locator: interactive.first(), label: `"${text}"` };
  const any = p.getByText(text, { exact: false });
  if (await any.count()) return { locator: any.first(), label: `"${text}"` };
  throw new Error(`Nothing on the page matches ${id ? `[${id}]` : `"${text}"`}. Take a fresh snapshot.`);
}

async function report(p, prefix) {
  try {
    return `${prefix}\n${await snapshot(p)}`;
  } catch {
    return prefix;
  }
}

const definitions = [
  {
    name: 'browser_open',
    description:
      'Open a URL in a real Chrome/Edge window driven by ORVEX and return the page with numbered interactive elements. Use this for any web task: searching, YouTube, forms, reading sites. Always work from the numbers the snapshot gives you.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http(s) URL' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Re-read the current tab: title, URL and numbered clickable/typeable elements. Call it after any action that changes the page.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_task',
    description:
      'One-call shortcut for common web goals such as "open YouTube and search X and play". Prefer this over app_launch + window_list + browser_open + click: it launches the real browser itself and completes search / first-video playback in a single step. Actions: open (just a URL), search (site + query), play_first (site + query, then click the first video and start playback).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'search', 'play_first'], description: 'What to do.' },
        site: { type: 'string', description: 'youtube, google, bing, duckduckgo, github, or a full http(s) URL. Defaults to youtube for play_first and google for search.' },
        query: { type: 'string', description: 'Search text, e.g. "jhol mashup".' },
        url: { type: 'string', description: 'Full URL for action=open.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an element in the current tab. Prefer the numeric id from the latest snapshot; visible text works as a fallback. Returns the updated page snapshot.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Element number from the last snapshot, e.g. "12"' },
        text: { type: 'string', description: 'Visible text of the element when no id is known' },
      },
      required: [],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type into an input, textarea or search box (replaces its current content). Set submit=true to press Enter afterwards.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Element number from the last snapshot' },
        text: { type: 'string', description: 'Visible label/placeholder of the field when no id is known' },
        value: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['value'],
    },
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key in the page, e.g. Enter, Escape, PageDown, Control+L.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Playwright key name' } },
      required: ['key'],
    },
  },
  {
    name: 'browser_text',
    description: 'Read the visible text of the current page (max 6000 chars). Use for articles, search results and page content.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the current page up or down. Useful for lazy-loaded lists such as YouTube results.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', description: 'Pixels, default 700' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Save a PNG screenshot of the current tab. The image is attached to your next message, so you can actually see the page. Use it for visual checks or when the DOM is unreadable.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_back',
    description: 'Go back one page in the browser history and return the snapshot.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_close',
    description: 'Close the ORVEX-controlled browser window. The profile and logins stay on disk.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const handlers = {
  async browser_open(args) {
    const url = String(args.url || '').trim();
    const bad = checkHttpUrl(url);
    if (bad) return { ok: false, error: bad };
    try {
      const p = await currentPage();
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(500);
      return { ok: true, output: await snapshot(p) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_snapshot() {
    try {
      return { ok: true, output: await snapshot(await currentPage()) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_task(args) {
    const action = String(args.action || '').trim();
    if (!['open', 'search', 'play_first'].includes(action)) {
      return { ok: false, error: 'action must be open, search or play_first.' };
    }
    try {
      if (action === 'open') {
        const url = String(args.url || args.site || '').trim();
        const bad = checkHttpUrl(url);
        if (bad) return { ok: false, error: bad };
        const p = await currentPage();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await p.waitForTimeout(500);
        return { ok: true, output: await snapshot(p) };
      }

      const query = String(args.query || '').trim();
      const site = String(args.site || '').trim() || (action === 'play_first' ? 'youtube' : 'google');
      const url = searchUrlFor(site, query);
      const bad = checkHttpUrl(url);
      if (bad) return { ok: false, error: bad };

      const p = await currentPage();
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      if (action === 'search') {
        await p.waitForTimeout(600);
        return { ok: true, output: `Searched ${site} for "${query}".\n${await snapshot(p)}` };
      }

      await p.waitForSelector('a#video-title', { timeout: 12000 }).catch(() => {});
      const played = await playFirstResult(p);
      if (!played.playback.found) {
        return { ok: true, output: `Opened the first result: ${played.title}\n${played.url}\nNo <video> element appeared yet — the page may still be loading.` };
      }
      const state = played.playback.blocked
        ? 'the browser blocked autoplay — click play in the window once'
        : played.playback.paused
          ? 'the video is loaded but paused'
          : 'playing';
      return {
        ok: true,
        output: `Searched ${site} for "${query}", clicked the first result and ${state}.\n${played.title}\n${played.url}${played.playback.muted ? '\n(muted)' : ''}`,
      };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_click(args) {
    try {
      const p = await currentPage();
      const { locator, label } = await locate(p, args);
      await locator.click({ timeout: 8000 });
      await p.waitForTimeout(600);
      return { ok: true, output: await report(p, `Clicked ${label}.`) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_type(args) {
    const value = String(args.value ?? '');
    if (!value) return { ok: false, error: 'value is empty.' };
    if (value.length > 4000) return { ok: false, error: 'Keep typed text under 4000 characters.' };
    try {
      const p = await currentPage();
      const { locator, label } = await locate(p, args);
      await locator.fill(value, { timeout: 8000 });
      if (args.submit) {
        await p.keyboard.press('Enter');
        await p.waitForTimeout(900);
      }
      return { ok: true, output: await report(p, `Typed ${value.length} chars into ${label}${args.submit ? ' and pressed Enter' : ''}.`) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_press(args) {
    const key = String(args.key || '').trim();
    if (!key || key.length > 40) return { ok: false, error: 'Provide a key name like Enter or PageDown.' };
    try {
      const p = await currentPage();
      await p.keyboard.press(key);
      await p.waitForTimeout(500);
      return { ok: true, output: await report(p, `Pressed ${key}.`) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_text() {
    try {
      const p = await currentPage();
      const text = await p.evaluate(() => (document.body ? document.body.innerText : ''));
      const head = await p.evaluate(() => `${document.title || '(untitled)'} — ${location.href}`);
      return { ok: true, output: `${head}\n${clip(text)}` };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_scroll(args) {
    const amount = Math.min(Math.max(Number(args.amount) || 700, 100), 5000);
    try {
      const p = await currentPage();
      await p.mouse.wheel(0, args.direction === 'up' ? -amount : amount);
      await p.waitForTimeout(500);
      const pos = await p.evaluate(() => `${Math.round(scrollY)} / ${Math.max(0, document.body.scrollHeight - innerHeight)}`);
      return { ok: true, output: `Scrolled ${args.direction === 'up' ? 'up' : 'down'} ${amount}px (${pos}).\n${await snapshot(p)}` };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_screenshot() {
    try {
      const p = await currentPage();
      const dir = path.join(baseDir(), 'screenshots');
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `browser-${Date.now()}.png`);
      await p.screenshot({ path: file, fullPage: false });
      return { ok: true, output: `Screenshot saved: ${file}`, image: file };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_back() {
    try {
      const p = await currentPage();
      await p.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await p.waitForTimeout(500);
      return { ok: true, output: await report(p, 'Went back.') };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },

  async browser_close() {
    try {
      if (context) await context.close();
      context = null;
      launching = null;
      page = null;
      return { ok: true, output: 'Browser closed.' };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  },
};

async function close() {
  try {
    if (context) await context.close();
  } catch {
    /* already gone */
  }
  context = null;
  launching = null;
  page = null;
}

module.exports = { definitions, handlers, init, close, searchUrlFor };
