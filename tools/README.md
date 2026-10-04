# dsh-answer-reviewer：DSH 0.2.x（session format v4）兼容补丁

> 已整理为独立 fork 仓库：<https://github.com/hh-wu/dsh-answer-reviewer>（private，
> 两个提交 + tag `upstream-0.7.6` / `v0.7.6-dshv4.1`，本目录的脚本与 diff 同步在仓库 `tools/`）。
> 本地工作副本：`D:\Projects\dsh-answer-reviewer`。

**背景**：DSH 桌面端内核 `@deepseek-ai/dsh` 0.2.0-rc.2 把会话存储升级为 **format v4**。
v4 的持久化消息准入要求"producer-owned source kind"，明确拒绝旧 v3 的
`{ kind: 'plugin', plugin: '<name>' }` 包装：

```
SessionFormatError: format v4 message requires a producer-owned source kind
```

`dsh-answer-reviewer` 0.7.6（npm 上最新版）仍然用这个旧包装，而它的"打回"
（steer）走 `agent.steer()` → 提交 `agent/inbox/spliced` 持久事件 → 被 v4 准入拒绝，
于是**整轮运行失败**（UI 显示"本轮运行失败"，并且该会话之后的写入也无法继续）。

补丁把两条注入消息的 source 换成生产者自有 kind `dsh-answer-reviewer`，并修正
`extractUserPrompts()` 对 v4 消息结构的读取。

## 改动清单

| 文件 | 改动 |
|---|---|
| `lib/review.js` | ① review 请求消息 source：`{ kind: 'plugin', plugin: … }` → `{ kind: 'dsh-answer-reviewer', note: 'review-request' }`<br>② steer 消息 source：同上 → `{ kind: 'dsh-answer-reviewer', note: 'steer-<n>/<cap>' }`<br>③ `extractUserPrompts()`：v4 中 `user/message` 的事件 `data` **就是消息本身**（v3 才嵌在 `data.message`）；两种结构都接受，并按内核自己的"真人输入"标记 `source.kind === 'user'` 过滤注入消息 |
| `README.md` | 同步文档中描述的两处 source 语义 |
| `CHANGELOG.md` | 新增本地补丁条目（`0.7.6+dsh-0.2.0-rc.2-local`，标注非 npm 发布内容） |

修改时间：2026-10-04。目标路径：
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-answer-reviewer\`

## 生效方式

插件的 host 端代码在 dsh 进程启动时加载，**必须重启桌面端**（完全退出
DeepSeek Harness 再启动）才会加载打过补丁的 `lib/review.js`。
仅刷新网页 / 重开会话不生效。

重启后可以用插件自带的实时接口确认它还在正常工作：

```powershell
# 最近评审记录（decision 正常为 pass / steer / cap-exhausted，不再出现 turn 失败）
curl.exe -s http://127.0.0.1:3987/api/recent
# 当前配置
curl.exe -s http://127.0.0.1:3987/api/config
```

## 验证

```powershell
node verify-patch.cjs      # 13 项断言：source kind、v4 准入、v4/v3 消息结构、注入过滤
node --check "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-answer-reviewer\lib\review.js"
```

`verify-patch.cjs` 用桩替换掉两个只能在内核里解析的 import，其余代码与插件实际加载的
`lib/review.js` 完全一致（运行时读取该文件）。

## 重新应用 / 撤销

插件被 pnpm 重装（`dsh plugin add/update`、市场更新等）后补丁会丢失，两种恢复方式：

```powershell
# 方式 A：直接重跑补丁脚本（幂等，会重新生成 .orig 备份；用 temp+rename 写入，
#         不会污染 pnpm 的硬链接 store）
node apply-patch.cjs

# 方式 B：用统一 diff（-p1，需在 node_modules 的父目录或等价目录树中执行）
git apply dsh-answer-reviewer-v4-compat.patch
```

撤销：把 `orig\` 下的三个文件覆盖回插件对应路径（或 `git apply -R` 该补丁）。

## 目录内容

```
apply-patch.cjs                       幂等补丁脚本（temp+rename 写入，保护 pnpm store）
verify-patch.cjs                      打补丁后的逻辑验证（13 项断言）
dsh-answer-reviewer-v4-compat.patch   与 orig/ 对照的统一 diff（已用 git apply --check 验证）
orig/lib/review.js                    打补丁前的原始文件
orig/README.md
orig/CHANGELOG.md
```

## 相关但未处理

`dsh-auto-memory` 0.3.0 也在**评审/固化用的 LLM 请求**里用了
`source: { kind: 'plugin', plugin: 'dsh-auto-memory' }`（`lib/index.js:1185`）。
该消息不进会话持久层，目前不会触发 v4 准入；但它的 `peerDependencies` 只声明
`>=0.1.5-rc.2 <0.2.0`，并未声明支持 0.2.x。若以后内核开始校验出站请求的消息 source，
需要同样处理。
