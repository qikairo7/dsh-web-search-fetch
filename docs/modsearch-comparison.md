# 与 ModSearch 的真实请求对比

## 记录状态

这是一次版本固定的历史对比：本插件为 `0.2.0`，ModSearch 为 `5.10.6`。比较结论用于解释两类产品的取舍，不表示两个项目的最新版本能力、价格或延迟未变化。本插件后续加入更多服务、设置页、自动预设和正文整理能力；ModSearch 也持续发布新版本。需要新的决策依据时，应固定双方版本后重新执行本基准。

## 结论与适用场景

本次两款产品的 48 次调用全部成功。多服务模式下，本插件的搜索每次发送 3 个请求，ModSearch 通常在 Firecrawl 成功后结束。因此，ModSearch 的搜索延迟与请求次数更低。本插件在搜索结果中保留了稍多的目标官方域名链接，但样本量不足以证明整体质量更好。

网页提取中，两款产品均保留了全部预设关键词。本插件将多服务正文整理为带来源和差异的输出，并提供显式截断标记。更多输出字符不代表更多有效信息，也不代表事实更准确。

本插件适合需要融合搜索来源、整理多份正文、保留差异的资料研究。ModSearch 提供首次可用结果、回退与额外的 X 搜索工具，适合优先控制请求成本和快速获得可用结果的任务。两者都有请求限时、失败回退或隔离机制；这些能力不能作为本项目独有优势。

## 方法与环境

| 项目 | 条件 |
| --- | --- |
| 日期 | 2026-10-14 |
| 本插件 | 0.2.0，本仓库实现 |
| ModSearch | 5.10.6，提交 `beb34982406438fe2473a9db0450fdd03a8ca826` |
| 运行环境 | 同一 Windows 主机，Node.js 24.20.0，同一网络 |
| 样本 | 3 个搜索问题、3 个公开网页，各重复 2 次 |
| 顺序 | 第一次先运行本插件，第二次先运行 ModSearch |
| 搜索限制 | 最多 5 条结果，单路 10 秒、操作总限时 15 秒 |
| 提取限制 | 单路 45 秒、操作总限时 50 秒，正文预算 50,000 字符 |
| 排序与模型 | 本插件关闭重排；两款产品均不调用语言模型 |

匿名组中，本插件启用 Firecrawl Keyless 与 Bing RSS 搜索，提取使用 Firecrawl Keyless。ModSearch 启用 Firecrawl Keyless 与本地 HTTP 回退。多服务组中，两者都配置相同的 Firecrawl、Tavily、Exa 账户凭证；本插件并发融合，ModSearch 按自身回退顺序执行。ModSearch 的 Antigravity 与 Grok 关闭，评测范围为公开网页搜索与提取。

两者直接调用实际核心 API 流程，未计算 CLI 启动、DSH 界面或模型调用时间。请求数为本地 `fetch` 调用次数，不包括透明重定向与服务方内部请求，不能直接换算成计费 credits。正文预算的统计范围不同：本插件包含来源说明，ModSearch 的限制主要针对正文；JSON 元数据另计。

搜索问题为 Node.js ECMAScript modules、Python asyncio TaskGroup、TypeScript satisfies 的官方文档。目标域名分别为 `nodejs.org`、`docs.python.org`、`typescriptlang.org`。提取页面分别为 Node.js 入门、Python asyncio tasks、TypeScript everyday types，每页预设 3 个关键词。完整问题、URL、关键词与逐次结果见[原始指标 JSON](./assets/modsearch-comparison.json)。

## 实测指标

每行包含 6 次调用。「目标链接」是返回结果中目标官方域名 URL 的累计数量，重复调用分别计数，不代表事实准确率。输出长度为完整 JSON 的字符数中位数，不是模型 token 数。

| 组别 | 操作 | 产品 | 成功 | 耗时中位数 | 请求总数 | 输出字符中位数 | 内容指标 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 匿名 | 搜索 | 本插件 | 6/6 | 625 ms | 12 | 1,628 | 目标链接 14/30 |
| 匿名 | 搜索 | ModSearch | 6/6 | 636.5 ms | 6 | 6,032 | 目标链接 12/30 |
| 匿名 | 提取 | 本插件 | 6/6 | 1,908.5 ms | 6 | 38,756 | 关键词 18/18 |
| 匿名 | 提取 | ModSearch | 6/6 | 2,182.5 ms | 6 | 40,880.5 | 关键词 18/18 |
| 多服务 | 搜索 | 本插件 | 6/6 | 1,878.5 ms | 18 | 12,067.5 | 目标链接 14/30 |
| 多服务 | 搜索 | ModSearch | 6/6 | 659.5 ms | 7 | 6,032 | 目标链接 12/30 |
| 多服务 | 提取 | 本插件 | 6/6 | 1,787.5 ms | 18 | 52,073 | 关键词 18/18 |
| 多服务 | 提取 | ModSearch | 6/6 | 2,122 ms | 7 | 38,141.5 | 关键词 18/18 |

本插件的匿名提取有 2 次、多服务提取有 4 次触发正文预算截断。ModSearch 的截断警告未纳入本脚本的结构化统计，其 JSON `truncated` 值为 `null`，表示未测量，不能解释为没有截断。更多服务可能返回重复导航或不同长度的正文，应结合[整理规则与限制](./content-organization.md)核对。

## 复现

先完成本项目开发依赖安装。另行克隆固定版本的 ModSearch 并安装其依赖，再运行：

```sh
git clone --branch v5.10.6 --depth 1 https://github.com/liustack/modsearch.git modsearch-reference
cd modsearch-reference
pnpm install --ignore-scripts
cd ..
pnpm run benchmark:modsearch --live --modsearch-source ./modsearch-reference --output ./comparison.json --repeats 2
```

上述命令在本项目目录下开始；`modsearch-reference` 与 `comparison.json` 均仅作本地评测。脚本要求 `--live`，会使用真实接口并消耗匿名额度。对比固定为 5.10.6；运行需要支持 `--experimental-transform-types` 的 Node.js，本次验证版本为 24.20.0。

增加 `--with-credentials` 可同时运行多服务组。凭证从 `FIRECRAWL_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY` 环境变量或当前 `DSH_HOME` 的凭证文件读取，不写入结果。报告只保存公开 URL、指标和错误代码，不保存接口正文、请求头或凭证值。评测不挂载正式 DSH profile。

## 证据边界

样本仅覆盖 3 类技术文档，同一网络下各重复 2 次。服务缓存、搜索索引变化和短期限流会影响结果。关键词出现仅证明字符串被保留；本次未测量事实正确率、复杂中文问题、不可访问页面、X 搜索或长期稳定性。因此不据此宣称本插件全面胜过 ModSearch。

实现依据：[ModSearch 搜索流程](https://github.com/liustack/modsearch/blob/beb34982406438fe2473a9db0450fdd03a8ca826/src/search.ts)、[输出协议](https://github.com/liustack/modsearch/blob/beb34982406438fe2473a9db0450fdd03a8ca826/skills/modsearch/references/output-schema.md)、[DSH 接入](https://github.com/liustack/modsearch/blob/beb34982406438fe2473a9db0450fdd03a8ca826/docs/dsh.zh-CN.md)、[Firecrawl Keyless 官方说明](https://www.firecrawl.dev/blog/firecrawl-keyless-launch)。
