# AGENTS.md

**总则：目标是快速、高质量交付，流程只为此服务。**要加任何新门、审批、检查，先问它是否直接帮助交付，否则不加；流程与交付冲突时，交付优先并记录在案。

本文件是路由表：只指路和放硬规则，长说明都在被指向的文档里。所有项目文档一律简体中文（代码、命令、技术标识保持英文）。**开工入口**：每次会话先读本文件 → `LESSONS.md` → 台账现状区（`.scratch/dev-loop/ledger.md` §0），再动手。

## 开发循环（dev-loop）

需求一律走 `dev-loop` 工作流图（impl → verify → accept → release，`subagent` 模式）：用户描述需求，lead 编译图并调度。交付台账在 `.scratch/dev-loop/ledger.md`，错题本在仓库根 `LESSONS.md`。

**任务分级路由**（lead 在 intake 时定级，轻任务走轻流程——重量级流程用在简单任务上是浪费）：

| 量级 | 判定 | 流程 |
| --- | --- | --- |
| L0 微改 | 改文案、简单样式、边界一目了然 | lead 直接实现（或派单个 impl 子代理），跑 `pnpm run check`，合并前照常 SHA 审 |
| L1 明确 bug / 小功能 | 范围明确、单模块、能写清验收 | 定位 → dev-loop（impl → verify → accept → release） |
| L2 边界清晰的功能 | 新能力但边界清楚 | spec 驱动（见下）→ dev-loop |
| L3 跨模块中型功能 | 多模块联动 | spec 驱动 → `to-tickets` → dev-loop（可多 worktree 并行，主 Agent 集成） |
| L4 大型 / 架构不确定 | 多会话、方向未明 | `wayfinder` → spec 驱动 → `to-tickets` → dev-loop |

**spec 驱动（L2+ 必经，吸收自 GitHub Spec Kit + R&K Flow）**：先明确需求、边界条件、业务规则和验收标准，再定技术方案、拆任务；**未经用户确认不进入大规模编码**。三个要点：

- **双计划并行**：实现计划（改哪些文件、接口与数据结构、实现顺序、明确不在范围内的事）与测试计划（输入/预期/异常与边界覆盖、要留的验证证据）**同时成形、互相拷问**——writer 提接口、tester 找并发/空值/失败恢复未定义处，打回补齐后才交给用户审。
- **验收用 Requirement + Scenario 格式**（吸收自 OpenSpec）：每条需求写成 `Requirement: <SHALL 句式的行为定义>`，下挂一个或多个 `Scenario: <场景名>`，每场景用 `WHEN <可观察输入> / THEN <可观察结果>` 两行表达。可测试措辞天然排除「两种结果都算过」的松断言；测试计划里的每条验收直接对应一个 Scenario，revert-变红验证时红的就是那个 THEN。
- **人审方案，不审代码**：用户注意力花在方案关键取舍上（目标理解、模块边界、接口设计、验收标准），代码正确性由 SHA 对抗复核与测试证据背书。给用户的方案评审默认纯文本；方案复杂（多模块、多取舍）时用 HTML 报告（表格/折叠明细/修订标记，可用 `answer-me-with-html` skill 生成）。
- **偏差先指出再修正**：实现中发现需求冲突或与计划偏差，先停下指出问题、给出修正方案（NEED-DECISION），不默默改。

**方法论 prompt**（思维快捷键——模型已预训练这些方法论，点名激活比长流程便宜，lead 与各步骤按需使用）：

- 第一性原理：「不要沿着现有方案优化，从第一性原理重新分析这个问题的最小必要解」——用于怀疑题目本身问错时。
- 对抗性审查：「优先寻找能推翻核心假设的反例」——verify 的默认姿态；方案评审同。
- 消融实验：「给这些优化设计消融实验，判断真实收益来自哪里」——多个机制叠加后验证各自贡献。
- 奥卡姆剃刀：「在满足需求的前提下删除所有非必要机制」——复核新增抽象时；与 ponytail 哲学同源。
- 高内聚低耦合：「按此原则审查职责边界，不为拆而拆」——模块重构时。

循环硬规则（违反即返工）：

- worktree 任务分支开发；行为修复做 revert-变红验证（把修复还原，新测试必须红得指向具体行为，编译不过或跳过不算）；没跑的检查列为「未验证项」，不能省略。
- **质量红线：有损取舍只能列方案交用户批准**——截短输出、抽样代替全量、默认值代替询问、静默跳过检查，都不许默默做；做不到的明确标 `BLOCKED` 或「未验证」，不蒙混。
- 实施自提交、复核只读快照：impl 完成后提交自己的工作（含 lib/ 产物与文档同步）并报告 SHA；verify 在该 SHA 上只读审查，审前审后核对仓库状态未变。
- 测试一律用替身与夹具（mock 引擎、注入请求），不碰真实进程、系统服务与线上环境。
- 真实使用验收：改动要过真实调用（`live-probe.mjs` 或独立 profile 实测），模拟测试不能替代；宣布完成前亲眼核对用户可见输出。
- 放宽提前返回条件（如去掉 `fused.length > 0 &&` 这类守卫）时，必须对旧路径的可观察行为做新旧全字段对照探针——测试全绿不证明未跟踪字段（`truncated`、操作说明）幸免。此规则由 PR #21 返工换来。
- 合并 main、推送、发版必须用户明确授权；合并用 `gh pr merge --match-head-commit <审过的 sha>`，审后新 push 的代码进不来。
- 每次功能或行为更新必须同步 README：新能力进「项目特点」表与行为描述段，被替代或移除的行为同步删改——用户从 README 看到的永远是当前功能集，不是旧功能或已淘汰的功能。收口步骤把 README 核对当必做项，不是「需要才改」。**规格归档同理**：交付后把本次变更的 spec（需求、边界、验收、关键设计决定）回写进项目知识——行为规范进 DESIGN.md/docs、术语进 GLOSSARY.md、难回退决策记 ADR——下一个需求的 AI 直接从项目文档读到当前行为定义，不依赖会话记忆、不重复摸索（吸收自 OpenSpec 的 archive 环节）。
- **一切 GitHub 外发先出草稿**：建 issue、issue 评论、关闭、开 PR、PR 正文与评论、打 tag、发 release——先把完整草稿给用户看（注明去向：哪个仓库、哪个编号），用户确认后才提交。被拒立即停手，不换路径绕过。
- Issue/PR 处理走 `issue-pipeline` skill 五阶段（同步 → 分诊 → 实现 → 审查 → 回写）；回写文本按该 skill 的成稿校对要求过中文风格。**对齐尺度**：当剩余的未决问题已不会显著改变实现方向和验收结果时，即可开工，不追求提前规划全部细节。
- **工作流定期做减法**：模型或工具升级后，重审每条约束是否仍有收益（为旧短板设计的步骤该删就删）；简单任务直接做，复杂任务才加规划、拆分、交叉审查。
- PR 正文按 CONTRIBUTING 四段：问题、最终行为、验证命令、未验证部分。

## 模型路由（严格分工）

- 实施 / 验收 → `subagent`，provider `magpie`，model `group/deepseek-v4.1-flash1017`，reasoning_effort `high`；实施开工先加载 `ponytail` skill（最小改动：能 50 行不写 200 行，不加投机抽象、不建单次使用的抽象）。
- **复核换模型**：`group/glm-5.3-flash`，`high`——写码与审码不同模型，从「找反例」角度对抗式审查；高风险改动（删除数据、授权、付费、放宽门禁）加载 `mean-review`。
- 收口与 GitHub Issue/PR 维护 → `group/glm-5.3-flash`，`high`。
- lead 保持 glm-5.3，负责分析、拆解、审查、决策与用户沟通。
- **可追溯**：每份步骤产出的第一行写执行者与模型/effort（例：`执行者：deepseek-v4.1-flash1017/high`），结果才可复盘。
- `spawn_teammate` 不能选模型，禁止用于有模型要求的步骤；需要结构化任务图（依赖、attempt、质量门、验收记录）时用 `@nanmicoder/dsh-agent-teams` 的工具（`agent_teams_add_member` 支持 model 参数；质量类任务带 objective/acceptance/inScope/verify 合同，review 只以 verdict 收口）。

## 工具优先级（本机）

- 命令执行优先 `ops_bash`（dsh-ops 的 rust 工具，省 token）；Windows 原生操作（注册表、服务）才用 pwsh。文件查找 `ops_glob`、内容搜索 `ops_grep`、读文件 `ops_inspect_local_file`。
- UI 改动（`client/` 设置页）：验收用 oil-ui 的 `oil_ui_shoot` 截图取证，界面设计先读 `oil-ui` skill。
- 浏览器一律 ego（先读 `ego-browser-local` skill）；GitHub 操作一律 `gh` CLI，不走浏览器。
- node/pnpm 不在 PATH：node = `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；pnpm = `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`（以 `node <pnpm.mjs> <args>` 运行）；嵌套 `pnpm run` 需 `%TEMP%` 下 node.cmd/pnpm.cmd 转发 shim，用完删；新 worktree 先 `pnpm install --frozen-lockfile --prefer-offline`（约 1 秒，本地 store）。

## Skill 路由

全流程 skill 融入表（intake → 实施 → 复核 → 验收 → 收口 → 维护 → 沉淀，含触发条件）见 `docs/agents/skill-routing.md`，命中条件才加载。核心几条：

- 复核审查用 `code-review` skill 的双轴：Standards 轴（本文件 + CONTRIBUTING 实现约定 + DESIGN 模块职责）、Spec 轴（需求的验收标准逐条）。
- 大型功能（多模块、跨会话）先走 `superpowers` 的设计/计划阶段（设计对话可用 `elephant` + `goldfish`）；需求成票用 `to-spec` / `to-tickets`；大规划用 `wayfinder`。
- Issue/PR 处理流水线用 `issue-pipeline`；全仓质量审计用 `ponytail-audit`；债务清单 `ponytail-debt`。
- 每次会话结束或有返工时跑 `retro`，环境改进候选写进 LESSONS.md。

## Agent skills

### Issue tracker

Issue 与 spec 放在 `qikairo7/dsh-web-search-fetch` 的 GitHub Issues，用 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个标准角色与现有标签 1:1 对应。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓库根 `GLOSSARY.md` 与 `docs/adr/`。见 `docs/agents/domain.md`。

## 第三方 API 夹具

测试夹具编码第三方响应形状前，先读厂商官方 API 文档并在夹具注释里引用其 URL；凭记忆写的库类型是未验证的，会在真实 API 不会走的路径上误红。各引擎行为见 `docs/troubleshooting.md#目标站返回-4xx却报成服务不可用`。

## 回归测试必须咬合

修完 bug 后把修复就地还原，跑新测试确认失败，再恢复确认通过。绿灯只证明代码能跑，revert 变红才证明测试在守这个行为。接受两种结果的断言（“返回 404 的结果，或错误消息提到 404”）在 revert 两侧都过，什么也不守——断言 bug 报告点名的那个单一可观察结果。这是刻意的手工步骤：套件几秒跑完，一次 revert 比一个变异测试依赖便宜。
