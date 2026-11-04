'use strict';

/**
 * Phase 10 — Maker Suite: real project scaffolds, a live preview server and zip
 * export. Every file written here is ordinary, readable source. Nothing claims
 * to build a framework that is not installed; a React project previews only
 * after its own build output exists.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const archiver = require('archiver');

const MAX_PROJECTS = 120;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_WRITE_CHARS = 2 * 1024 * 1024;
const RUN_TIMEOUT_MS = 20000;
const RUN_OUTPUT_BYTES = 16 * 1024;

let ctx = { dataDir: null, emit: () => {} };
let store = { projects: [] };
let registryFile = null;
let previews = new Map();

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.woff', '.woff2', '.ttf']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function rootDir() {
  return path.join(ctx.dataDir || process.cwd(), 'maker');
}
function projectsDir() {
  return path.join(rootDir(), 'projects');
}
function now() {
  return Date.now();
}

function emit(event) {
  try {
    ctx.emit(event);
  } catch {
    /* the window may be gone */
  }
}

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  registryFile = path.join(rootDir(), 'maker.json');
  fs.mkdirSync(projectsDir(), { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    store = { projects: Array.isArray(raw.projects) ? raw.projects.filter((p) => p && p.id && p.dir) : [] };
  } catch {
    store = { projects: [] };
  }
  return { root: rootDir() };
}

async function persist() {
  const tmp = `${registryFile}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fsp.rename(tmp, registryFile);
}

function slugify(value) {
  const base = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (base || `project-${Date.now().toString(36)}`).slice(0, 48);
}

function uniqueSlug(desired) {
  const used = new Set(store.projects.map((p) => p.slug));
  if (!used.has(desired)) return desired;
  let n = 2;
  while (used.has(`${desired}-${n}`)) n += 1;
  return `${desired}-${n}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hashSeed(seed) {
  let h = 2166136261;
  const text = String(seed || 'orvex');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(Math.max(s, 0), 100) / 100;
  const light = Math.min(Math.max(l, 0), 100) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function makePalette(seed) {
  const h = hashSeed(seed) % 360;
  const alt = (h + 138) % 360;
  return {
    seed: String(seed || ''),
    brand: hslToHex(h, 62, 48),
    brandSoft: hslToHex(h, 66, 93),
    accent: hslToHex(alt, 70, 54),
    ink: hslToHex(h, 22, 12),
    body: hslToHex(h, 12, 28),
    muted: hslToHex(h, 8, 46),
    paper: hslToHex(h, 34, 98),
    surface: hslToHex(h, 26, 95),
    line: hslToHex(h, 16, 86),
    success: hslToHex(146, 54, 40),
    warning: hslToHex(38, 92, 46),
    danger: hslToHex(354, 68, 50),
  };
}

function tokensCss(palette) {
  return `:root {
  color-scheme: light;
  --brand: ${palette.brand};
  --brand-soft: ${palette.brandSoft};
  --accent: ${palette.accent};
  --ink: ${palette.ink};
  --body: ${palette.body};
  --muted: ${palette.muted};
  --paper: ${palette.paper};
  --surface: ${palette.surface};
  --line: ${palette.line};
  --success: ${palette.success};
  --warning: ${palette.warning};
  --danger: ${palette.danger};
  --radius-sm: 8px;
  --radius: 14px;
  --radius-lg: 26px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 72px;
  --font-sans: "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-mono: ui-monospace, "Cascadia Code", Consolas, monospace;
  --step--1: 0.82rem;
  --step-0: 1rem;
  --step-1: 1.22rem;
  --step-2: 1.55rem;
  --step-3: 2rem;
  --step-4: 2.6rem;
  --step-5: 3.4rem;
  --shadow: 0 18px 48px rgba(15, 23, 42, 0.09);
}
`;
}

function logoSvg(name, palette) {
  const words = String(name || 'Project').trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] || 'O') + (words[1]?.[0] || words[0]?.[1] || 'V')).toUpperCase();
  const h = hashSeed(name);
  const angle = h % 40;
  const dot = 10 + (h % 8);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${escapeHtml(name)} logo">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${angle} 0.5 0.5)">
      <stop offset="0" stop-color="${palette.brand}"/>
      <stop offset="1" stop-color="${palette.accent}"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="18" fill="url(#g)"/>
  <circle cx="${dot + 26}" cy="${58 - dot}" r="${6 + (h % 4)}" fill="#ffffff" fill-opacity="0.28"/>
  <path d="M18 44 L32 18 L46 44 Z" fill="none" stroke="#ffffff" stroke-opacity="0.32" stroke-width="2" stroke-linejoin="round"/>
  <text x="32" y="39" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="18" font-weight="700" fill="#ffffff">${escapeHtml(initials)}</text>
</svg>
`;
}

function siteNav(active) {
  const link = (href, label) => `<a href="${href}"${href === active ? ' class="active" aria-current="page"' : ''}>${label}</a>`;
  return `<header class="site-head">
    <a class="brand" href="index.html"><img src="assets/logo.svg" alt="" width="30" height="30"><span>__NAME__</span></a>
    <button class="nav-toggle" type="button" aria-label="Menu" aria-expanded="false">☰</button>
    <nav class="site-nav" aria-label="Main">
      ${link('index.html', 'Home')}
      ${link('about.html', 'About')}
      ${link('contact.html', 'Contact')}
    </nav>
  </header>`;
}

function siteFooter(year) {
  return `<footer class="site-foot">
    <span>© ${year} __NAME__</span>
    <span>Built with ORVEX Maker · edit the files to make it yours</span>
  </footer>`;
}

function applyName(html, name) {
  return html.replaceAll('__NAME__', escapeHtml(name));
}

function websiteFiles({ name, title, description, palette }) {
  const year = new Date().getFullYear();
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const head = (pageTitle, extra = '') => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <meta name="description" content="${safeDesc}">
  <link rel="icon" href="assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="styles.css">
  ${extra}
</head>`;
  const index = `${head(safeTitle)}
<body>
  ${applyName(siteNav('index.html'), name)}
  <main>
    <section class="hero">
      <span class="eyebrow">${escapeHtml(name)}</span>
      <h1>${safeTitle}</h1>
      <p class="lede">${safeDesc}</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="#start">Get started</a>
        <a class="btn btn-ghost" href="about.html">Learn more</a>
      </div>
    </section>

    <section id="start" class="section">
      <h2>What this site includes</h2>
      <div class="grid three">
        <article class="card">
          <h3>Three real pages</h3>
          <p>Home, About and Contact are plain HTML files with shared styles. Edit them directly in the Maker file editor.</p>
        </article>
        <article class="card">
          <h3>Design tokens</h3>
          <p>Colours, type scale, spacing and radii live in <code>styles.css</code> as CSS custom properties.</p>
        </article>
        <article class="card">
          <h3>No build step</h3>
          <p>The site runs as-is. Open it in the Maker preview, then upload the folder to any static host.</p>
        </article>
      </div>
    </section>

    <section class="section band">
      <h2>Make it yours</h2>
      <p>Replace the headline and description, add your own sections, and point the Contact page at your real address. Nothing here calls a server you do not control.</p>
    </section>
  </main>
  ${applyName(siteFooter(year), name)}
  <script src="app.js"></script>
</body>
</html>
`;

  const about = `${head(`About · ${safeTitle}`)}
<body>
  ${applyName(siteNav('about.html'), name)}
  <main class="section narrow">
    <span class="eyebrow">About</span>
    <h1>About ${escapeHtml(name)}</h1>
    <p class="lede">${safeDesc}</p>
    <h2>How this project was made</h2>
    <p>ORVEX Maker scaffolded this folder from a template. Every file is normal source code: no generated runtime and no hidden dependency. Edit, extend or delete anything.</p>
    <h2>Next steps</h2>
    <ol class="list">
      <li>Rewrite this page with your own story.</li>
      <li>Add images to <code>assets/</code> and reference them from HTML.</li>
      <li>Adjust the palette in <code>styles.css</code>.</li>
    </ol>
  </main>
  ${applyName(siteFooter(year), name)}
  <script src="app.js"></script>
</body>
</html>
`;

  const contact = `${head(`Contact · ${safeTitle}`)}
<body>
  ${applyName(siteNav('contact.html'), name)}
  <main class="section narrow">
    <span class="eyebrow">Contact</span>
    <h1>Talk to ${escapeHtml(name)}</h1>
    <p class="lede">This page is a starting point. Replace the address below with your real contact details.</p>
    <p><a class="btn btn-primary" href="mailto:hello@example.com">hello@example.com</a></p>
    <p class="muted">No form is included because a form needs a backend you choose. Add one when you have an endpoint.</p>
  </main>
  ${applyName(siteFooter(year), name)}
  <script src="app.js"></script>
</body>
</html>
`;

  const notFound = `${head(`Not found · ${safeTitle}`)}
<body>
  ${applyName(siteNav(''), name)}
  <main class="section narrow">
    <h1>404</h1>
    <p class="lede">That page does not exist in this project.</p>
    <p><a class="btn btn-ghost" href="index.html">Back home</a></p>
  </main>
</body>
</html>
`;

  const css = `${tokensCss(palette)}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--body);
  font-family: var(--font-sans);
  font-size: var(--step-0);
  line-height: 1.65;
}
h1, h2, h3 { color: var(--ink); line-height: 1.15; margin: 0 0 var(--space-3); }
h1 { font-size: clamp(2.2rem, 6vw, var(--step-5)); letter-spacing: -0.02em; }
h2 { font-size: clamp(1.5rem, 3vw, var(--step-3)); }
h3 { font-size: var(--step-1); }
p { margin: 0 0 var(--space-4); }
a { color: var(--brand); }
code { font-family: var(--font-mono); font-size: 0.9em; background: var(--surface); padding: 2px 5px; border-radius: 5px; }
.site-head {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: var(--space-2); font-weight: 700; color: var(--ink); text-decoration: none; }
.site-nav { display: flex; gap: var(--space-4); margin-left: auto; }
.site-nav a { color: var(--muted); text-decoration: none; font-size: 0.95rem; padding: 4px 2px; border-bottom: 2px solid transparent; }
.site-nav a:hover, .site-nav a.active { color: var(--ink); border-bottom-color: var(--brand); }
.nav-toggle { display: none; margin-left: auto; background: none; border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 1.1rem; padding: 4px 10px; cursor: pointer; }
.hero {
  max-width: 1040px;
  margin: 0 auto;
  padding: clamp(48px, 10vw, 112px) var(--space-5) var(--space-8);
}
.eyebrow {
  display: inline-block;
  margin-bottom: var(--space-3);
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: var(--step--1);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.lede { font-size: clamp(1.05rem, 2vw, var(--step-1)); color: var(--muted); max-width: 62ch; }
.cta-row { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-5); }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 11px 20px; border-radius: 999px; font-weight: 600; text-decoration: none; border: 1px solid transparent; transition: transform 0.15s ease, box-shadow 0.15s ease; }
.btn:hover { transform: translateY(-1px); }
.btn-primary { background: var(--brand); color: #fff; box-shadow: var(--shadow); }
.btn-ghost { border-color: var(--line); color: var(--ink); background: var(--paper); }
.section { max-width: 1040px; margin: 0 auto; padding: var(--space-7) var(--space-5); }
.section.narrow { max-width: 760px; }
.section.band { background: var(--surface); border-radius: var(--radius-lg); max-width: 1040px; }
.grid { display: grid; gap: var(--space-4); }
.grid.three { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.card { background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-5); box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04); }
.list { padding-left: 1.2rem; }
.list li { margin-bottom: var(--space-2); }
.muted { color: var(--muted); }
.site-foot { display: flex; flex-wrap: wrap; gap: var(--space-3); justify-content: space-between; padding: var(--space-5); border-top: 1px solid var(--line); color: var(--muted); font-size: var(--step--1); }
@media (max-width: 720px) {
  .nav-toggle { display: inline-block; }
  .site-nav { display: none; flex-direction: column; position: absolute; top: 58px; right: 16px; padding: var(--space-3); background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
  .site-head.open .site-nav { display: flex; }
  .site-foot { flex-direction: column; }
}
`;

  const js = `(() => {
  const head = document.querySelector('.site-head');
  const toggle = document.querySelector('.nav-toggle');
  if (head && toggle) {
    toggle.addEventListener('click', () => {
      const open = head.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }
})();
`;

  const readme = `# ${name}

${description}

Generated by ORVEX Maker from the "website" template.

## Preview

Open this folder in ORVEX → Maker and press Preview. The built-in server serves it on 127.0.0.1.

## Publish

The folder is static. Upload it to any static host (Cloudflare Pages, Netlify, GitHub Pages, your own server). There is no build step.

## Files

- \`index.html\` — home page
- \`about.html\` — about page
- \`contact.html\` — contact page (replace the email address)
- \`404.html\` — not found page
- \`styles.css\` — all styles and design tokens
- \`app.js\` — mobile menu behaviour
- \`assets/logo.svg\` — generated logo
`;

  return [
    { path: 'index.html', content: index },
    { path: 'about.html', content: about },
    { path: 'contact.html', content: contact },
    { path: '404.html', content: notFound },
    { path: 'styles.css', content: css },
    { path: 'app.js', content: js },
    { path: 'README.md', content: readme },
    { path: 'assets/logo.svg', content: logoSvg(name, palette) },
  ];
}

function landingFiles({ name, title, description, palette }) {
  const year = new Date().getFullYear();
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}">
  <link rel="icon" href="assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="top">
    <a class="brand" href="#top"><img src="assets/logo.svg" alt="" width="30" height="30"><span>${escapeHtml(name)}</span></a>
    <a class="btn btn-ghost" href="#contact">Contact</a>
  </header>
  <main id="top">
    <section class="hero">
      <span class="pill">${escapeHtml(name)}</span>
      <h1>${safeTitle}</h1>
      <p class="lede">${safeDesc}</p>
      <div class="actions"><a class="btn btn-primary" href="#contact">Get in touch</a><a class="btn btn-ghost" href="#features">See what you get</a></div>
    </section>
    <section id="features" class="features">
      <article><h2>Clear promise</h2><p>Rewrite this section with the single outcome you deliver and who it is for.</p></article>
      <article><h2>Proof</h2><p>Add real testimonials, numbers or screenshots here when you have them.</p></article>
      <article><h2>Simple next step</h2><p>One call to action is usually enough. Keep the contact link and remove the rest.</p></article>
    </section>
    <section id="contact" class="contact">
      <h2>Start a conversation</h2>
      <p>Replace this text and the address with your real contact channel.</p>
      <a class="btn btn-primary" href="mailto:hello@example.com">hello@example.com</a>
    </section>
  </main>
  <footer>© ${year} ${escapeHtml(name)} · built with ORVEX Maker</footer>
</body>
</html>
`;
  const css = `${tokensCss(palette)}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--body); font-family: var(--font-sans); line-height: 1.6; }
h1, h2 { color: var(--ink); line-height: 1.1; margin: 0 0 var(--space-3); }
.top { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4) var(--space-5); max-width: 1080px; margin: 0 auto; }
.brand { display: flex; align-items: center; gap: var(--space-2); color: var(--ink); font-weight: 700; text-decoration: none; }
.hero { max-width: 980px; margin: 0 auto; padding: clamp(56px, 12vw, 140px) var(--space-5) var(--space-8); }
.pill { display: inline-block; padding: 4px 12px; border-radius: 999px; background: var(--brand-soft); color: var(--brand); font-size: var(--step--1); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: var(--space-4); }
h1 { font-size: clamp(2.4rem, 7vw, 4.4rem); letter-spacing: -0.03em; max-width: 18ch; }
.lede { color: var(--muted); font-size: clamp(1.05rem, 2vw, 1.3rem); max-width: 56ch; }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-6); }
.btn { display: inline-flex; padding: 12px 22px; border-radius: 999px; font-weight: 600; text-decoration: none; border: 1px solid transparent; }
.btn-primary { background: var(--brand); color: #fff; box-shadow: var(--shadow); }
.btn-ghost { border-color: var(--line); color: var(--ink); background: var(--paper); }
.features { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-4); max-width: 1080px; margin: 0 auto; padding: var(--space-7) var(--space-5); }
.features article { padding: var(--space-5); border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); }
.features h2 { font-size: var(--step-2); }
.contact { max-width: 760px; margin: 0 auto; padding: var(--space-8) var(--space-5); text-align: center; background: var(--surface); border-radius: var(--radius-lg); margin-bottom: var(--space-7); }
footer { padding: var(--space-5); text-align: center; color: var(--muted); font-size: var(--step--1); border-top: 1px solid var(--line); }
`;
  const readme = `# ${name}

${description}

A one-page landing template from ORVEX Maker. Preview it in Maker, edit \`index.html\` for copy and \`styles.css\` for design tokens.

Replace \`hello@example.com\` with your real contact address before publishing.
`;
  return [
    { path: 'index.html', content: html },
    { path: 'styles.css', content: css },
    { path: 'README.md', content: readme },
    { path: 'assets/logo.svg', content: logoSvg(name, palette) },
  ];
}

function designKitFiles({ name, title, description, palette }) {
  const tokens = tokensCss(palette);
  const specimen = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — design tokens</title>
  <link rel="stylesheet" href="tokens.css">
  <style>
    body { margin: 0; padding: 40px; background: var(--paper); color: var(--body); font-family: var(--font-sans); }
    h1 { color: var(--ink); }
    .swatches { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .swatch { border-radius: var(--radius); overflow: hidden; border: 1px solid var(--line); }
    .swatch i { display: block; height: 64px; }
    .swatch span { display: block; padding: 8px 10px; font-size: 12px; font-family: var(--font-mono); background: var(--paper); }
    .scale p { margin: 0 0 6px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
    .btn { padding: 10px 18px; border-radius: 999px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); }
    .btn.primary { background: var(--brand); color: #fff; border-color: var(--brand); }
    .card { max-width: 360px; padding: 20px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--paper); box-shadow: var(--shadow); }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(description)}</p>
  <h2>Colour</h2>
  <div class="swatches" id="swatches"></div>
  <h2>Type scale</h2>
  <div class="scale">
    <p style="font-size: var(--step-5)">Display ${escapeHtml(name)}</p>
    <p style="font-size: var(--step-3)">Heading level three</p>
    <p style="font-size: var(--step-1)">Lead paragraph</p>
    <p>Body copy at the base step. Line height is 1.65 for comfortable reading.</p>
    <p style="font-size: var(--step--1); color: var(--muted)">Caption and metadata step.</p>
  </div>
  <h2>Components</h2>
  <div class="row"><button class="btn primary">Primary</button><button class="btn">Secondary</button></div>
  <div class="card"><h3>Card surface</h3><p>Radius, border and shadow tokens are shown here together.</p></div>
  <script>
    const tokens = __TOKENS__;
    const host = document.getElementById('swatches');
    for (const t of tokens) {
      const card = document.createElement('div');
      card.className = 'swatch';
      const chip = document.createElement('i');
      chip.style.background = t.hex;
      const label = document.createElement('span');
      label.textContent = t.name + ' · ' + t.hex;
      card.append(chip, label);
      host.appendChild(card);
    }
  </script>
</body>
</html>
`;
  const tokensList = Object.entries({ brand: palette.brand, brandSoft: palette.brandSoft, accent: palette.accent, ink: palette.ink, body: palette.body, muted: palette.muted, paper: palette.paper, surface: palette.surface, line: palette.line, success: palette.success, warning: palette.warning, danger: palette.danger }).map(
    ([key, hex]) => ({ name: `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, hex }),
  );
  const readme = `# ${name} design kit

${description}

- \`tokens.css\` — colours, spacing, radii, shadows and type scale as CSS custom properties
- \`palette.json\` — machine-readable palette
- \`assets/logo.svg\` — generated mark
- \`specimen.html\` — swatches, type scale and components rendered with the tokens

Use the tokens in any site by importing \`tokens.css\`, or paste the variable block into an existing stylesheet.
`;
  return [
    { path: 'tokens.css', content: tokens },
    { path: 'palette.json', content: JSON.stringify({ name, seed: palette.seed, colors: palette }, null, 2) },
    { path: 'specimen.html', content: specimen.replace('__TOKENS__', JSON.stringify(tokensList)) },
    { path: 'assets/logo.svg', content: logoSvg(name, palette) },
    { path: 'README.md', content: readme },
  ];
}

function nodeCliFiles({ name, description }) {
  const binName = slugify(name);
  const pkg = {
    name: binName,
    version: '1.0.0',
    description,
    type: 'commonjs',
    bin: { [binName]: 'cli.js' },
    scripts: { start: 'node cli.js' },
    license: 'MIT',
  };
  const cli = `#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function usage() {
  console.log(\`${name} — count lines, words and characters.

Usage:
  node cli.js <file> [--json]

Options:
  --json   print a JSON object instead of a table
  --help   show this message\`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h') || !args.length) {
  usage();
  process.exit(args.length ? 0 : 2);
}

const json = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  usage();
  process.exit(2);
}

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (err) {
  console.error('Cannot read ' + file + ': ' + err.message);
  process.exit(1);
}

const lines = text ? text.split(/\\r?\\n/).length : 0;
const words = (text.match(/\\S+/g) || []).length;
const chars = text.length;
const bytes = Buffer.byteLength(text, 'utf8');

if (json) {
  console.log(JSON.stringify({ file, lines, words, chars, bytes }, null, 2));
} else {
  console.log('File   ' + file);
  console.log('Lines  ' + lines);
  console.log('Words  ' + words);
  console.log('Chars  ' + chars);
  console.log('Bytes  ' + bytes);
}
`;
  const readme = `# ${name}

${description}

A zero-dependency Node.js CLI generated by ORVEX Maker.

## Run

\`\`\`
node cli.js README.md
node cli.js README.md --json
\`\`\`

## Install globally

\`\`\`
npm link
${binName} README.md
\`\`\`

The tool lives in \`cli.js\`; change \`package.json\` if you rename it.
`;
  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'cli.js', content: cli },
    { path: 'README.md', content: readme },
  ];
}

function pythonCliFiles({ name, description }) {
  const moduleName = slugify(name).replace(/-/g, '_');
  const main = `#!/usr/bin/env python3
"""${name} — ${description}"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def count(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    return {
        "file": str(path),
        "lines": text.count("\\n") + (1 if text else 0),
        "words": len(text.split()),
        "chars": len(text),
        "bytes": len(text.encode("utf-8")),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="${description}")
    parser.add_argument("file", type=Path)
    parser.add_argument("--json", action="store_true", help="print JSON")
    args = parser.parse_args()
    try:
        result = count(args.file)
    except OSError as err:
        print(f"Cannot read {args.file}: {err}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for key, value in result.items():
            print(f"{key.capitalize():<6} {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
  const readme = `# ${name}

${description}

A standard-library Python CLI generated by ORVEX Maker.

## Run

\`\`\`
python main.py README.md
python main.py README.md --json
\`\`\`

No third-party packages are required. Rename \`main.py\` and update \`${moduleName}\` references if you plan to package it.
`;
  return [
    { path: 'main.py', content: main },
    { path: 'README.md', content: readme },
    { path: '.gitignore', content: '__pycache__/\n*.pyc\n.venv/\n' },
  ];
}

function reactFiles({ name, title, description, palette }) {
  const pkg = {
    name: slugify(name),
    private: true,
    version: '1.0.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.0' },
  };
  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/logo.svg" type="image/svg+xml">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`;
  const main = `import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`;
  const app = `const features = [
  'React 18 with Vite',
  'Design tokens in styles.css',
  'Production build with npm run build',
]

export default function App() {
  return (
    <main className="page">
      <span className="pill">${escapeHtml(name)}</span>
      <h1>${escapeHtml(title)}</h1>
      <p className="lede">${escapeHtml(description)}</p>
      <ul>
        {features.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <p className="note">Run <code>npm install</code> and <code>npm run build</code> in this folder, then press Preview again to serve the built site.</p>
    </main>
  )
}
`;
  const styles = `${tokensCss(palette)}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--body); font-family: var(--font-sans); }
.page { max-width: 760px; margin: 0 auto; padding: clamp(48px, 10vw, 120px) 24px; }
.pill { display: inline-block; padding: 4px 12px; border-radius: 999px; background: var(--brand-soft); color: var(--brand); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; font-size: var(--step--1); }
h1 { color: var(--ink); font-size: clamp(2.2rem, 6vw, var(--step-5)); line-height: 1.1; letter-spacing: -0.02em; }
.lede { color: var(--muted); font-size: var(--step-1); }
li { margin-bottom: 6px; }
code { font-family: var(--font-mono); background: var(--surface); padding: 2px 5px; border-radius: 5px; }
`;
  const vite = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`;
  const readme = `# ${name}

${description}

React + Vite project generated by ORVEX Maker.

## Setup

\`\`\`
npm install
npm run dev      # Vite dev server
npm run build    # static output in dist/
\`\`\`

Maker preview serves \`dist/\` once it exists. Until then the preview explains that a build is required — it does not fake a running site.
`;
  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'index.html', content: indexHtml },
    { path: 'vite.config.js', content: vite },
    { path: 'src/main.jsx', content: main },
    { path: 'src/App.jsx', content: app },
    { path: 'src/styles.css', content: styles },
    { path: 'README.md', content: readme },
    { path: 'public/logo.svg', content: logoSvg(name, palette) },
  ];
}

const TEMPLATES = {
  website: {
    label: 'Website',
    description: 'Three linked static pages, shared CSS tokens, generated logo, mobile menu.',
    kind: 'static',
    previewable: true,
    files: websiteFiles,
  },
  landing: {
    label: 'Landing page',
    description: 'One-page hero, features and contact sections with a real design system.',
    kind: 'static',
    previewable: true,
    files: landingFiles,
  },
  'design-kit': {
    label: 'Design kit',
    description: 'Palette, type scale, spacing tokens, logo and a specimen page.',
    kind: 'static',
    previewable: true,
    files: designKitFiles,
  },
  'node-cli': {
    label: 'Node CLI',
    description: 'Zero-dependency Node.js command with argument parsing and JSON output.',
    kind: 'node-cli',
    previewable: false,
    files: nodeCliFiles,
  },
  'python-cli': {
    label: 'Python CLI',
    description: 'Standard-library Python command with argparse and JSON output.',
    kind: 'python-cli',
    previewable: false,
    files: pythonCliFiles,
  },
  'react-vite': {
    label: 'React + Vite',
    description: 'React 18 app with Vite; previews its built dist/ folder after npm run build.',
    kind: 'react',
    previewable: false,
    files: reactFiles,
  },
};

function templates() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({
    id,
    label: t.label,
    description: t.description,
    kind: t.kind,
    previewable: t.previewable,
  }));
}

function publicProject(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    template: row.template,
    title: row.title,
    description: row.description,
    dir: row.dir,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    files: row.files,
    palette: row.palette,
    kind: row.kind,
    previewUrl: previews.get(row.id)?.url || null,
  };
}

function list() {
  return { projects: store.projects.map(publicProject), root: rootDir() };
}

function getRow(id) {
  const row = store.projects.find((p) => p.id === String(id || ''));
  if (!row) throw new Error('Unknown Maker project.');
  return row;
}

function resolveInside(dir, rel = '') {
  const base = path.resolve(dir);
  const target = path.resolve(base, String(rel || '').replace(/^[/\\]+/, ''));
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('That path is outside this project.');
  return target;
}

async function writeTree(dir, files) {
  for (const file of files) {
    const target = resolveInside(dir, file.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, file.content, 'utf8');
  }
}

async function create(args = {}) {
  if (store.projects.length >= MAX_PROJECTS) throw new Error(`At most ${MAX_PROJECTS} Maker projects are indexed. Remove one first.`);
  const templateId = String(args.template || 'website');
  const template = TEMPLATES[templateId];
  if (!template) throw new Error(`Unknown template "${templateId}". Choose ${Object.keys(TEMPLATES).join(', ')}.`);
  const name = String(args.name || '').trim();
  if (name.length < 2 || name.length > 60) throw new Error('Project name must be 2-60 characters.');
  const title = String(args.title || name).trim().slice(0, 120) || name;
  const description = String(args.description || `A ${template.label.toLowerCase()} built in ORVEX Maker.`).trim().slice(0, 400);
  const slug = uniqueSlug(slugify(name));
  const id = `mk_${crypto.randomUUID()}`;
  const dir = path.join(projectsDir(), slug);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists; choose another name.`);
  const palette = makePalette(String(args.paletteSeed || `${name} ${title}`));
  const files = template.files({ name, title, description, palette });
  if (files.length > MAX_FILES) throw new Error('That template produced too many files.');
  await fsp.mkdir(dir, { recursive: true });
  try {
    await writeTree(dir, files);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw err;
  }
  const row = {
    id,
    name,
    slug,
    template: templateId,
    title,
    description,
    dir,
    kind: template.kind,
    files: files.map((f) => f.path),
    palette,
    createdAt: now(),
    updatedAt: now(),
  };
  store.projects.unshift(row);
  await persist();
  emit({ type: 'created', project: publicProject(row) });
  return publicProject(row);
}

async function remove(id) {
  const row = getRow(id);
  const preview = previews.get(row.id);
  if (preview) await stopPreview(row.id);
  const dir = path.resolve(row.dir);
  const parent = path.resolve(projectsDir());
  if (!dir.startsWith(parent + path.sep)) throw new Error('Refusing to delete a folder outside the Maker projects directory.');
  await fsp.rm(dir, { recursive: true, force: true });
  store.projects = store.projects.filter((p) => p.id !== row.id);
  await persist();
  emit({ type: 'removed', id: row.id });
  return { removed: row.id };
}

async function files(id, rel = '') {
  const row = getRow(id);
  const base = resolveInside(row.dir, rel || '');
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read that folder: ${err.message}`);
  }
  const out = [];
  for (const entry of entries.slice(0, MAX_FILES)) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) {
      out.push({ path: path.relative(row.dir, full).replace(/\\/g, '/'), name: entry.name, dir: true });
    } else {
      const stat = await fsp.stat(full);
      out.push({ path: path.relative(row.dir, full).replace(/\\/g, '/'), name: entry.name, dir: false, size: stat.size });
    }
  }
  return { project: publicProject(row), files: out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)) };
}

async function readFile(id, rel) {
  const row = getRow(id);
  const target = resolveInside(row.dir, rel);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error('That path is not a file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES / 1024} KB.`);
  const ext = path.extname(target).toLowerCase();
  if (BINARY_EXT.has(ext) && ext !== '.svg') {
    return { project: publicProject(row), path: rel, binary: true, size: stat.size, content: null };
  }
  const content = await fsp.readFile(target, 'utf8');
  return { project: publicProject(row), path: rel.replace(/\\/g, '/'), binary: false, size: stat.size, content };
}

async function writeFile(id, rel, content) {
  const row = getRow(id);
  const target = resolveInside(row.dir, rel);
  const text = String(content == null ? '' : content);
  if (text.length > MAX_WRITE_CHARS) throw new Error(`Content is larger than ${MAX_WRITE_CHARS / 1024 / 1024} MB.`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text, 'utf8');
  const relPath = path.relative(row.dir, target).replace(/\\/g, '/');
  if (!row.files.includes(relPath)) row.files.push(relPath);
  row.updatedAt = now();
  await persist();
  emit({ type: 'updated', project: publicProject(row), path: relPath });
  return { project: publicProject(row), path: relPath, bytes: Buffer.byteLength(text, 'utf8') };
}

function previewBase(row) {
  if (row.kind === 'react') {
    const dist = path.join(row.dir, 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      throw new Error('This React project has no dist/index.html yet. Run npm install and npm run build in the project folder, then preview again.');
    }
    return dist;
  }
  if (row.kind !== 'static') throw new Error(`A ${row.kind} project has no website to preview. Open the folder and run it instead.`);
  return row.dir;
}

function serveStatic(baseDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Only GET and HEAD are supported.');
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400);
        res.end('Bad path.');
        return;
      }
      const rel = pathname.replace(/^\/+/, '');
      let target = path.resolve(baseDir, rel || 'index.html');
      if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden.');
        return;
      }
      fs.stat(target, (err, stat) => {
        if (!err && stat.isDirectory()) {
          target = path.join(target, 'index.html');
          fs.stat(target, (err2, stat2) => {
            if (err2 || !stat2.isFile()) return notFound(res);
            return sendFile(res, target, stat2);
          });
          return;
        }
        if (err || !stat.isFile()) return notFound(res);
        sendFile(res, target, stat);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found.');
}

function sendFile(res, file, stat) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (res.req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

async function preview(id) {
  const row = getRow(id);
  const existing = previews.get(row.id);
  if (existing) return { project: publicProject(row), url: existing.url, port: existing.port, reused: true };
  const base = previewBase(row);
  const served = await serveStatic(base);
  previews.set(row.id, served);
  emit({ type: 'preview', project: publicProject(row), url: served.url });
  return { project: publicProject(row), url: served.url, port: served.port, base };
}

async function stopPreview(id) {
  const row = getRow(id);
  const entry = previews.get(row.id);
  if (!entry) return { stopped: false, project: publicProject(row) };
  previews.delete(row.id);
  await new Promise((resolve) => entry.server.close(() => resolve()));
  emit({ type: 'preview-stopped', project: publicProject(row) });
  return { stopped: true, project: publicProject(row) };
}

async function exportZip(id, destDir) {
  const row = getRow(id);
  const targetDir = destDir ? path.resolve(String(destDir)) : projectsDir();
  await fsp.mkdir(targetDir, { recursive: true });
  const out = path.join(targetDir, `${row.slug}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(out);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(row.dir, false);
    archive.finalize();
  });
  const stat = await fsp.stat(out);
  emit({ type: 'exported', project: publicProject(row), file: out });
  return { project: publicProject(row), file: out, bytes: stat.size };
}

function runnable(row, args = []) {
  if (row.kind === 'node-cli') return { command: process.execPath, base: ['cli.js'] };
  if (row.kind === 'python-cli') return { command: process.platform === 'win32' ? 'python' : 'python3', base: ['main.py'] };
  throw new Error('Only node-cli and python-cli projects can run in place. For React, use npm run dev in the folder.');
}

async function run(id, args = []) {
  const row = getRow(id);
  const { command, base } = runnable(row);
  const list = Array.isArray(args) ? args.map(String) : [];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...base, ...list], { cwd: row.dir, windowsHide: true, shell: false });
    } catch (err) {
      resolve({ ok: false, error: `Could not start the tool: ${err.message}`, project: publicProject(row) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ok: false, error: `The tool ran longer than ${RUN_TIMEOUT_MS / 1000}s and was stopped.`, stdout, stderr, project: publicProject(row) });
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < RUN_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < RUN_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stdout, stderr, project: publicProject(row) });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        error: code === 0 ? undefined : `The tool exited with code ${code}.`,
        stdout: stdout.slice(0, RUN_OUTPUT_BYTES),
        stderr: stderr.slice(0, RUN_OUTPUT_BYTES),
        project: publicProject(row),
      });
    });
  });
}

function approvalReason(name, args = {}) {
  if (name === 'maker_run') return 'This runs generated code as a real process on this PC.';
  if (name === 'maker_remove') return `This deletes the Maker project "${args.projectId || args.id || ''}" and every file in its folder.`;
  return null;
}

const definitions = [
  {
    name: 'maker_templates',
    description: 'List the real project templates ORVEX Maker can scaffold: website, landing page, design kit, Node CLI, Python CLI, React + Vite.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'maker_list',
    description: 'List Maker projects on this machine with their template, folder and whether a preview server is running.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'maker_create',
    description:
      'Scaffold a real project folder with working source files. Returns the project id and folder; use maker_write_file to customise it.',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'website | landing | design-kit | node-cli | python-cli | react-vite' },
        name: { type: 'string', description: 'Project name, 2-60 characters.' },
        title: { type: 'string', description: 'Headline for websites and landing pages.' },
        description: { type: 'string', description: 'Short description used in the page copy and README.' },
        paletteSeed: { type: 'string', description: 'Optional seed for the generated palette.' },
      },
      required: ['template', 'name'],
    },
  },
  {
    name: 'maker_files',
    description: 'List the files in a Maker project folder.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string', description: 'Optional subfolder.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'maker_read_file',
    description: 'Read one text file from a Maker project.',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string' }, path: { type: 'string' } },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'maker_write_file',
    description: 'Create or overwrite a file inside a Maker project. Parent folders are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string', description: 'Relative path, e.g. index.html or src/App.jsx.' },
        content: { type: 'string' },
      },
      required: ['projectId', 'path', 'content'],
    },
  },
  {
    name: 'maker_preview',
    description: 'Start a real local preview server for a static project and return its URL. React projects preview only after a build.',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'maker_stop_preview',
    description: 'Stop a running Maker preview server.',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'maker_export',
    description: 'Zip a Maker project folder so it can be shared or uploaded.',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string' }, destDir: { type: 'string', description: 'Optional destination folder.' } },
      required: ['projectId'],
    },
  },
  {
    name: 'maker_run',
    description: 'Run a generated Node or Python CLI with arguments and return its real output. Needs approval.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments after the script name.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'maker_remove',
    description: 'Delete a Maker project and its folder. This needs approval.',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
];

const handlers = {
  maker_templates: () => ({ ok: true, output: templates().map((t) => `${t.id} — ${t.label}: ${t.description}`).join('\n'), templates: templates() }),
  maker_list: () => {
    const data = list();
    return {
      ok: true,
      output: data.projects.length
        ? data.projects.map((p) => `${p.name} (${p.template}) — ${p.dir}${p.previewUrl ? ` — preview ${p.previewUrl}` : ''}`).join('\n')
        : `No Maker projects yet. Templates: ${Object.keys(TEMPLATES).join(', ')}.`,
      ...data,
    };
  },
  maker_create: async (args) => {
    const project = await create(args || {});
    return { ok: true, output: `Created ${project.name} (${project.template}) at ${project.dir} with ${project.files.length} files.`, project };
  },
  maker_files: async ({ projectId, path: rel } = {}) => {
    const data = await files(projectId, rel || '');
    return { ok: true, output: data.files.map((f) => `${f.dir ? '[dir]' : `${f.size} B`} ${f.path}`).join('\n') || 'Empty folder.', ...data };
  },
  maker_read_file: async ({ projectId, path: rel } = {}) => {
    if (!rel) return { ok: false, error: 'path is required.' };
    const data = await readFile(projectId, rel);
    return { ok: true, output: data.binary ? `${data.path} is binary (${data.size} bytes).` : data.content, ...data };
  },
  maker_write_file: async ({ projectId, path: rel, content } = {}) => {
    if (!rel) return { ok: false, error: 'path is required.' };
    const data = await writeFile(projectId, rel, content);
    return { ok: true, output: `Wrote ${data.path} (${data.bytes} bytes).`, ...data };
  },
  maker_preview: async ({ projectId } = {}) => {
    const data = await preview(projectId);
    return { ok: true, output: `Preview running at ${data.url}${data.base ? ` (serving ${data.base})` : ''}.`, ...data };
  },
  maker_stop_preview: async ({ projectId } = {}) => {
    const data = await stopPreview(projectId);
    return { ok: true, output: data.stopped ? 'Preview stopped.' : 'No preview was running.', ...data };
  },
  maker_export: async ({ projectId, destDir } = {}) => {
    const data = await exportZip(projectId, destDir);
    return { ok: true, output: `Exported ${data.file} (${Math.round(data.bytes / 1024)} KB).`, ...data };
  },
  maker_run: async ({ projectId, args } = {}) => {
    const data = await run(projectId, args || []);
    return { ...data, output: [data.stdout, data.stderr].filter(Boolean).join('\n').slice(0, 6000) };
  },
  maker_remove: async ({ projectId } = {}) => {
    const data = await remove(projectId);
    return { ok: true, output: 'Project deleted.', ...data };
  },
};

async function stopAll() {
  for (const id of [...previews.keys()]) {
    try {
      await stopPreview(id);
    } catch {
      /* best effort */
    }
  }
}

module.exports = {
  init,
  templates,
  list,
  create,
  remove,
  files,
  readFile,
  writeFile,
  preview,
  stopPreview,
  exportZip,
  run,
  stopAll,
  approvalReason,
  definitions,
  handlers,
  _internals: {
    slugify,
    makePalette,
    tokensCss,
    logoSvg,
    resolveInside,
    TEMPLATES,
    escapeHtml,
  },
};
