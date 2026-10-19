# dev-loop-lite 执行合同

小修与已定位 bug 批次的三阶段流程：`impl` → `verify` → `accept`，复核失败走 `fix → verify`。适用判定与任务分级见 [AGENTS.md 开发循环](../../AGENTS.md#开发循环dev-loop)；完整七节点图见 [dev-loop 执行合同](dev-loop.md)，两者共用同一批质量边界、模型路由与 3 轮复核预算。

## 适用范围

- **走轻流程**：范围明确、单模块、验收能写成一句话的 bug 修复与小功能；同一轮里多个已定位问题做一个连贯候选，不按条拆流水线。
- **走完整图**：新能力、跨模块、边界未清、需要 scout 侦察或需要 spec 的需求。判定写作 L2 及以上时不用本文件。
- 两者都不是：L0 微改（文案、样式）由 lead 直接做，跑 `pnpm run check`，合并前照常 SHA 审。

## 主链与职责

| 步骤 | 路由 | 职责 | 完成判据 |
| --- | --- | --- | --- |
| `impl` | `group/deepseek-v4.1-flash1017` | 独占任务树完成代码、测试、`lib/` 产物与必要文档；先写红测试再实现，跑构建与门禁后自提交 | 提交 SHA + 门禁输出 + 工作区干净 |
| `verify` | `group/glm-5.3-flash` | 独立上下文只读复核候选：Standards 与 Spec 双轴、逐类 revert 变红、核对 `git diff --exit-code -- lib` | `VERDICT: pass` 或 `fail` + 认证清单 |
| `fix` | `group/deepseek-v4.1-flash1017` | 只按 verify 失败项修，收完整失败报告，不顺手扩大范围 | 新 candidate SHA |
| `accept` | `group/deepseek-v4.1-flash1017` | 核对 candidate 等于复核过的 SHA，真实调用验收 | `VERDICT: pass` 或 `fail` + 实测证据 |

- provider 一律 `magpie`，`reasoning_effort` 一律 `high`；执行方式 `subagent`，复用 `auto`。路由不可用标 `BLOCKED`，不换模型、不降强度、不由 lead 代做。
- lead 负责 intake 定级与固化需求、派发、收口与直接答复用户；记录 candidate / reviewed / accepted 三个 SHA 与结论，更新台账。lead 不并发改实施者正在改的公共文件。

## 判定与预算

- 判定词与完整图一致：`VERDICT: pass` / `VERDICT: fail`；无法判定写 `BLOCKED` / `NEED-DECISION`，不写「基本通过」「有条件通过」。
- 复核-返工循环最多 3 轮，计数只读 verify 已完成的判定（pass 与 fail 都算）。第 3 轮仍 fail 时停止逐条修补，退一步重审需求理解或方案。
- 第 2 轮起 verify 只报新增改动里的问题，首轮已通过的部分不重复挑。
- 用户报告的行为冲突（同一改动能有两种合规读法）先停下问用户，给两个具体方案；未答复时该条标待决、继续其它项，不擅自截短或放宽断言。

## 质量边界（不减）

轻流程省的是 scout 侦察、release 收口与 summary 汇总三段，不是质量门。以下照旧：

- worktree 任务分支开发；行为修复逐类做 revert 变红验证，红要指向具体行为。
- 有损取舍（截短输出、抽样替代全量、静默跳过检查）只能列方案交用户批准。
- 测试用替身与夹具；真实网络由独立验收执行。
- 文档同步：行为变化同步 README、DESIGN 与相关 docs；`lib/` 产物随实现提交。
- 真实使用验收：模拟测试不能替代真实调用。

## 产出与证据

- 实施报告一份，首行写实际路由，逐项列出覆盖、candidate SHA、状态与未验证项，末行照旧写 `DONE` / `BLOCKED` / `NEED-DECISION`。
- 每角色报告不超过 40 行，证据按步骤分区存放，保留真实命令与退出码。
- 不写第二份汇总，不新发明复现 CLI。
