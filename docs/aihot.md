# AIHOT 接入

启用 `engines.aihot` 后，原生 `web_search` 将 AI 资讯关键词结果加入多源聚合；原生 `web_fetch` 可直接读取下列官方 API。无需密钥、MCP 或额外模型工具。AIHOT 是垂直资讯源，搜索覆盖最近 7 天。

## 面向 Agent 的读取

首次可让 Agent 用 `web_fetch` 读取 [AIHOT 使用说明](https://aihot.news/api/v1/agent)，再按问题选择中文 Markdown 地址。此说明按需读取，不常驻注入系统提示。

| 需求 | 传给 web_fetch 的 URL |
| --- | --- |
| 最新精选、分类、全部动态 | `https://aihot.news/api/v1/agent/latest?window=24h&limit=10` |
| 关键词 | `https://aihot.news/api/v1/agent/search?q=DeepSeek&window=7d` |
| 当前热点 | `https://aihot.news/api/v1/agent/hot?limit=10` |
| 事件时间线 | `https://aihot.news/api/v1/agent/stories/{publicId}?limit=20` |
| 日报 | `https://aihot.news/api/v1/agent/daily`、`/api/v1/agent/daily/{date}` |
| 周报 | `https://aihot.news/api/v1/agent/weekly`、`/api/v1/agent/weekly/{week}` |
| 月报 | `https://aihot.news/api/v1/agent/monthly`、`/api/v1/agent/monthly/{month}` |
| Codex 重置记录 | `https://aihot.news/api/v1/agent/codex-resets` |

`latest` 支持 mode=selected/all、window=24h/7d、category 和 limit=1–30；search 支持 q、window、category、limit=1–30；hot 最多 10 条，事件时间线最多 50 条。关键词须 URL 编码。publicId 从热点返回链接或关联事件取得，不猜测。

## 结构化 API

以下路径前加 `https://aihot.news`，同样交给 `web_fetch`。返回完整 JSON，保留 publishedAt 与 discoveredAt 的区别、原文和站内链接、attribution、报告引用以及分页／增量字段。

| 能力 | 路径 | 参数或规则 |
| --- | --- | --- |
| 资讯 | `/api/v1/items` | mode、window、by=timeline/published、category、q、limit=1–100、cursor |
| 热点 | `/api/v1/hot-topics` | Top 10，rank 从 1 开始，links.story 提供事件地址 |
| 事件 | `/api/v1/stories/{publicId}` | 综述、时间线及关联事件 |
| 日报 | `/api/v1/dailies/latest`、`/api/v1/dailies/{date}`、`/api/v1/dailies` | date 为 YYYY-MM-DD；索引 limit=1–180 |
| 周报 | `/api/v1/weeklies/latest`、`/api/v1/weeklies/{week}`、`/api/v1/weeklies` | week 为 ISO 周 YYYY-Www；索引 limit=1–60 |
| 月报 | `/api/v1/monthlies/latest`、`/api/v1/monthlies/{month}`、`/api/v1/monthlies` | month 为 YYYY-MM；索引 limit=1–60 |
| 最近重置 | `/api/v1/codex-resets/recent` | 最近 7 天及未落地预告，十分钟节奏 |
| 完整重置历史 | `/api/v1/codex-resets` | 只在需要历史时读取，不用作频繁轮询 |
| 全部精选快照 | `/api/v1/selected/snapshot` | fields=default/minimal、limit=1–1000、page；保留 cursor、hasMore、nextPage |
| 精选增量 | `/api/v1/selected/changes` | cursor、limit=1–100；保留 upsert/remove、hasMore 及新的 cursor |

category 使用 ai-models、ai-products、industry、paper、tip、opinion；不传则不限分类。查询参数由服务端验证。

同步由调用者显式控制：首次按 nextPage 读取快照，完成后保存 cursor，后续读取 changes 并处理更新和撤选。本插件只读取被请求的一页，不自动遍历或写入副本。内容过大时缩小 limit；不会把 JSON 截断后当作成功结果。当前支持路径以本页为准，新路径需适配；不是无条件代理任意 URL。

## 缓存与节奏

请求启用压缩，缓存过期后使用 ETag 条件验证；304 使用验证后的数据，200 替换旧报告，失败不回传过期数据。重置接口默认十分钟缓存，其他接口默认一分钟，并遵循上游缓存指令。日报 08:00、周报每周一 10:00、月报每月 1 日 10:30 出刊（北京时间）；没有自动创建定时任务。历史报告再次使用时会按缓存过期条件验证，以接收撤稿修订。

429 / 503 按 Retry-After 冷却，不自动并发重试。缓存与冷却属于插件实例中的 HTTP 客户端，不是跨进程的全局限流器；自行同步时仍须遵守官方访问节奏。

默认发行配置关闭 AIHOT，本机可显式启用。用途与许可条件见[配置说明](./configuration.md#aihot-可选-ai-资讯源)。官方依据：[能力说明](https://aihot.news/llms.txt)、[OpenAPI](https://aihot.news/openapi-v1.json)。
