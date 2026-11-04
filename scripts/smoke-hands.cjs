'use strict';

/**
 * Phase 9 — Hands smoke.
 * Runs the bounded vision-action loop with an injected fake desktop and model so
 * the protocol, stop rules and guardrail approvals are exercised end to end
 * without moving the real mouse.
 */

const hands = require('../electron/hands.cjs');
const desktop = require('../electron/desktop.cjs');
const guardrails = require('../electron/guardrails.cjs');

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function fakeDesktop(overrides = {}) {
  return {
    screenCapture: async () => ({ ok: true, image: 'shot.png' }),
    mouseClick: async () => ({ ok: true, output: 'clicked' }),
    screenClickText: async () => ({ ok: true, output: 'clicked label' }),
    keyType: async () => ({ ok: true, output: 'typed' }),
    keyPress: async () => ({ ok: true, output: 'pressed' }),
    mouseScroll: async () => ({ ok: true, output: 'scrolled' }),
    waitFor: async () => ({ ok: true, output: 'waited' }),
    appLaunch: async () => ({ ok: true, output: 'launched' }),
    ...overrides,
  };
}

(async () => {
  const toolNames = desktop.definitions.map((d) => d.name);
  check('app_list is registered', toolNames.includes('app_list'));
  check('app_launch is registered', toolNames.includes('app_launch'));
  check('screen_find is registered', toolNames.includes('screen_find'));
  check('screen_click_text is registered', toolNames.includes('screen_click_text'));
  check('hands_run is registered', hands.definitions.some((d) => d.name === 'hands_run'));

  check('hands_run asks for approval by default', /mouse, keyboard/.test(hands.approvalReason({ goal: 'open notepad' }) || ''));
  check('app_launch needs approval', !!guardrails.needsApproval('app_launch', { name: 'Notepad' }));
  check('screen_find needs no approval', !guardrails.needsApproval('screen_find', { text: 'Save' }));
  check('approval text names the step budget', /up to 6 steps/.test(hands.approvalReason({ goal: 'open notepad' }) || ''));
  check('approval clamps the step budget', /up to 12 steps/.test(hands.approvalReason({ goal: 'open notepad', maxSteps: 999 }) || ''));

  const events = [];
  hands.init({
    desktop: fakeDesktop(),
    ask: (() => {
      const replies = ['{"action":"click_text","text":"Save"}', '{"action":"type","text":"report.txt"}', '{"action":"done","summary":"saved"}'];
      return async () => replies.shift();
    })(),
    emit: (event) => events.push(event),
    isStopped: () => false,
  });
  const done = await hands.runTask({ goal: 'save a new file', maxSteps: 4 });
  check('a three-step loop completes', done.ok === true && done.completed === true, done.output);
  check('the loop records each step', done.steps.length === 3 && done.steps[0].action === 'click_text' && done.steps[1].action === 'type');
  check('the loop emits live step events', events.filter((event) => event.type === 'step').length === 3);

  hands.init({
    desktop: fakeDesktop({ mouseClick: async () => ({ ok: false, error: 'nothing there' }) }),
    ask: async () => '{"action":"click","x":10,"y":10}',
  });
  const stopped = await hands.runTask({ goal: 'press the button', maxSteps: 6 });
  check('two failed actions stop the loop', stopped.ok === false && stopped.steps.length === 2, stopped.note);

  hands.init({ desktop: fakeDesktop(), ask: async () => '{"action":"format_disk"}' });
  const refused = await hands.runTask({ goal: 'format the disk' });
  check('unknown actions are refused', refused.ok === false && /Unsupported action/.test(refused.error || ''), refused.error);

  hands.init({ desktop: fakeDesktop(), ask: async () => '{"action":"done"}' });
  const controller = new AbortController();
  controller.abort();
  const aborted = await hands.runTask({ goal: 'open notepad', signal: controller.signal });
  check('the stop signal ends the loop', aborted.ok === false && /Stopped by the user/.test(aborted.error || ''), aborted.error);

  hands.init({ desktop: fakeDesktop(), ask: null });
  const noModel = await hands.runTask({ goal: 'open notepad' }).catch((err) => ({ error: err.message }));
  check('no vision model fails honestly', /vision-capable model/.test(noModel.error || ''), noModel.error);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
