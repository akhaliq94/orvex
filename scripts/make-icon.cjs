'use strict';

/**
 * Renders the ORVEX mark into build/icon.png (512x512, transparent corners).
 * Run with: env -u ELECTRON_RUN_AS_NODE npx electron scripts/make-icon.cjs
 * (ELECTRON_RUN_AS_NODE must be unset — otherwise Electron runs as plain Node.)
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
  .icon {
    position: relative; width: ${SIZE}px; height: ${SIZE}px;
    border-radius: 120px;
    background: radial-gradient(120% 120% at 30% 15%, #12203a 0%, #070b14 55%, #04060b 100%);
    box-shadow: inset 0 0 0 2px rgba(120, 205, 255, 0.20);
    display: grid; place-items: center;
    overflow: hidden;
  }
  .glow {
    position: absolute; width: 360px; height: 360px; border-radius: 50%;
    background: radial-gradient(circle, rgba(72, 155, 255, 0.55) 0%, rgba(72, 155, 255, 0.16) 45%, transparent 70%);
    top: 45%; left: 50%; transform: translate(-50%, -50%);
  }
  .mark { position: relative; width: 330px; height: 330px; filter: drop-shadow(0 0 26px rgba(83, 170, 255, 0.55)); }
</style></head>
<body>
  <div class="icon">
    <div class="glow"></div>
    <svg class="mark" viewBox="0 0 100 100" fill="none">
      <defs>
        <linearGradient id="face" x1="50" y1="10" x2="50" y2="92" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#eafaff"/><stop offset="0.42" stop-color="#8fdcff"/><stop offset="1" stop-color="#2f7dff"/>
        </linearGradient>
        <linearGradient id="edge" x1="16" y1="20" x2="84" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#d9f6ff"/><stop offset="1" stop-color="#1b5cff"/>
        </linearGradient>
      </defs>
      <path fill-rule="evenodd"
        d="M50 6c2.6 0 5 1.4 6.4 3.8l37 64.7c2.8 5-1 11.2-6.8 11.2H13.4c-5.8 0-9.6-6.2-6.8-11.2l37-64.7C45 7.4 47.4 6 50 6ZM50 60 68.5 88h-37L50 60Z"
        fill="url(#face)" stroke="url(#edge)" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M50 47v11" stroke="rgba(235,250,255,0.7)" stroke-width="1.1" stroke-linecap="round"/>
    </svg>
  </div>
</body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  const size = image.getSize();
  console.log(`icon written: ${out} (${size.width}x${size.height}, ${image.toPNG().length} bytes)`);
  app.quit();
});
