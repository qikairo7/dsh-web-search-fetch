# AGENTS.md

本文件是路由表：只指路和放硬规则，长说明都在被指向的文档里。所有项目文档一律简体中文（代码、命令、技术标识保持英文）。

## 开发循环（dev-loop）

需求一律走 `dev-loop` 工作流图（impl → verify → accept → release，`subagent` 模式）：用户描述需求，lead 编译图并调度。交付台账在 `.scratch/dev-loop/ledger.md`，错题本在仓库根 `LESSONS.md`。

循环硬规则（违反即返工）：

- worktree 任务分支开发；`pnpm run check` 全绿门禁；行为修复做 revert-变红验证（把修复还原，新测试必须红得指向具体行为，编译不过或跳过不算）；没跑的检查列为「未验证项」，不能省略。
- 真实使用验收：改动要过真实调用（`live-probe.mjs` 或独立 profile 实测），模拟测试不能替代。
- 放宽提前返回条件（如去掉 `fused.length > 0 &&` 这类守卫）时，必须对旧路径的可观察行为做新旧全字段对照探针——测试全绿不证明未跟踪字段（`truncated`、操作说明）幸免。此规则由 PR #21 返工换来。
- 合并 main、推送、发版必须用户明确授权；合并用 `gh pr merge --match-head-commit <审过的 sha>`，审后新 push 的代码进不来。
- PR 正文按 CONTRIBUTING 四段：问题、最终行为、验证命令、未验证部分。

## 模型路由（严格分工）

- 实施 / 复核 / 验收 → `subagent`，provider `magpie`，model `group/deepseek-v4.1-flash1017`，reasoning_effort `high`；开工先加载 `ponytail` skill（最小改动：能 50 行不写 200 行，不加投机抽象、不建单次使用的抽象）。
- 收口与 GitHub Issue/PR 维护 → `group/glm-5.3-flash`，`high`。
- lead 保持 glm-5.3，负责分析、拆解、审查、决策与用户沟通。
- `spawn_teammate` 不能选模型，禁止用于有模型要求的步骤；需要结构化任务图（依赖、attempt、质量门、验收记录）时用 `@nanmicoder/dsh-agent-teams` 的工具（`agent_teams_add_member` 支持 model 参数；质量类任务带 objective/acceptance/inScope/verify 合同，review 只以 verdict 收口）。

## 工具优先级（本机）

- 命令执行优先 `ops_bash`（dsh-ops 的 rust 工具，省 token）；Windows 原生操作（注册表、服务）才用 pwsh。文件查找 `ops_glob`、内容搜索 `ops_grep`、读文件 `ops_inspect_local_file`。
- UI 改动（`client/` 设置页）：验收用 oil-ui 的 `oil_ui_shoot` 截图取证，界面设计先读 `oil-ui` skill。
- 浏览器一律 ego（先读 `ego-browser-local` skill）；GitHub 操作一律 `gh` CLI，不走浏览器。
- node/pnpm 不在 PATH：node = `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；pnpm = `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`（以 `node <pnpm.mjs> <args>` 运行）；嵌套 `pnpm run` 需 `%TEMP%` 下 node.cmd/pnpm.cmd 转发 shim，用完删；新 worktree 先 `pnpm install --frozen-lockfile --prefer-offline`（约 1 秒，本地 store）。

## Skill 路由

- 复核审查用 `code-review` skill 的双轴：Standards 轴（本文件 + CONTRIBUTING 实现约定 + DESIGN 模块职责）、Spec 轴（需求的验收标准逐条）。
- 大型功能（多模块、跨会话）先走 `superpowers` 的设计/计划阶段；需求成票用 `to-spec` / `to-tickets`；大规划用 `wayfinder`。
- Issue/PR 处理流水线用 `issue-pipeline`；全仓质量审计用 `ponytail-audit`；债务清单 `ponytail-debt`。

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
