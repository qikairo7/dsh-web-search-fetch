# dev-loop 执行合同

`dev-loop` 工作流图的执行细则：主链、状态、复核预算、派发输入、各步职责、产出与证据、案例。节点模型路由以 [AGENTS.md 模型路由](../../AGENTS.md#模型路由严格分工) 为唯一来源，本文件不重复。

## 路由与主链

- 七个固定节点：`scout`、`impl`、`fix`、`verify`、`accept`（使用验收）、`release`、`summary`。
- 主链：`scout → impl → verify(pass) → accept(pass) → release → summary`。
- `verify` fail 或 `accept` fail：`fix → verify`，verify 通过后重新 `accept`。
- 每个节点按 AGENTS 路由表派发，provider 一律 `magpie`、`reasoning_effort` 一律 `high`。路由不可用时节点标 `BLOCKED`，不换模型、不降强度、不由 lead 代跑。
- 通用工作流模板里的「lead 代跑」「失败无限重试」等说明与本节冲突时，服从固定路由与停止规则。

## 状态与判定

- 判定完成时只用 `VERDICT: pass` 与 `VERDICT: fail`，verify 与 accept 共用。无法完成判定时写 `BLOCKED` 或 `NEED-DECISION`，不伪造 verdict；不写「基本通过」「有条件通过」。
- 成功完成一次质量判定（无论结论 pass 还是 fail）都记节点 `done` + 对应 verdict，条件边才能据此选择；普通节点只有成功完成才 `done`。无法完成执行的异常才记 `failed`；`BLOCKED`（缺基础设施）、`NEED-DECISION`（需用户拍板）或输入缺失时，节点与整体置 `waiting`，不伪造 verdict，不前推下游。
- 第 3 轮仍 fail：保留该次节点 `done` + `VERDICT: fail` 及其证据，同时整体 `waiting` 阻止下一步；每个已完成的判定只记一次、事后不改写，预算计数以 verify 节点 `summary` 里的 `qualityCount` 为准（见下节）。本口径优先于「只有成功才能 done」的简写。
- 基础设施缺失（路由不可用、依赖装不上、工具缺失）与代码质量 fail 分开记录：前者写清需要什么条件才能继续，后者附失败证据；两类都不能记成成功。
- `workflow_lite` 的 state / resume 返回的官方运行状态是唯一进度源；进度只能由这些正式工具记录，不直接读写内部状态文件（不猜文件名与格式）。lead 记录节点状态、轮次、`outputs`、执行者/路由与 verify 的预算字段；子代理不直接写 state。派发前先检查整体状态：`waiting/failed/cancelled/done` 时不派发。`next` 只是候选，不能覆盖整体状态或预算限制。

## 质量复核预算

计数只从 verify 节点在官方 `summary` 里的结构化字段读，不从历史流水或 `node.round` 反推。字段由 lead 维护：

```
qualityCount=<已完成质量判定数>; lastDecision=R<官方轮次>@<完整candidateSHA>; report=history/verify/R<官方轮次>.md
```

- `qualityCount` 是 verify **已完成判定**的次数（pass 与 fail 都算），与 state 的调用轮次 `node.round` 分开；`node.round` 含中断重做，不能当预算用。
- 初始化只对确认新建、verify 从未执行（`status=pending` 且 round 尚未产生或为 0）的实例置 `qualityCount=0; lastDecision=none; report=none`。旧实例缺字段、字段损坏或无法对账：整体 `waiting` 并标 `BLOCKED`，保留已有判定，不猜、不默认归零。
- 每次回报先匹配当前派发的官方调用 `round` 与 `candidateSHA`；`decisionId` 中的 R 后是调用轮次，不能用 `qualityCount` 代替。迟到回报不匹配当前派发时，只记迟到信息，不改当前节点状态与计数。
- 读完整本轮 `history/verify/R<round>.md`。当前有效新判定的 `decisionId` 不同于 `lastDecision` 才 `qualityCount+1`；相同 id 仅在 verdict 与报告内容一致时作无操作重报。相反结论、报告冲突或无法对账时整体 `waiting` + `BLOCKED`，不覆盖原判定、计数或历史。
- 同一次 `state` 调用写 `done` + `verdict` + 新 `qualityCount`/`lastDecision` + `outputs`；第 3 次 fail 时同一次调用把整体置 `waiting`，崩溃前后不会重复计数。
- verify 重新 `running`（含中断重做）保留这份 summary，不清空、不递增；`BLOCKED`、`NEED-DECISION`、运行异常不加计数。
- `qualityCount>=3` 后不再派新的 verify 或 fix；第 3 次 verify pass 仍可进 accept/release。
- 结构化字段不被后续自由文字覆盖，简短说明只能附在字段之后，整条 summary ≤ 200 字。

例：调用 R1 完成 fail → `qualityCount=1; lastDecision=R1@<sha1>`；调用 R2 中断且未判定，计数不变；调用 R3 完成 pass → `qualityCount=2; lastDecision=R3@<sha2>`；同一调用的相同报告重报仍为 2。调用 R4 完成第 3 次判定且 fail → `qualityCount=3; lastDecision=R4@<sha3>`，同时整体 `waiting`。3 次 verify pass 之后 accept 仍 fail：同样整体 `waiting`，不派 fix、不进 release。工具只保存字段，计数、幂等与停止由 lead 执行，不由工具强制。

## lead 派发输入

编译前由 lead 准备完整需求输入。用户提供目标和验收要求；可查询的路径、分支、SHA 等事实由 lead 查证补齐，不要求用户手查。画布已生成实例时，lead 在首次派发前补齐同样的事实并记入官方状态流水：

- 已澄清的需求与验收标准、任务等级、`taskWorktree` / `branch` / `baseSHA`。
- 已批准方案的证据与 spec 来源；无 spec 时写清原因。L2+ 无批准 spec 不得实施。

`scout` 把用户需求与 lead 查证的输入忠实固化到实例 `contract.md`，注明各自来源，并产出 `scout.md`；lead 对照原始输入核对后才推进 `impl`。需求、验收标准与已批准 spec 的原文完整保存在合同附录，记录 spec 来源与版本或 SHA256；附录不受报告行数上限截断。下游以实例内快照为准，外部来源变化不能静默改变本实例需求。

- 合同创建后不可变。中断重做按合同核对，不覆盖既有合同。
- 范围、验收或风险变化：暂停 → 用户决定 → 开新实例、绑定新合同；旧实例保留原合同与最终状态。
- 需求与合同用实例内文件，不依赖共享 `.scratch/spec.md`；两者连到需要它们的节点。

## 派发参数

每次派发（含重试）的任务描述写明：实例 id、调用轮次、`baseSHA`、`candidateSHA`、`prevReviewedSHA`、`taskWorktree`、`verifyWorktree`、最新报告路径。`baseSHA` 是 intake 确认并固化在合同中的起始提交，不能随任务 HEAD 前移。实施前候选尚未产生，明确写「尚未产生」且 `inputSHA = baseSHA`；首轮 `prevReviewedSHA` 写「不适用」。verify 输入必须提供真实候选，本次 `reviewedSHA` 在完成判定后产生；accept/release 必须给真实候选及对应 verify PASS 的受审 SHA。后续核对 HEAD 应对最新候选，不要求仍等于 `baseSHA`。

- 首轮尚无 fix/accept 报告写「不适用」；运行过但报告丢失属缺陷，找回或标 `waiting`，不能静默忽略。
- `fix` 必须收到 `failure_source` 与完整的 verify/accept 失败报告（路径 + 逐项失败），不能只给结论。

修复后的 verify 锁定最新 candidate（`fix.outputSHA`，不是 `impl` 旧 SHA）。首轮审 `base..candidate`；后续轮次重点审新增 diff、未决项与回归。

## 各步职责

| 步骤 | 职责 | 完成判据 |
| --- | --- | --- |
| `impl` / `fix` | 在独占任务树完成全部代码、测试、`lib/` 产物及必要文档同步；先构建、跑既有门禁与所需红绿验证，再自提交。涉及 `src/` / `lib/` 时按贡献指南暂存产物并检查分发 | 提交 SHA + 提交前门禁输出 + 工作区干净证据 |
| `verify` | 在 lead 准备的独立验证副本审查；构建后先检查 `git diff --exit-code -- lib`，产物差异须记录失败；再做所需 revert 红绿并恢复，核对 SHA 与状态；不改任务分支 | 判定完成后 `VERDICT: pass` 或 `VERDICT: fail` + 认证清单；未能执行必需验证则 `BLOCKED` |
| `accept`（使用验收） | 核对 candidate 等于 verify PASS 的 SHA，真实加载的版本与之一致；记录验收前后的任务 HEAD 与工作区状态 | `VERDICT: pass` 或 `fail` + 实测证据 |
| `release` | 不改仓库文档、不提交；核对 HEAD = candidate = reviewed = accepted 且任务树干净；更新指定长期台账、写报告、整理外发草稿 | 四项 SHA 一致 + 台账更新 |
| `summary` | 分别报告 candidate / reviewed / accepted 三个 SHA 与判定来源，不合并成一个「最终受审」SHA | 三 SHA 与结果分列 |

`release` 发现需要补文档或补代码：标 `BLOCKED`，由 lead 安排 `fix → verify → accept`；新增提交不能直接进 summary。外发、推送、合并、发版仍按既有授权规则。

## 产出与证据

- 产出根目录是 `.workflow-lite/runs/{instance}/out`，相对编译时的实例工作区，属本地运行目录、不入库（check-repository 跳过该目录）。`taskWorktree` 是任务代码根，两者可能不是同一个目录：报告与证据写实例工作区，代码与项目文档写 `taskWorktree`，派发时分别写明两个绝对路径。
- 每步产出最新报告 `<out>/<node>.md` 与历史 `history/<node>/R<官方 node.round>.md`。已完成历史不可覆盖；同轮中断复用既有历史时必须一致，冲突标 `BLOCKED`。
- 完整原始证据写入各节点的实例历史资源（`<out>/history/<node>/evidence/R<官方 node.round>/`），不截断必要事实；报告引用关键行与退出码。报告与历史都按资源契约落盘（`<out>/<node>.md`、`<out>/history/<node>/R<官方 node.round>.md`），回消息只交文件路径与结论，不能拿回消息代替文件。
- 长期台账 `.scratch/dev-loop/ledger.md` 是固定路径的真实 `update` 资源：按实例 id 幂等更新一行。新增实例 id 列时，旧行填「历史无id」，保留其余原文与顺序，不虚构旧实例、不按占位值去重。§0 保留六个字段（进行分支、最近 build、全量测试、已通过验收线、阻塞项、上次文档审计）。待合并的写「待合并」，不记成已合并或已交付。超限归档时保留现状字段，不删除。
- 项目文档按合同指定的 `taskWorktree` 写；报告根目录不改变代码根。

## 案例（取自历史返工）

- **报告要复核实测（PR #22）**：实施者报告 revert 后保持绿的 3 条用例（限流、预算用尽、多通道），复核实测「预算用尽」实际变红（断言含新文案）——总数对，分类错。→ verify 用认证清单逐项自跑，accept 不采信上游结论。
- **中间态 diff 不是死亡证据（Issue #23）**：lead 见实施超时且 `job_list` 为空，读未提交的中间 diff 就接手提交，与仍活跃的子代理竞态。→ 判失败或中断前先探询、看产出 mtime、核对既有提交。
- **首轮全绿不等于行为正确（PR #21）**：测试全绿但三处行为翻转，独立复核用旧/新构建同探针对照拦下。→ 首轮审全量含 revert 红绿，复核从找反例出发。

## 轻量例外与文档现状

- L0 微改保留轻量路径：lead 直接实现或派单个 impl，跑 `pnpm run check`，合并前照常 SHA 审。选用 dev-loop（L1 及以上）时，本文件的固定路由、VERDICT、复核预算与台账要求同样适用。
- 纯流程或内部规则变更且不影响产品能力时，在交付报告说明 README 核对结论；产品 README 不写本次开发会话。产品能力变化时按 AGENTS 规则同步 README。
