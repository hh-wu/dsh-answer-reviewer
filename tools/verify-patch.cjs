/**
 * Verifies the patched dsh-answer-reviewer helpers without booting a host.
 * The real module imports two packages that only exist inside the DSH
 * installation, so they are stubbed here; everything else is the patched code.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.join(process.env.DSH_REVIEWER_DIR || path.join(require('os').homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-answer-reviewer'), 'lib', 'review.js')
let src = fs.readFileSync(SRC, 'utf8');
const before = src;
src = src.replace(
  "import { createUserMessage } from '@deepseek-ai/dsh-llm'",
  "const createUserMessage = (message) => Object.freeze({ id: 'stub-msg', role: 'user', ...message })",
);
src = src.replace(
  "import z from '@deepseek-ai/schemastery'",
  "const chain = () => { const o = {}; o.default = () => o; o.optional = () => o; o.required = () => o; return o }\nconst z = { object: (shape) => shape, boolean: chain, number: chain, string: chain }",
);
if (src === before) throw new Error('import stubs did not apply — module header changed?');

const tmp = path.join(os.tmpdir(), 'review-patched-' + process.pid + '.mjs');
fs.writeFileSync(tmp, src, 'utf8');

const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
  if (!cond) failures.push(name);
}

/** Session-format v4 durable-message admission, transcribed from the core:
 *  `source()` requires a nonempty string kind other than 'plugin', and the
 *  row-level check only calls it when `kind === 'plugin'`. */
const v4Admits = (message) => {
  const value = message && message.source;
  return !!(value && typeof value === 'object' && typeof value.kind === 'string'
    && value.kind.length > 0 && value.kind !== 'plugin');
};
const v4RowRefuses = (message) => {
  const value = message && message.source;
  return !!(value && typeof value === 'object' && value.kind === 'plugin');
};

(async () => {
  const mod = await import('file:///' + tmp.replace(/\\/g, '/'));

  const steer = mod.buildSteerMessage({ score: 68, reason: 'stopped before the comparison', attempt: 1, maxAttempts: 5 });
  check('steer source is producer-owned', steer.source.kind === 'dsh-answer-reviewer', JSON.stringify(steer.source));
  check('steer source dropped the legacy plugin field', !('plugin' in steer.source));
  check('steer passes v4 source admission', v4Admits(steer));
  check('steer no longer trips the row refusal', v4RowRefuses(steer) === false);
  check('steer body still instructs the agent', /scored your previous reply 68\/100/.test(steer.content[0].text));
  check('steer note keeps retry coordinates', steer.source.note === 'steer-1/5');

  const request = mod.buildReviewPrompt({ userPrompts: 'Q', assistantText: 'A', threshold: 80 });
  check('review-request source is producer-owned', request.messages[0].source.kind === 'dsh-answer-reviewer', JSON.stringify(request.messages[0].source));
  check('review-request passes v4 source admission', v4Admits(request.messages[0]));

  const humanV4 = { type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'Q1' }] } };
  const humanV3 = { type: 'user/message', data: { id: 'u2', source: { kind: 'user' }, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Q2' }] } } };
  const steerEvent = { type: 'user/message', data: { id: 'u3', role: 'user', source: steer.source, content: [{ type: 'text', text: 'reviewer feedback' }] } };
  const legacyPlugin = { type: 'user/message', data: { id: 'u4', role: 'user', source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: 'injected' }] } };
  const relayed = { type: 'user/message', data: { id: 'u5', role: 'user', source: { kind: 'agent-message', form: 'relay' }, content: [{ type: 'text', text: 'subagent note' }] } };

  const prompts = mod.extractUserPrompts([humanV4, steerEvent, humanV3, legacyPlugin, relayed]);
  check('extractUserPrompts reads the v4 shape', prompts !== null && prompts.includes('Q1'));
  check('extractUserPrompts still reads the nested shape', prompts !== null && prompts.includes('Q2'));
  check('extractUserPrompts skips this plugin\'s own steer', !/reviewer feedback/.test(prompts || ''));
  check('extractUserPrompts skips other injections', !/injected|subagent note/.test(prompts || ''));
  check('extractUserPrompts returns null when nothing is human', mod.extractUserPrompts([steerEvent, legacyPlugin, relayed]) === null);

  fs.unlinkSync(tmp);
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : '\nFAILURES: ' + failures.join('; '));
  process.exitCode = failures.length === 0 ? 0 : 1;
})();
