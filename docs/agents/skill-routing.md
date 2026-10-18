# SKILL 路由表——dev-loop 全流程融入

按开发循环的环节组织：什么时候、什么条件、加载哪个 skill。通用原则：skill 在触发条件命中时才加载（上下文按需进入），不预防性加载；一次任务涉及多个环节时按流程顺序串联。

## 需求 intake（lead）

| 条件 | skill | 用法 |
| --- | --- | --- |
| 用户一句话需求，意图/方案有歧义 | `grilling` / `grill-me` | 就地追问补齐关键决策，不展开成完整评审 |
| 需求较大（多模块、动架构、跨会话） | `elephant` | 设计对话产出四节设计文档（问题/技术方案/替代/细化实现），再交 `goldfish` 验证 |
| 设计文档要独立验证 | `goldfish` | 三个无上下文评审员（理解/批判/可实现性），轮次记 GOLDFISH.md，nit 级才放行 |
| 用户要功能但没想清形态 | `prototype` / `prototype-variants` | 一次性原型回答设计问题，验证后丢弃 |
| 需求要变成 spec / 工单 | `to-spec` → `to-tickets` | spec 发布到 GitHub Issues；拆成 tracer-bullet 工单，声明阻塞边 |
| 大规划（一个会话装不下） | `wayfinder` | issue 跟踪器上的决策票地图，逐票清到路线明确 |
| 需求是「解释原理/画个图」的文档类 | `answer-me-with-html` / `baoyu-diagram` | 一页可视化讲清 / SVG 架构图 |
| 研究型需求（选型、调研、对比） | `research` | 带来源的研究报告存档，不占用会话上下文 |

## 实施（impl，Deepseek-V4.1-Flash1017 high）

| 条件 | skill | 用法 |
| --- | --- | --- |
| 每次开工 | `ponytail` | 最小改动默认姿态：能 50 行不写 200 行，不加投机抽象 |
| bug 修复 | `diagnosing-bugs` | 诊断循环：复现 → 定位 → 最小修复，不带猜测进实现 |
| 新功能有回归约束 | `tdd` | 红-绿-重构；与仓库 revert-变红规则天然咬合 |
| 文档/中文文案改动 | `tech-doc-style-chinese` | 克制、准确、可扫读的中文技术写作 |
| UI 改动 | `impeccable`（一般）/ `arc`（Arc 项目） | 层级、可达性、响应式、文案、token 全审 |
| 动效 | `animate`（新增）/ `review-animations`（审）/ `improve-animations`（全库审计） | 先决策该不该动效，再谈实现 |
| 组件状态覆盖 | `state-machine` / `break-ui` | 每个可达状态渲染一遍 / 最坏数据压测 |
| 设计/文案带 AI 痕迹 | `humanizer-zh` / `libai-skill` | 成稿后清理模板化表达 |
| 命名/术语与项目不一致 | 读 `GLOSSARY.md`，缺概念记给 `domain-modeling` | 术语表是唯一权威 |

## 复核（verify，Deepseek-V4.1-Flash1017 high，独立）

| 条件 | skill | 用法 |
| --- | --- | --- |
| 每次 | `code-review` | 双轴：Standards（AGENTS.md + CONTRIBUTING + DESIGN）/ Spec（验收标准逐条） |
| 用户点名「狠狠审」或高风险改动 | `mean-review` | 对抗性审查，问题清单存 MEAN-REVIEW.md |
| 接口/可用性回归 | `interface-review` | 布局、写作、排版、颜色、UI 的引入性回归 |
| 动效改动 | `review-animations` | 默认 flag，达标才认可 |

## 验收（accept，真实验收优先）

| 条件 | 工具/skill | 用法 |
| --- | --- | --- |
| 服务端行为 | `live-probe.mjs`（参数化） | 本地 Cordis 装载构建产物，真实调用匿名引擎 |
| UI 改动 | `oil_ui_shoot`（dsh-oil-ui） | 截图/多状态/取证集；必要时 ego-browser 实操 |
| 想穷举 UI 状态 | `state-machine` / `break` | 临时页渲染全部状态再验收 |
| 用户截图反馈 | `magpie-vision`（MCP） | 读图定位问题 |

## 收口与回写（release，GLM-5.3-Flash high）

| 条件 | skill | 用法 |
| --- | --- | --- |
| PR 正文 | `pr` | 四段结构：问题/最终行为/验证/未验证 |
| 外发中文文本 | `tech-doc-style-chinese` | 评论、release notes 过一遍 |
| 语气拿不准的回复 | `humanizer-zh` | 去模板化 |
| 分支收尾 | issue-pipeline 第 5 阶段内置 | push、CI 跟进、证据回帖 |
| 每轮结束 | `retro` | 环境改进候选（本表就是这么来的） |

## Issue/PR 维护（GLM-5.3-Flash high）

| 条件 | skill | 用法 |
| --- | --- | --- |
| 处理仓库的 issues / PR | `issue-pipeline` | 五阶段：同步→分诊→实现→审查→回写；所有外发先草稿 |
| 分诊状态机 | `triage` | 五角色判定 |
| 全仓质量审计 | `ponytail-audit` | 一次性报告：bug、安全、负载、该删什么 |
| 债务清单 | `ponytail-debt` | shortcut: 注释台账 |

## 知识沉淀（贯穿）

| 条件 | skill/机制 | 用法 |
| --- | --- | --- |
| 每次返工/误合并/验证不严 | `LESSONS.md`（magpie 错题本） | 复盘者追加；Seen 3× 转正硬规则 |
| 难以回退的架构决策 | `domain-modeling` → ADR | 记进 docs/adr/ |
| 老代码库要低成本上手 | `peanuts` | 自底向上 README 层级 + 人审门 |
| 会话要交接 | `handoff` | 压缩成交接文档 |

## 明确不用（避免过度工程）

- `wizard`（人才能做的步骤向导）——我们的 HITL 直接由用户担当
- `to-questionnaire`——用户就在环里，直接问
- 内容生产全家桶（`baoyu-*`、`luobo-ppt` 等）——本项目不是内容项目，`baoyu-diagram` 仅在画架构图时用
- `huashu-nuwa`、`writing-dna-skill` 等人格/文风蒸馏——与工程循环无关
