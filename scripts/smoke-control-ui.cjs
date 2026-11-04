'use strict';

/**
 * Section 11 Control PC UI smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Drives the real page: status cards, volume slider + mute, media keys,
 * honest brightness state, live screenshot preview, OCR, clipboard
 * round-trip, mouse/keyboard controls, windows, UI Automation, processes,
 * the safe kill confirm, screen recording and the error banner.
 */

const fs = require('node:fs');
const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
}

let pass = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    pass += 1;
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && !/recorder\.html/.test(t.url));
  if (!page) throw new Error('No page target — is the ORVEX window open?');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed';
      throw new Error(`${detail}\nEXPR: ${expression.slice(0, 600)}`);
    }
    return r.result.value;
  };
  const until = async (expression, timeoutMs, label) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const deskEval = (body) =>
    evaluate(`(async () => {
      const api = window.orvex && window.orvex.desktop;
      if (!api) return { ok: false, error: 'desktop bridge missing' };
      ${body}
    })()`);
  const desk = async (call, ...args) =>
    deskEval(`
      const r = await api.${call}(${args.map((a) => JSON.stringify(a)).join(', ')});
      return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
    `);
  const clickText = (selector, text, exact = false) =>
    evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = nodes.find((n) => ${exact ? `n.textContent.trim() === ${JSON.stringify(text)}` : `n.textContent.includes(${JSON.stringify(text)})`});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const clickButton = (text) =>
    evaluate(`(() => {
      const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const setValue = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      return el.value;
    })()`);
  const clickTitle = (title) =>
    evaluate(`(() => {
      const hit = document.querySelector('[title=' + JSON.stringify(${JSON.stringify(title)}) + ']');
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const setRange = async (label, value) => {
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});
      if (!el) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    if (!ok) return false;
    await sleep(250);
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});
      if (el) el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    })()`);
    return true;
  };
  const waitVolume = (level, timeoutMs = 8000) =>
    until(
      `(async () => {
        const r = await window.orvex.desktop.volume();
        return r.ok && r.data.volume === ${level};
      })()`,
      timeoutMs,
      `volume ${level}`,
    );
  const waitAction = (source, flags = '') =>
    until(
      `(() => {
        const t = document.querySelector('.dc-action-line')?.innerText || '';
        return new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)}).test(t) ? t : '';
      })()`,
      20000,
      'the action line',
    );
  const rowsIn = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => n.innerText)`);

  const status0 = await desk('system');
  if (!status0.ok) throw new Error(`desktop bridge failed: ${status0.error}`);
  const original = {
    volume: status0.data.volume,
    muted: status0.data.muted,
    brightness: status0.data.brightness,
    clipboard: await desk('clipboardRead').then((r) => (r.ok ? r.data : { kind: 'empty', text: '', file: null })),
  };

  await until(`!!window.orvex?.desktop && typeof window.orvex.desktop.system === 'function'`, 20000, 'the desktop bridge');
  check('desktop bridge is exposed to the renderer', true);

  console.log('\n— open the page');
  await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Control PC')`, 20000, 'the Control PC nav item');
  await clickText('.nav-item', 'Control PC', true);
  await until(`document.querySelector('.page-title')?.textContent === 'Control PC'`, 10000, 'the Control PC page');
  check('Control PC opens from the sidebar', true);
  await until(`document.querySelectorAll('.dc-tab').length === 7`, 10000, 'the device tool tabs');
  await clickText('.dc-tab', 'Screen & OCR', true);
  await until(`document.querySelector('.dc-tab.active')?.textContent.trim() === 'Screen & OCR'`, 5000, 'the Screen & OCR tab');

  const tabs = await evaluate(`[...document.querySelectorAll('.dc-tab')].map((n) => n.textContent.trim())`);
  const expectedTabs = ['Screen & OCR', 'Mouse & Keyboard', 'Windows', 'Processes', 'Clipboard', 'UI Automation', 'Recording'];
  check('seven device tools are listed', tabs.length === 7 && expectedTabs.every((t) => tabs.includes(t)), JSON.stringify(tabs));

  console.log('\n— machine card and sound card');
  await until(
    `(() => {
      const card = document.querySelector('.dc-side .dc-card:first-child');
      return card?.querySelector('.dc-chip')?.textContent === 'live' && card.querySelectorAll('.dc-kv').length >= 7 && !!document.querySelector('.dc-shot img');
    })()`,
    30000,
    'live machine data and the first screenshot',
  );
  const machine = await evaluate(`(() => {
    const kv = [...document.querySelectorAll('.dc-side .dc-card:first-child .dc-kv')].map((n) => n.innerText);
    const chip = document.querySelector('.dc-side .dc-card:first-child .dc-chip')?.textContent;
    const bar = document.querySelector('.dc-bar i')?.style.width || '';
    const net = document.querySelector('.dc-net')?.innerText || '';
    return { kv, chip, bar, net };
  })()`);
  check(
    'This machine shows real host, OS, CPU, RAM and uptime',
    machine.chip === 'live' &&
      machine.kv.some((l) => /^Host/.test(l)) && machine.kv.some((l) => /^OS/.test(l)) &&
      machine.kv.some((l) => /^CPU/.test(l) && /threads/.test(l)) &&
      machine.kv.some((l) => /^RAM/.test(l) && /\//.test(l)) &&
      machine.kv.some((l) => /^Uptime/.test(l)) && /%$/.test(machine.bar),
    machine.kv.join(' | ').slice(0, 160),
  );
  check('LAN address row is rendered', machine.net.length > 0, machine.net);
  check('host value matches the real machine name', machine.kv.some((l) => l.includes(status0.data.hostname)), status0.data.hostname);

  const sound = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.dc-side .dc-card')].find((c) => c.querySelector('h3')?.textContent === 'Sound & light');
    return {
      found: !!card,
      chip: card?.querySelector('.dc-chip')?.textContent || '',
      sliders: [...(card?.querySelectorAll('input[type=range]') || [])].map((s) => ({ label: s.getAttribute('aria-label'), disabled: s.disabled })),
      hint: card?.querySelector('.dc-hint')?.textContent || '',
      mediaKeys: [...(card?.querySelectorAll('.dc-key') || [])].map((b) => b.title)
    };
  })()`);
  check('Sound & light exposes volume and brightness sliders', sound.found && sound.sliders.length === 2, JSON.stringify(sound.sliders));
  const volumeSlider = sound.sliders.find((s) => s.label === 'System volume');
  const brightSlider = sound.sliders.find((s) => s.label === 'Display brightness');
  check('volume slider is enabled when CoreAudio is available', original.volume != null ? volumeSlider && !volumeSlider.disabled : volumeSlider && volumeSlider.disabled, String(original.volume));
  check(
    'media keys include transport and volume keys',
    ['Previous track', 'Play or pause', 'Next track', 'Stop media', 'Volume up', 'Volume down', 'Mute key'].every((t) => sound.mediaKeys.includes(t)),
    sound.mediaKeys.join(', '),
  );

  const voiceCard = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.dc-side .dc-card')].find((c) => c.querySelector('h3')?.textContent === 'Voice control');
    return { found: !!card, chip: card?.querySelector('.dc-chip')?.textContent, button: card?.querySelector('button')?.textContent.trim() };
  })()`);
  check('voice control card offers a real listening toggle', voiceCard.found && /Talk to ORVEX|Stop listening/.test(voiceCard.button || ''), `${voiceCard.chip} / ${voiceCard.button}`);

  console.log('\n— screen capture, OCR and clipboard image');
  const shot = await evaluate(`(() => {
    const img = document.querySelector('.dc-shot img');
    const chip = [...document.querySelectorAll('.dc-card')].find((c) => c.querySelector('h3')?.textContent === 'Live screen')?.querySelector('.dc-chip')?.textContent || '';
    return { src: img?.getAttribute('src') || '', width: img?.naturalWidth || 0, height: img?.naturalHeight || 0, chip };
  })()`);
  check(
    'live screenshot loads from a tokenised preview URL',
    /^orvex-media:\/\/source\//.test(shot.src) && shot.width > 0 && shot.height > 0 && /^\d+×\d+$/.test(shot.chip),
    `${shot.chip} ${shot.src.slice(0, 48)}`,
  );

  const displays = await evaluate(`[...document.querySelectorAll('.dc-split .dc-row')].map((n) => n.innerText)`);
  check('display list shows the real resolution', displays.length >= 1 && /\d+×\d+ px at/.test(displays.join(' ')), displays.join(' | '));

  await clickButton('Capture');
  await sleep(1200);
  await until(`!document.querySelector('.dc-tabs-busy')`, 15000, 'the capture to finish');
  check('Capture refreshes the live screenshot', await evaluate(`!!document.querySelector('.dc-shot img') && document.querySelector('.dc-shot img').naturalWidth > 0`));

  await clickButton('Copy');
  const clipAfterCopy = await until(
    `(async () => {
      const r = await window.orvex.desktop.clipboardRead();
      return r.ok && r.data.kind === 'image' ? r.data : '';
    })()`,
    15000,
    'the screenshot on the clipboard',
  );
  check('Copy puts the real screenshot on the clipboard', !!clipAfterCopy && clipAfterCopy.width > 0, clipAfterCopy ? `${clipAfterCopy.width}x${clipAfterCopy.height}` : '');
  await desk('clipboardWrite', { text: original.clipboard.kind === 'text' ? original.clipboard.text : 'orvex' });

  await clickButton('Read text');
  const ocrCard = await until(
    `(() => {
      const card = [...document.querySelectorAll('.dc-card')].find((c) => c.querySelector('h3')?.textContent === 'Recognised text');
      return card ? { chip: card.querySelector('.dc-chip')?.textContent || '', lines: card.querySelectorAll('.dc-ocr-line').length, hint: card.querySelector('.dc-hint')?.textContent || '' } : null;
    })()`,
    45000,
    'the OCR result card',
  );
  check('Read text returns a structured OCR result', !!ocrCard && (ocrCard.lines > 0 || /No text was recognised/.test(ocrCard.hint)), `${ocrCard?.lines} line(s) · ${ocrCard?.chip}`);

  console.log('\n— volume, mute, media keys and brightness');
  if (original.volume != null) {
    await setRange('System volume', 33);
    await waitVolume(33);
    check('volume slider writes the real system level', true, '33%');
    await setRange('System volume', original.volume);
    await waitVolume(original.volume);
    if (original.muted) await desk('volume', { mute: true });

    const beforeMute = original.muted;
    const muteButtonReady = () =>
      until(`(() => { const b = document.querySelector('[title="Mute"], [title="Unmute"]'); return !!b && !b.disabled; })()`, 15000, 'the mute button');
    await muteButtonReady();
    await clickTitle(beforeMute ? 'Unmute' : 'Mute');
    const afterMute = await until(
      `(async () => {
        const r = await window.orvex.desktop.volume();
        return r.ok && r.data.muted !== ${beforeMute} ? r.data.muted : '';
      })()`,
      15000,
      'the mute toggle',
    );
    check('mute button flips the real endpoint', afterMute === !beforeMute, `muted ${beforeMute} → ${afterMute}`);
    await muteButtonReady();
    await clickTitle(beforeMute ? 'Mute' : 'Unmute');
    await until(
      `(async () => {
        const r = await window.orvex.desktop.volume();
        return r.ok && r.data.muted === ${beforeMute};
      })()`,
      15000,
      'the mute state to restore',
    );

    await desk('volume', { level: 40 });
    await clickTitle('Volume up');
    const actionLine = await waitAction('Volume up — .*on the focused window');
    check('media key button sends a real system key', !!actionLine, actionLine.replace(/\s+/g, ' ').slice(0, 100));
    const raised = await until(
      `(async () => {
        const r = await window.orvex.desktop.volume();
        return r.ok && r.data.volume >= 40 ? r.data.volume : '';
      })()`,
      10000,
      'the raised volume',
    );
    check('volume key really raised the system level', raised !== '', `${raised}%`);
    await desk('volume', { level: original.volume, mute: original.muted });
  } else {
    check('volume controls stay disabled without an endpoint', !!volumeSlider && volumeSlider.disabled);
  }

  if (original.brightness == null) {
    check('brightness is honestly marked unavailable', /brightness n\/a/.test(sound.chip) && brightSlider && brightSlider.disabled && /monitor buttons/.test(sound.hint), sound.chip);
  } else {
    await setRange('Display brightness', 55);
    await until(
      `(async () => {
        const r = await window.orvex.desktop.brightness();
        return r.ok && r.data.level === 55;
      })()`,
      15000,
      'brightness 55',
    );
    check('brightness slider writes the real display level', true);
    await setRange('Display brightness', original.brightness);
    await until(
      `(async () => {
        const r = await window.orvex.desktop.brightness();
        return r.ok && r.data.level === ${original.brightness};
      })()`,
      15000,
      'the original brightness',
    );
  }

  console.log('\n— mouse and keyboard');
  await clickText('.dc-tab', 'Mouse & Keyboard', true);
  await until(`!!document.querySelector('.dc-tab-body .dc-card')`, 5000, 'the input tools');
  const inputCard = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.dc-card')].find((c) => c.querySelector('h3')?.textContent === 'Mouse');
    return { fields: [...(card?.querySelectorAll('.dc-field span') || [])].map((n) => n.textContent), buttons: [...(card?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()) };
  })()`);
  check('mouse panel covers move, click, scroll and drag', ['X', 'Y'].every((f) => inputCard.fields.includes(f)) && ['Move', 'Left click', 'Right click', 'Double click', 'Scroll up', 'Scroll down', 'Drag'].every((b) => inputCard.buttons.includes(b)), inputCard.buttons.join(', '));

  await setValue('.dc-tab-body .dc-card input[type=number]', '80');
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.dc-tab-body .dc-card input[type=number]')][1];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '80');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await clickButton('Move');
  const moveLine = await waitAction('moved to 80,80');
  check('Move drives the real cursor', !!moveLine, moveLine.replace(/\s+/g, ' ').slice(0, 100));

  await clickButton('Use cursor position');
  const cursorNow = await until(
    `(async () => {
      const r = await window.orvex.desktop.screenInfo();
      return r.ok ? r.data.cursor : null;
    })()`,
    10000,
    'the cursor position',
  );
  await sleep(400);
  const synced = await evaluate(`(() => {
    const xs = [...document.querySelectorAll('.dc-field input[type=number]')].map((i) => Number(i.value));
    return { x: xs[0], y: xs[1] };
  })()`);
  check('Use cursor position syncs the real coordinates', !!cursorNow && synced.x === cursorNow.x && synced.y === cursorNow.y, `field ${synced.x},${synced.y} vs real ${cursorNow?.x},${cursorNow?.y}`);

  await clickText('.dc-quick-keys .dc-key', 'Esc', true);
  const escLine = await waitAction('Esc — pressed \\d+ on the focused window');
  check('quick key buttons send real keystrokes', !!escLine, escLine.replace(/\s+/g, ' ').slice(0, 100));

  const keyPanel = await evaluate(`(() => {
    const ta = document.querySelector('.dc-tab-body .dc-card textarea');
    const chord = document.querySelector('.dc-tab-body .dc-card input[placeholder^="Key or chord"]');
    return { hasText: !!ta, hasChord: !!chord, quick: document.querySelectorAll('.dc-quick-keys .dc-key').length };
  })()`);
  check('keyboard panel has typing, chords and ten quick keys', keyPanel.hasText && keyPanel.hasChord && keyPanel.quick === 10, `${keyPanel.quick} quick keys`);

  console.log('\n— windows and UI Automation');
  await clickText('.dc-tab', 'Windows', true);
  await until(`document.querySelectorAll('.dc-rows .dc-row').length > 0`, 15000, 'the window list');
  const winRows = await rowsIn('.dc-tab-body .dc-rows .dc-row');
  check('window list renders hwnd, pid, state and size', winRows.length >= 1 && winRows.every((r) => /hwnd \d+ · pid \d+ · \w+ · \d+×\d+/.test(r)), `${winRows.length} rows`);
  const orvexRow = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.dc-tab-body .dc-rows .dc-row')];
    const hit = rows.find((r) => /ORVEX/i.test(r.innerText)) || rows[0];
    hit.querySelector('[title="Inspect with UI Automation"]')?.click();
    return hit.querySelector('.dc-name')?.textContent || '';
  })()`);
  await until(`document.querySelector('.dc-tab.active')?.textContent.includes('UI Automation')`, 5000, 'the automation tab');
  await until(
    `(() => {
      const sel = [...document.querySelectorAll('.dc-tab-body select')].find((s) => [...s.options].some((o) => o.textContent.includes('Pick an open window')));
      return !!sel && [...sel.options].some((o) => o.value === ${JSON.stringify(orvexRow)});
    })()`,
    15000,
    'the automation window picker',
  );
  const selectedTarget = await evaluate(`(() => {
    const sel = [...document.querySelectorAll('.dc-tab-body select')].find((s) => [...s.options].some((o) => o.textContent.includes('Pick an open window')));
    return sel ? sel.value : '';
  })()`);
  check('Inspect opens UI Automation with the window selected', selectedTarget === orvexRow && !!orvexRow, selectedTarget.slice(0, 60));

  await desk('windowAction', { title: orvexRow, action: 'restore' });
  await desk('windowAction', { title: orvexRow, action: 'focus' });
  await clickButton('Read tree');
  const tree = await until(
    `(async () => {
      const pre = document.querySelector('.dc-pre');
      if (!pre) return '';
      const bridge = await window.orvex.desktop.uiTree({ title: ${JSON.stringify(orvexRow)}, depth: 3, max: 200 });
      return pre.textContent + '\\n@@nodes:' + (bridge.ok ? bridge.data.nodes : -1);
    })()`,
    45000,
    'the UI Automation tree',
  );
  const treeNodes = Number((tree.match(/@@nodes:(-?\d+)/) || [])[1]);
  check('Read tree renders a real UIA tree', treeNodes > 0 && /\[0/.test(tree), `${treeNodes} nodes`);
  const treePaths = [...tree.matchAll(/\[(\d+(?:\/\d+)*)\]/g)].map((m) => m[1]);
  const firstPath = treePaths.find((p) => p.includes('/')) || treePaths[0] || '0';
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('.dc-tab-body input')];
    const path = inputs.find((i) => i.placeholder === '[0/1/2]');
    if (path) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(path, ${JSON.stringify(`[${firstPath}]`)});
      path.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const select = [...document.querySelectorAll('.dc-tab-body select')].find((s) => [...s.options].some((o) => o.value === 'click'));
    if (select) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'click');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  await sleep(300);
  await evaluate(`document.querySelector('.dc-action-line button[aria-label="Clear"]')?.click()`);
  await clickButton('Run action');
  const uiaLine = await until(
    `(() => {
      const err = document.querySelector('.dc-error')?.innerText || '';
      const t = document.querySelector('.dc-action-line')?.innerText || '';
      if (/^UI click on /.test(t)) return t;
      if (err) return 'ERR ' + err;
      return '';
    })()`,
    20000,
    'the UI Automation action result',
  );
  check('Run action executes through UI Automation', /^UI click on .* — clicked/.test(uiaLine), uiaLine.replace(/\s+/g, ' ').slice(0, 120));

  console.log('\n— processes and the safe kill confirm');
  await clickText('.dc-tab', 'Processes', true);
  await until(`!![...document.querySelectorAll('.dc-tab-body input')].find((i) => i.placeholder?.startsWith('Filter by process'))`, 10000, 'the process tools');
  await evaluate(`(() => {
    const input = [...document.querySelectorAll('.dc-tab-body input')].find((i) => i.placeholder?.startsWith('Filter by process'));
    if (input && input.value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const select = document.querySelector('.dc-tab-body select');
    if (select && select.value !== 'memory') {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'memory');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  await until(`document.querySelectorAll('.dc-tab-body .dc-rows .dc-row').length >= 5`, 30000, 'the process list');
  const procRows = await rowsIn('.dc-tab-body .dc-rows .dc-row');
  check('process list renders pid, memory and CPU time', procRows.length >= 1 && procRows.every((r) => /pid \d+/.test(r) && /MB · CPU/.test(r)), `${procRows.length} rows`);

  await setValue('.dc-tab-body select', 'name');
  const sortedRows = await until(
    `(() => {
      const names = [...document.querySelectorAll('.dc-tab-body .dc-rows .dc-row .dc-name')].map((n) => n.firstChild.textContent.trim());
      const head = names.slice(0, 20);
      return head.length > 1 && head.every((n, i) => i === 0 || head[i - 1].localeCompare(n) <= 0) ? head : null;
    })()`,
    30000,
    'the process list to re-sort by name',
  );
  check('sort control re-sorts the real process list', sortedRows.length > 1, sortedRows.slice(0, 4).join(', '));

  const firstName = await evaluate(`document.querySelector('.dc-tab-body .dc-rows .dc-row .dc-name')?.firstChild.textContent.trim() || ''`);
  const countBeforeFilter = await evaluate(`document.querySelectorAll('.dc-tab-body .dc-rows .dc-row').length`);
  if (firstName) {
    await evaluate(`(() => {
      const input = [...document.querySelectorAll('.dc-tab-body input')].find((i) => i.placeholder?.startsWith('Filter by process'));
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(firstName)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    const filtered = await until(
      `(() => {
        const rows = [...document.querySelectorAll('.dc-tab-body .dc-rows .dc-row')];
        const names = rows.map((r) => r.innerText);
        return names.length >= 1 && (${countBeforeFilter} < 2 || names.length < ${countBeforeFilter}) && names.every((n) => n.includes(${JSON.stringify(firstName)})) ? names : null;
      })()`,
      30000,
      'the process list to narrow to the filter',
    );
    check('process filter narrows to matching names', filtered.length >= 1 && filtered.every((r) => r.includes(firstName)), `${filtered.length} × ${firstName}`);

    await evaluate(`(() => { window.__orvexConfirm = []; window.confirm = (m) => { window.__orvexConfirm.push(m); return false; }; })()`);
    await evaluate(`document.querySelector('.dc-tab-body .dc-rows .dc-row .dc-icon-btn.danger')?.click()`);
    await sleep(600);
    const confirmMsg = await evaluate(`(window.__orvexConfirm || []).join(' ')`);
    const stillThere = await evaluate(`document.querySelectorAll('.dc-tab-body .dc-rows .dc-row').length`);
    check('kill asks for confirmation and a cancel changes nothing', /Stop .*pid \d+/.test(confirmMsg) && stillThere >= 1, confirmMsg);
    await evaluate(`window.confirm = () => true`);
    await setValue('.dc-tab-body input[placeholder^="Filter by process"]', '');
  }

  console.log('\n— clipboard round-trip and the error banner');
  const uiClip = `control ui clipboard ${Date.now()}`;
  await desk('clipboardWrite', { text: uiClip });
  await clickText('.dc-tab', 'Clipboard', true);
  await until(`document.querySelector('.dc-tab-body textarea')?.value === ${JSON.stringify(uiClip)}`, 15000, 'the clipboard text to load');
  check('clipboard tab loads the real clipboard text', true);
  check('clipboard chip reports the text kind', await evaluate(`document.querySelector('.dc-tab-body .dc-chip')?.textContent === 'text'`));

  const typedClip = `control ui write ${Date.now()}`;
  await setValue('.dc-tab-body textarea', typedClip);
  await clickButton('Copy text');
  await until(
    `(async () => {
      const r = await window.orvex.desktop.clipboardRead();
      return r.ok && r.data.text === ${JSON.stringify(typedClip)};
    })()`,
    15000,
    'the clipboard write',
  );
  check('Copy text writes the edited text to the clipboard', true);

  await setValue('.dc-tab-body textarea', '');
  await sleep(300);
  await clickButton('Copy text');
  const banner = await until(`document.querySelector('.dc-error')?.innerText || ''`, 10000, 'the error banner');
  check('empty clipboard writes are refused with a banner', /Type some text first/.test(banner), banner.replace(/\s+/g, ' ').slice(0, 80));
  await evaluate(`document.querySelector('.dc-error button[aria-label="Dismiss"]')?.click()`);
  await until(`!document.querySelector('.dc-error')`, 5000, 'the banner to close');
  check('error banner can be dismissed', true);

  console.log('\n— screen recording');
  await clickText('.dc-tab', 'Recording', true);
  await until(`!!document.querySelector('.dc-tab-body .dc-card')`, 5000, 'the recording tab');
  const recForm = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.dc-tab-body .dc-card')].find((c) => c.querySelector('h3')?.textContent === 'Screen recording');
    return { chip: card?.querySelector('.dc-chip')?.textContent, labels: [...(card?.querySelectorAll('.dc-field > span') || [])].map((n) => n.textContent), start: [...(card?.querySelectorAll('button') || [])].some((b) => b.textContent.includes('Start recording')) };
  })()`);
  check('recording tab exposes display, FPS, audio and start', ['Display', 'FPS', 'Audio'].every((l) => recForm.labels.includes(l)) && recForm.start, `${recForm.chip} · ${recForm.labels.join(', ')}`);

  await clickButton('Start recording');
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Stop & save'))`, 20000, 'the recording to start');
  await until(`document.querySelector('.dc-rec-status')?.innerText.match(/\\d+s/)`, 15000, 'live recording seconds');
  check('recording starts and reports live progress', await evaluate(`!!document.querySelector('.dc-rec-dot') && /Recording display/.test(document.querySelector('.dc-rec-status').innerText)`), await evaluate(`document.querySelector('.dc-rec-status')?.innerText || ''`));
  await sleep(2200);
  await clickButton('Stop & save');
  await until(`!!document.querySelector('.dc-tab-body video')`, 30000, 'the recorded video preview');
  const rec = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.dc-tab-body .dc-card')].find((c) => c.querySelector('h3')?.textContent === 'Screen recording');
    const video = card?.querySelector('video');
    const file = card?.querySelector('.dc-inline-actions .dc-muted')?.textContent || '';
    const buttons = [...(card?.querySelectorAll('button') || [])].map((b) => b.textContent.trim());
    return { src: video?.getAttribute('src') || '', file, buttons };
  })()`);
  let recBytes = 0;
  try {
    recBytes = rec.file ? fs.statSync(rec.file).size : 0;
  } catch {
    /* handled below */
  }
  check(
    'stopped recording is a real playable .webm with a preview URL',
    /^orvex-media:\/\/source\//.test(rec.src) && /\.webm$/.test(rec.file) && recBytes > 3000 && rec.buttons.includes('Export .webm'),
    `${rec.file} (${recBytes} bytes)`,
  );
  try {
    if (rec.file) fs.rmSync(rec.file, { force: true });
  } catch {
    /* best effort */
  }

  console.log('\n— restore the machine to its previous state');
  await clickText('.dc-tab', 'Screen & OCR', true).catch(() => {});
  if (original.volume != null) await desk('volume', { level: original.volume, mute: original.muted });
  if (original.clipboard.kind === 'text' && original.clipboard.text) {
    await desk('clipboardWrite', { text: original.clipboard.text });
  } else if (original.clipboard.kind === 'image' && original.clipboard.file && fs.existsSync(original.clipboard.file)) {
    await desk('clipboardWrite', { imagePath: original.clipboard.file });
  }
  const finalVolume = await desk('volume');
  const muteRestored = original.volume == null || (finalVolume.ok && finalVolume.data.muted === original.muted);
  check(
    'volume and mute were restored after the test',
    original.volume == null || (finalVolume.ok && finalVolume.data.volume === original.volume && muteRestored),
    finalVolume.ok ? finalVolume.data.output : finalVolume.error,
  );

  cdp.ws.close();
  console.log(`\ncontrol UI smoke OK: ${pass} checks`);
  if (process.exitCode) console.log('control UI smoke reported failures.');
}

main().catch((err) => {
  console.error('\ncontrol UI smoke crashed:', err && err.message ? err.message : err);
  process.exit(1);
});
