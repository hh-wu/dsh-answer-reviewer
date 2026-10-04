# Fork notes — session-format-v4 compatibility fix

This repository is a **local fork of [`dsh-answer-reviewer`](https://github.com/bycall/dsh-answer-reviewer)
0.7.6** (MIT) carrying one compatibility fix for DSH core `@deepseek-ai/dsh` **0.2.x**,
whose session storage is **format v4** (validated on `0.2.0-rc.2`, DSH desktop nightly
build of 2026-10-04, Node 24.21.0).

## Symptom

On 0.2.x every turn that the reviewer wants to challenge dies with:

```
本轮运行失败  format v4 message requires a producer-owned source kind
```

and the session stops persisting anything after that point — subsequent turns keep
failing with the same message even though the transcript still shows the answer text.

## Root cause

1. Session format v4 admits only **producer-owned message source kinds** on durable
   messages. The retired v3 wrapper `{ kind: 'plugin', plugin: '<name>' }` is refused
   (`SessionFormatError: format v4 message requires a producer-owned source kind`;
   the message is raised by the v4 admission stage and only for `kind === 'plugin'`).
2. This plugin injected both of its messages with that retired wrapper, and the steer
   goes through `agent.steer()`, which commits a durable `agent/inbox/spliced` event.
   The refused write aborts the whole turn instead of delivering the feedback, and it
   leaves the session's write path unusable — which is why the failure repeats.

Measured on the affected session (before the fix): the final assistant text and the
`workspace/changes` row were persisted at `12:01:12Z`; the reviewer scored that reply
68 (< threshold 80) and steered at `12:01:15Z`; **the session file was never written
again** and its last turn has no `turn/end`.

## Changes

| File | Change |
|---|---|
| `lib/review.js` | `buildSteerMessage()` — the steer message and the review-request message now use the producer-owned kind `{ kind: 'dsh-answer-reviewer', note: … }` instead of `{ kind: 'plugin', plugin: … }`. |
| `lib/review.js` | `extractUserPrompts()` — format v4 stores a `user/message` event's message **directly on `data`** (v3 nested it under `data.message`), so `<all_user_prompts>` was always empty on 0.2.x and the reviewer graded replies without the user's question. Both shapes are now accepted, and real prompts are selected by the host's own marker `source.kind === 'user'` instead of "not `'plugin'`". |
| `README.md`, `CHANGELOG.md` | Documentation / changelog for the above. |

No behavioural change beyond the fix: injected messages are still not treated as human
input (`isHumanInstruction` requires `source.kind === 'user'` plus an `rpcId`), and the
score chip / config surfaces are untouched.

## Verification

* `node --check lib/review.js`
* `node tools/verify-patch.cjs` — 13 assertions: producer-owned source kind, v4
  admission predicate, v4 **and** v3 user-message shapes, and filtering of injected
  messages (steer, other plugins, subagent notices). All pass.
* The unified diff in `tools/` was validated with `git apply --check` against pristine
  0.7.6 files.

## Install into a DSH profile

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-answer-reviewer": "file:D:/Projects/dsh-answer-reviewer"
  },
  "dsh": { "profile": { "bundles": ["…", "dsh-answer-reviewer"] } }
}
```

Then reinstall the profile and **restart the host**: plugin host code is only loaded
when the `dsh` process starts — refreshing the web UI is not enough.

### Or keep the npm dependency and let pnpm apply the fix (recommended)

Swapping the dependency changes how the profile resolves the plugin's peer dependencies,
so the DSH desktop profile instead keeps `"dsh-answer-reviewer": "0.7.6"` and re-applies
this fork's `lib/review.js` change on **every** install through pnpm's
`patchedDependencies`:

```yaml
# ~/.dsh/profiles/<profile>/pnpm-workspace.yaml  (pnpm >= 10; older pnpm: package.json -> pnpm.patchedDependencies)
patchedDependencies:
  dsh-answer-reviewer@0.7.6: patches/dsh-answer-reviewer@0.7.6.patch
```

The patch file is this repository's change with package-root-relative paths (`a/lib/review.js`);
a copy lives in [`tools/pnpm-patch/`](tools/pnpm-patch). After `pnpm install` the lockfile
records `dsh-answer-reviewer@0.7.6(patch_hash=…)`, so a plugin update or reinstall cannot
silently drop the fix.

Verified with pnpm 11.7.0 (`nodeLinker: hoisted`) via `pnpm install --offline`: the
installed `lib/review.js` is byte-identical to this repository and the assertion suite
passes against the installed copy. Restart the host afterwards.

## Upstream

The minimal, upstream-facing change is on the `fix/v4-producer-owned-source` branch
(2 files: `lib/review.js` + `README.md`, no fork plumbing, no changelog/version churn).

## Maintenance

* `tools/apply-patch.cjs` — idempotent script that re-applies this fix directly to an
  installed copy (`%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-answer-reviewer`),
  e.g. after the profile re-installed the plugin from npm. Writes through
  temp-file + rename, so pnpm's hard-linked store is not corrupted.
* `tools/dsh-answer-reviewer-v4-compat.patch` — the same change as a unified diff
  (`git apply -p1`).
* `tools/orig/` — the pristine 0.7.6 files this fork started from.
* To rebase on a newer upstream release: take the upstream tag/package, re-apply the
  three edits (the `kind` change is two lines; the `extractUserPrompts` change is one
  function), then re-run `tools/verify-patch.cjs`.

Kept for reference: if upstream (`bycall/dsh-answer-reviewer`) ships the same fix, drop
this fork and go back to the npm release.

## 中文摘要

DSH 0.2.x 的会话格式 v4 只接受 producer-owned 的 message source kind，本插件 0.7.6 仍用
旧 v3 的 `{ kind: 'plugin', plugin: … }`；它的「打回」经 `agent.steer()` 写成
`agent/inbox/spliced` 持久事件 → 被 v4 拒绝 → 整轮运行失败，且该会话之后的写入全部失败。
本 fork 把两条注入消息改成 `{ kind: 'dsh-answer-reviewer', … }`，并修正
`extractUserPrompts()`（v4 里 `user/message` 的消息直接挂在 `data` 上，原来读
`data.message`，所以评审一直拿不到用户提问）。改完**必须重启 DSH 进程**才生效。
