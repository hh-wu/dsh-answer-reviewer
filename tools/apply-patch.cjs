/**
 * Local V4-compatibility patch for the dsh-answer-reviewer plugin.
 *
 * Root cause: the plugin injects durable user messages with the retired
 * session-format-v3 wrapper `{ kind: 'plugin', plugin: 'dsh-answer-reviewer' }`.
 * DSH core 0.2.0-rc.2 writes sessions as format v4, whose durable-message
 * admission refuses `kind === 'plugin'`:
 *   SessionFormatError: format v4 message requires a producer-owned source kind
 * `agent.steer()` commits an `agent/inbox/spliced` event, so the refusal aborts
 * the whole turn and the session can no longer persist.
 *
 * NOTE ON pnpm: files in node_modules are hard links into the pnpm store, so
 * every write here is temp-file + rename (which breaks the link) rather than an
 * in-place overwrite that would corrupt the shared store.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.DSH_REVIEWER_DIR || path.join(require('os').homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-answer-reviewer')
const results = [];

function patchFile(rel, edits) {
  const file = path.join(ROOT, rel);
  let text = fs.readFileSync(file, 'utf8');
  const original = text;
  const applied = [];
  for (const { name, old: oldText, new: newText } of edits) {
    const hasOld = text.includes(oldText);
    const hasNew = text.includes(newText);
    if (!hasOld && hasNew) { applied.push(name + ': already patched'); continue; }
    if (!hasOld) throw new Error(`${rel}: anchor not found for ${name}`);
    const count = text.split(oldText).length - 1;
    if (count !== 1) throw new Error(`${rel}: anchor for ${name} matched ${count} times`);
    text = text.replace(oldText, newText);
    applied.push(name + ': patched');
  }
  if (text === original) {
    results.push({ rel, changed: false, applied });
    return;
  }
  const backup = file + '.orig';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file); // breaks the pnpm hard link; store stays intact
  results.push({ rel, changed: true, applied });
}

// ---------------------------------------------------------------- review.js
patchFile('lib\\review.js', [
  {
    name: 'module doc (context source rule)',
    old: ` * Conversation context the review model sees:
 *   * Every \`user/message\` event with \`source.kind\` other than \`'plugin'\`
 *     (i.e. real user prompts, not dsh-context-injected reminders).`,
    new: ` * Conversation context the review model sees:
 *   * Every \`user/message\` event whose \`source.kind\` is \`'user'\` — the
 *     host's own marker for typed human input. Plugin-injected messages
 *     carry their own producer-owned kind and are filtered out.`,
  },
  {
    name: 'PLUGIN_NAME doc',
    old: `/** Plugin namespace used for \`user/message.source.plugin\` on steer input. */
export const PLUGIN_NAME = 'dsh-answer-reviewer'`,
    new: `/**
 * Producer-owned message source kind for every message this plugin injects
 * (the review request and every steer).
 *
 * Session format v4 refuses the retired \`{ kind: 'plugin', plugin: <name> }\`
 * wrapper on durable messages ("format v4 message requires a producer-owned
 * source kind"). Because \`agent.steer()\` commits an \`agent/inbox/spliced\`
 * event, that wrapper used to abort the whole turn instead of delivering the
 * feedback, and the failed write left the session unable to persist.
 */
export const PLUGIN_NAME = 'dsh-answer-reviewer'`,
  },
  {
    name: 'extractUserPrompts (v4 shape + human-only filter)',
    old: `/**
 * Extract every real (non-plugin) \`user/message\` event from the session,
 * concatenated as plain text. Plugin-injected context (file-change
 * notices, AGENTS.md, skill content, system reminders) is filtered out
 * so the review model only sees prompts the actual user typed.
 * @param events - raw events from \`Session.snapshotEvents()\` / \`Session.events\`.
 * @returns concatenated user prompts, or \`null\` if no real prompts were issued.
 */
export function extractUserPrompts(events) {
  if (!Array.isArray(events)) return null
  const parts = []
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    const data = event.data
    if (!data || !data.source || data.source.kind === 'plugin') continue
    const message = data.message
    if (!message || !Array.isArray(message.content)) continue
    const text = concatTextBlocks(message.content)
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return null
  return parts.join('\\n\\n---\\n\\n')
}`,
    new: `/**
 * Extract every real human \`user/message\` event from the session,
 * concatenated as plain text. Only \`source.kind === 'user'\` counts — the
 * host's own marker for typed input — so plugin-injected context
 * (file-change notices, AGENTS.md, skill content, system reminders, this
 * plugin's own steers) is filtered out and the review model only sees
 * prompts the actual user typed.
 *
 * Session format v4 stores the message directly on \`data\`; released v3
 * nested it under \`data.message\`. Both shapes are accepted so a host
 * upgrade cannot silently drop every prompt.
 * @param events - raw events from \`Session.snapshotEvents()\` / \`Session.events\`.
 * @returns concatenated user prompts, or \`null\` if no real prompts were issued.
 */
export function extractUserPrompts(events) {
  if (!Array.isArray(events)) return null
  const parts = []
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    const data = event.data
    if (!data || typeof data !== 'object') continue
    const message = data.message !== undefined ? data.message : data
    if (!message || !message.source || message.source.kind !== 'user') continue
    if (!Array.isArray(message.content)) continue
    const text = concatTextBlocks(message.content)
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return null
  return parts.join('\\n\\n---\\n\\n')
}`,
  },
  {
    name: 'review-request message source',
    old: `      source: { kind: 'plugin', plugin: PLUGIN_NAME, note: 'review-request' },`,
    new: `      source: { kind: PLUGIN_NAME, note: 'review-request' },`,
  },
  {
    name: 'buildSteerMessage doc',
    old: ` * Compose the user-facing steer message injected back into the conversation
 * when the review model's score is below the threshold. Capped by the
 * per-turn challenge counter enforced by the caller; this helper only
 * formats the prose.`,
    new: ` * Compose the user-facing steer message injected back into the conversation
 * when the review model's score is below the threshold. Capped by the
 * per-turn challenge counter enforced by the caller; this helper only
 * formats the prose.
 *
 * The source kind is producer-owned (\`PLUGIN_NAME\`), never \`'plugin'\`:
 * \`agent.steer()\` commits a durable \`agent/inbox/spliced\` event and session
 * format v4 refuses the legacy plugin wrapper there.`,
  },
  {
    name: 'steer message source',
    old: `    source: { kind: 'plugin', plugin: PLUGIN_NAME, note: \`steer-\${safeAttempt}/\${safeCap}\` },`,
    new: `    source: { kind: PLUGIN_NAME, note: \`steer-\${safeAttempt}/\${safeCap}\` },`,
  },
]);

// ----------------------------------------------------------------- README.md
patchFile('README.md', [
  {
    name: 'README: real-prompt rule',
    old: `The review model sees **every real user prompt** the user has issued in
the session (any \`user/message\` event whose \`source.kind\` is not
\`'plugin'\`), tagged \`<all_user_prompts>\`, plus the assistant's final`,
    new: `The review model sees **every real user prompt** the user has issued in
the session (any \`user/message\` event whose \`source.kind\` is \`'user'\`,
the host's marker for typed input), tagged \`<all_user_prompts>\`, plus
the assistant's final`,
  },
  {
    name: 'README: steer source kind',
    old: `that the agent never sees directly. The findings are injected back as a
\`user/message\` with \`source: { kind: 'plugin', plugin:
'dsh-answer-reviewer' }\`, so the agent treats them as user input — but`,
    new: `that the agent never sees directly. The findings are injected back as a
\`user/message\` with the producer-owned source
\`{ kind: 'dsh-answer-reviewer', note: 'steer-<n>/<cap>' }\`, so the agent
treats them as user input — but`,
  },
]);

// -------------------------------------------------------------- CHANGELOG.md
patchFile('CHANGELOG.md', [
  {
    name: 'CHANGELOG: local patch entry',
    old: `## 0.7.6 — 2026-09-29`,
    new: `## 0.7.6+dsh-0.2.0-rc.2-local — 2026-10-04 (local patch, not published to npm)

### Fixed

- **Session format v4 refused every injected message.** Both messages this
  plugin creates carried the retired v3 wrapper
  \`source: { kind: 'plugin', plugin: 'dsh-answer-reviewer' }\`. DSH
  \`@deepseek-ai/dsh\` 0.2.0-rc.2 writes sessions as format v4, whose durable
  message admission rejects any \`kind === 'plugin'\` with
  \`SessionFormatError: format v4 message requires a producer-owned source
  kind\`. The steer goes through \`agent.steer()\`, which commits an
  \`agent/inbox/spliced\` event, so the rejection aborted the entire turn
  (\"本轮运行失败\") instead of delivering the feedback — and the aborted write
  left that session unable to persist any further turn. Both messages now use
  the producer-owned kind \`dsh-answer-reviewer\`.
- **\`extractUserPrompts\` read the pre-v4 message shape.** In format v4 a
  \`user/message\` event carries the message directly on \`data\`; the plugin
  read \`data.message\`, so \`<all_user_prompts>\` was always empty on 0.2.x and
  the reviewer graded replies without the user's question. It now accepts both
  shapes and selects real prompts by the host's own marker
  \`source.kind === 'user'\` instead of \"not \`'plugin'\`\".

## 0.7.6 — 2026-09-29`,
  },
]);

for (const r of results) {
  console.log((r.changed ? 'PATCHED ' : 'UNCHANGED ') + r.rel);
  for (const a of r.applied) console.log('   - ' + a);
}
