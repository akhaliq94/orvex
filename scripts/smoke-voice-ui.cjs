'use strict';

/**
 * Section 5 Voice UI smoke test over CDP.
 * Verifies the page renders every voice surface (device manager, wake word,
 * streaming, barge-in, speaker ID), settings persist through the shared config,
 * a session reaches a real state (listening or an honest mic error), and
 * speaker profiles can be stored and deleted.
 */

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
  const events = [];
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.method) events.push(data);
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
  return { ws, send, ready, events };
}

let pass = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target — is the ORVEX window open?');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result.value;
  };
  const until = async (expression, timeoutMs, label) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = await evaluate(expression);
      if (v) return v;
      await sleep(300);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const gotoVoice = () =>
    evaluate(`(() => {
      const item = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('Voice'));
      if (item) item.click();
      return !!item;
    })()`);

  /* ---------------------------------------------------------- initial page */
  await gotoVoice();
  await until(`document.querySelector('.page-title')?.textContent === 'Voice'`, 10000, 'the Voice page');

  const shell = await evaluate(`(() => {
    const title = document.querySelector('.page-title')?.textContent;
    const cards = [...document.querySelectorAll('.voice-card')].map((c) => c.getAttribute('aria-label'));
    const main = [...document.querySelectorAll('.voice-main-btn')].map((b) => b.textContent.trim());
    const micSelect = !!document.querySelector('select[aria-label="Microphone device"]');
    const deviceNote = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Microphone')?.innerText || '';
    const speakerText = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Speaker ID')?.innerText || '';
    const wakeText = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Wake word')?.innerText || '';
    return {
      title,
      cards,
      main,
      micSelect,
      deviceNote,
      speakerText,
      wakeText,
      chip: document.querySelector('.voice-chip')?.textContent || '',
      hasMeter: !!document.querySelector('.voice-meter-fill'),
    };
  })()`);

  check('Voice page opens from the sidebar', shell.title === 'Voice');
  check(
    'device manager, wake, streaming, barge-in and speaker ID panels render',
    ['Microphone', 'Wake word', 'Streaming transcription', 'Barge-in', 'Speaker ID'].every((n) => shell.cards.includes(n)),
    shell.cards.join(', '),
  );
  check('microphone picker and processing flags render', shell.micSelect && /Echo cancel/.test(shell.deviceNote) && /Noise suppress/.test(shell.deviceNote));
  check(
    'device card reports real inputs or an explicit no-mic state',
    /input|none/i.test(shell.deviceNote) && (/No microphone/.test(shell.deviceNote) || /Hot-plug is watched/.test(shell.deviceNote)),
    shell.deviceNote.replace(/\s+/g, ' ').slice(0, 160),
  );
  check('wake card states the transcription requirement', /transcript|phrase/i.test(shell.wakeText), shell.wakeText.replace(/\s+/g, ' ').slice(0, 160));
  check('speaker card explains the fingerprint limits', /mel bands|fingerprint/i.test(shell.speakerText));
  check('orb, meter and session button render', shell.hasMeter && shell.main.some((t) => /Start voice session/.test(t)), shell.main.join(', '));

  /* ------------------------------------------------------- config writes */
  const cfg0 = await evaluate(`JSON.parse(localStorage.getItem('orvex-voice-config') || '{}')`);
  check('voice config already carries the new fields', cfg0.wakePhrase === 'Hey Orvex' && cfg0.streaming === true && cfg0.speakerId === false, JSON.stringify({ wake: cfg0.wakePhrase, streaming: cfg0.streaming, speakerId: cfg0.speakerId }));

  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Streaming transcription');
    const box = card.querySelector('input[type=checkbox]');
    box.click();
    return box.checked;
  })()`);
  await sleep(250);
  const cfgStream = await evaluate(`JSON.parse(localStorage.getItem('orvex-voice-config') || '{}').streaming`);
  check('streaming toggle persists to the shared config', cfgStream === false, String(cfgStream));

  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Barge-in');
    const box = card.querySelector('input[type=checkbox]');
    box.click();
    return box.checked;
  })()`);
  await sleep(250);
  const cfgBarge = await evaluate(`JSON.parse(localStorage.getItem('orvex-voice-config') || '{}').bargeIn`);
  check('barge-in toggle persists', cfgBarge === false, String(cfgBarge));

  const phrase = await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Wake phrase"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Hello Computer');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await sleep(250);
  const cfgPhrase = await evaluate(`JSON.parse(localStorage.getItem('orvex-voice-config') || '{}').wakePhrase`);
  check('wake phrase is editable and persisted', phrase === 'Hello Computer' && cfgPhrase === 'Hello Computer', String(cfgPhrase));

  // restore the edited settings for the rest of the run / future launches
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Streaming transcription');
    card.querySelector('input[type=checkbox]').click();
    const barge = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Barge-in');
    barge.querySelector('input[type=checkbox]').click();
    const input = document.querySelector('input[aria-label="Wake phrase"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Hey Orvex');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(250);

  /* -------------------------------------------------------- real session */
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.voice-main-btn')].find((x) => /Start voice session|Stop session/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  const session = await until(
    `(() => {
      const label = document.querySelector('.voice-main-btn')?.textContent?.trim() || '';
      const status = document.querySelector('.voice-status-line')?.textContent?.trim() || '';
      const error = document.querySelector('.voice-chip.bad')?.title || '';
      const settled = /Listening — speak now|Hearing:/.test(status) || /No microphone|blocked|Could not start/i.test(status + error);
      return settled ? label + ' :: ' + status + ' :: ' + error : '';
    })()`,
    20000,
    'the microphone result',
  );
  const liveSession = /Stop session/.test(session) && /Listening — speak now|Hearing:|No microphone|blocked|Could not start/i.test(session);
  const honestDeviceState = /Start voice session/.test(session) && /No microphone|blocked|Could not start/i.test(session);
  check('a session reaches a real state instead of a simulation', liveSession || honestDeviceState, session.replace(/\s+/g, ' ').slice(0, 200));
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.voice-main-btn')].find((x) => /Stop session/.test(x.textContent));
    if (b) b.click();
  })()`);

  /* ------------------------------------------------------ wake arming */
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Wake word');
    const box = card.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    return box.checked;
  })()`);
  const armed = await until(
    `(() => {
      const card = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Wake word');
      const chip = card?.querySelector('.voice-chip')?.textContent || '';
      const status = document.querySelector('.voice-status-line')?.textContent || '';
      const deviceProblem = /No microphone|blocked|Could not start/i.test(status + (card?.innerText || ''));
      const chipped = /armed|needs STT/.test(chip) || (/needs session/.test(chip) && deviceProblem);
      const settled = /Listening/.test(status) || deviceProblem || /needs STT/.test(chip);
      return chipped && settled ? chip : '';
    })()`,
    15000,
    'the wake arm state',
  );
  check('enabling the wake word arms the gate or reports the missing STT service', /armed|needs STT|needs session/.test(armed), armed.slice(0, 80));
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.voice-card')].find((c) => c.getAttribute('aria-label') === 'Wake word');
    const box = card.querySelector('input[type=checkbox]');
    if (box.checked) box.click();
    const b = [...document.querySelectorAll('.voice-main-btn')].find((x) => /Stop session/.test(x.textContent));
    if (b) b.click();
    return true;
  })()`);
  await sleep(250);
  const wakeOff = await evaluate(`JSON.parse(localStorage.getItem('orvex-voice-config') || '{}').wakeEnabled`);
  check('disabling the wake word persists', wakeOff === false, String(wakeOff));

  /* -------------------------------------------------- speaker profile UI */
  await evaluate(`(() => {
    localStorage.setItem('orvex-speaker-profiles', JSON.stringify([{
      id: 'spk-smoke', name: 'Smoke Voice', vector: [${Array.from({ length: 50 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}], createdAt: Date.now(), clips: 1
    }]));
    return true;
  })()`);
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === 'Home');
    if (item) item.click();
    return !!item;
  })()`);
  await sleep(300);
  await gotoVoice();
  await until(`document.querySelector('.page-title')?.textContent === 'Voice'`, 10000, 'the Voice page again');
  const profileRow = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.voice-profile')].find((r) => r.textContent.includes('Smoke Voice'));
    return row ? row.textContent : '';
  })()`);
  check('enrolled speaker profiles render from storage', /Smoke Voice/.test(profileRow), profileRow.replace(/\s+/g, ' ').slice(0, 120));

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.voice-profile')].find((r) => r.textContent.includes('Smoke Voice'));
    row?.querySelector('button')?.click();
    return !!row;
  })()`);
  await sleep(250);
  const remaining = await evaluate(`JSON.parse(localStorage.getItem('orvex-speaker-profiles') || '[]').length`);
  check('deleting a profile removes it from storage', remaining === 0, String(remaining));

  const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check('no uncaught renderer exceptions', exceptions.length === 0, exceptions.map((e) => e.params?.exceptionDetails?.text).join(' | ').slice(0, 200));

  console.log(`voice UI smoke OK: ${pass} checks`);
  cdp.ws.close();
}

main().catch((err) => {
  console.error('voice UI smoke FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
