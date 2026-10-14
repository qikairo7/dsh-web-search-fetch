# 配置参考

配置契约以 [`src/index.ts`](https://github.com/qikairo7/dsh-web-search-fetch/blob/main/src/index.ts) 的 `Config` schema 为准。插件注册两个 id 为 `aggregated` 的 provider；工具定义由 DSH 提供。

## 凭证与启用范围

实际密钥由 DSH credentials 服务按次解析，不缓存。配置和仓库只保留引用名。

| 服务 | 默认凭证引用 | 搜索 | 提取 |
| --- | --- | --- | --- |
| AnySearch | `ANYSEARCH_API_KEY` | 是 | 是 |
| 智谱 | `ZHIPU_API_KEY` | 是 | 否 |
| 知乎 | `ZHIHU_ACCESS_SECRET` | 是 | 否 |
| Firecrawl | `FIRECRAWL_API_KEY` | 是 | 是 |
| Tavily | `TAVILY_API_KEY` | 是 | 是 |
| Exa | `EXA_API_KEY` | 是 | 是 |
| Keenable | `KEENABLE_API_KEY` | 是 | 是 |
| Crawl4AI Cloud | `CRAWL4AI_API_KEY` | 是 | 是 |
| GitHub | `GITHUB_TOKEN` | 公开仓库 | README / 文件 |
| 百度千帆 | `QIANFAN_API_KEY` | 是 | 否 |
| 豆包 Custom | `DOUBAO_SEARCH_API_KEY` / `DOUBAO_FETCH_API_KEY` | 是 | 是 |
| TinyFish | `TINYFISH_API_KEY` | 是 | 是 |
| Serply | `SERPLY_API_KEY` | 是 | 是 |
| Kimi | `MOONSHOT_API_KEY` | 是 | 是 |
| Bing RSS | 无需凭证 | 是 | 否 |
| AIHOT（可选） | 无需凭证 | AI 资讯关键词 | 专用 API |
| 硅基流动 | `SILICONFLOW_API_KEY` | 重排 | 否 |
| 直接 HTTP 抓取 | 无需凭证 | 否 | 静态资源 |

按能力和费用选择需要的服务，费用区别见 [服务费用](../README.md#服务费用)。配置方式与价格无关：AnySearch、智谱和知乎通过 `search` 字段配置；Firecrawl 与 AnySearch 的提取通过 `fetch` 字段配置。用 `controls.searchServices` / `controls.fetchServices` 分别控制参与范围。`engines` 中的服务仅在列出且未设 `enabled: false` 时创建。凭证服务明确报告未配置时，该路不派发；状态未知时保留实际请求验证。

在 profile 的 `cordis.patch.yml` 中按 id 覆盖配置。DSH 配置覆盖不会逐字段深合并，需重述所需配置，包括扩展服务列表。`name` 是模块匹配条件，不能用它重命名已有模块。

```yaml
- id: web-search-fetch
  config:
    apiKeyEnv: ZHIPU_API_KEY
    controls:
      mode: organize
      preset: balanced
      maxRequests: 8
      maxOutputChars: 100000
    engines:
      tavily: {}
      exa: {}
      keenable: {}
      crawl4ai: {}
      github: {}
      qianfan: {}
      doubao: {}
      firecrawl: {}
      tinyfish: {}
      serply: {}
      kimi:
        searchMode: pro
      bing: {}
      aihot:
        enabled: false
    search:
      maxFanoutMs: 10000
      rrfK: 60
      rerankPool: 20
      rerank: true
      rerankTimeoutMs: 3000
      zhihuQuotaCheck: true
      anysearchApiKeyEnv: ANYSEARCH_API_KEY
      zhipuTransport: anthropic
      zhipuAnthropicModel: glm-4.6
      zhipuAnthropicMaxUses: 1
    fetch:
      staticRouting: true
      staticDomains: []
      perEngineTimeoutMs: 45000
      engineWeights:
        firecrawl: 3
        anysearch: 2
```

省略可选字段时使用默认值；不要用 YAML `null` 代替字符串。只启用 Tavily 和 Exa 时，将示例的 `engines` 整块改为这两项。每项支持 `enabled`、`apiKeyEnv`、`baseURL`、`fetchBaseURL`；Kimi 另支持 `searchMode`；豆包默认使用单独的 `fetchApiKeyEnv`。TinyFish 的搜索和提取为不同域名，`baseURL` 只覆盖搜索，`fetchBaseURL` 覆盖提取。Firecrawl 扩展配置控制搜索，网页提取由 `fetch.firecrawlApiKeyEnv` / `fetch.firecrawlBaseURL` 控制。

智谱搜索凭证优先使用 `search.zhipuApiKeyEnv`，其次根 `apiKeyEnv`；AnySearch 提取凭证优先使用 `fetch.anysearchApiKeyEnv`，其次 `search.anysearchApiKeyEnv`。

## 硅基流动重排

插件固定使用 `BAAI/bge-reranker-v2-m3`，当前在硅基流动提供免费调用，仍需配置 API Key。可通过[硅基流动邀请链接](https://cloud.siliconflow.cn/i/E3nhNFP4)注册账号并创建密钥，在设置页的「硅基流动」项中保存，默认凭证引用为 `SILICONFLOW_API_KEY`。

`search.rerank` 在 schema 中默认为 `true`，作为旧配置的兼容初始值；新安装 bundle 显式设置 `controls.serviceEnabled.siliconflow: false`，默认不调用重排。显式设置 `controls.serviceEnabled.siliconflow` 时使用该值。重排不可用时保留 RRF 融合顺序。模型费用以[官方定价](https://siliconflow.cn/pricing)为准。

## 服务总开关

`controls.serviceEnabled` 按服务 ID 保存总开关，例如 `anysearch: false` 会停止 AnySearch 的搜索与提取。关闭不会清除凭证或参与范围，重新开启后沿用原配置。扩展服务首次开启时，设置页会补齐所需的 `engines` 条目；关闭总开关会保留该条目。

直接 HTTP 抓取的 ID 为 `http`。关闭后，静态 URL 返回 `WEB_PROVIDER_ERROR`，不会自动改走其他提取服务。需要读取静态资源时，重新开启该服务。

## 搜索与提取参数

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKeyEnv` | 字符串引用名 | `ZHIPU_API_KEY` | 智谱搜索回落引用 |
| `search.maxFanoutMs` | 正整数，毫秒 | `10000` | 单路搜索时间预算 |
| `search.rrfK` | 正整数 | `60` | RRF 常数 |
| `search.rerankPool` | 正整数 | `20` | 重排候选数 |
| `search.rerank` | 布尔值 | `true` | 是否启用重排 |
| `search.rerankTimeoutMs` | 正整数，毫秒 | `3000` | 重排请求预算 |
| `search.zhihuQuotaCheck` | 布尔值 | `true` | 当日首次查询的额度检查 |
| `search.zhipuTransport` | 字符串枚举 | `anthropic` | 另可选 `tools-api` |
| `search.zhipuAnthropicModel` | 字符串 | `glm-4.6` | 搜索通道模型 |
| `search.zhipuAnthropicMaxUses` | 正整数 | `1` | 搜索工具调用上限 |
| `fetch.staticRouting` | 布尔值 | `true` | 按 URL 分流 |
| `fetch.staticDomains` | 主机名数组 | `[]` | 静态主机及其子域 |
| `fetch.staticExtensions` | 字符串数组 | 内置表 | 静态扩展名规则 |
| `fetch.perEngineTimeoutMs` | 正整数，毫秒 | `45000` | 单路提取预算 |
| `fetch.engineWeights` | 数值字典 | `{}` | 仅旧版 `select` 模式使用的正文权重 |

内置扩展名：`txt`、`text`、`xml`、`json`、`md`、`markdown`、`csv`、`tsv`、`rss`、`atom`、`yaml`、`yml`、`log`、`ini`、`toml`、`ics`、`vtt`、`srt`。显式 `[]` 清空扩展名匹配。域名填写主机名，不写协议、路径或通配符。默认权重 Firecrawl 为 `3`，AnySearch 及未单独配置的扩展为 `2`。

搜索凭证字段 `search.anysearchApiKeyEnv`、`search.zhihuAccessSecretEnv`、`search.siliconflowApiKeyEnv` 及 `fetch.firecrawlApiKeyEnv` 使用凭证表中的默认引用。`search.zhipuApiKeyEnv` 和 `fetch.anysearchApiKeyEnv` 为空时按回落关系读取。不存在 `fetch.zhipuApiKeyEnv` 或阅读器端点配置。

## 端点与传输

| 配置 | 默认值 |
| --- | --- |
| `search.anysearchBaseURL` / `fetch.anysearchBaseURL` | `https://api.anysearch.com` |
| `search.zhipuAnthropicBaseURL` | `https://open.bigmodel.cn/api/anthropic/v1` |
| `search.zhipuBaseURL` | `https://open.bigmodel.cn/api/paas/v4/web_search` |
| `search.zhihuBaseURL` | `https://developer.zhihu.com/api/v1/content/global_search` |
| `search.zhihuQuotaURL` | `https://developer.zhihu.com/api/v1/quota` |
| `search.rerankBaseURL` | `https://api.siliconflow.cn/v1/rerank` |
| `fetch.firecrawlBaseURL` | `https://api.firecrawl.dev/v2/scrape` |

扩展服务端点见下表；映射实现在 [`ADDITIONAL_ENGINE_DEFAULTS`](https://github.com/qikairo7/dsh-web-search-fetch/blob/main/src/engines/additional/index.ts) 和适配器中。自定义地址会改变密钥发送目标，仅配置可信 API 地址。

| 扩展 ID | 默认引用 | 搜索基础地址 | 提取基础地址 |
| --- | --- | --- | --- |
| `tavily` | `TAVILY_API_KEY` | `https://api.tavily.com` | 同搜索 |
| `exa` | `EXA_API_KEY` | `https://api.exa.ai` | 同搜索 |
| `keenable` | `KEENABLE_API_KEY` | `https://api.keenable.ai` | 同搜索 |
| `crawl4ai` | `CRAWL4AI_API_KEY` | `https://api.crawl4ai.com` | 同搜索 |
| `github` | `GITHUB_TOKEN` | `https://api.github.com` | 同搜索 |
| `qianfan` | `QIANFAN_API_KEY` | `https://qianfan.baidubce.com` | — |
| `doubao` | `DOUBAO_SEARCH_API_KEY` | `https://open.feedcoopapi.com` | 同搜索，引用为 `DOUBAO_FETCH_API_KEY` |
| `firecrawl` | `FIRECRAWL_API_KEY` | `https://api.firecrawl.dev` | 网页提取使用独立 `fetch` 配置 |
| `tinyfish` | `TINYFISH_API_KEY` | `https://api.search.tinyfish.ai` | `https://api.fetch.tinyfish.ai` |
| `serply` | `SERPLY_API_KEY` | `https://api.serply.io` | 同搜索 |
| `kimi` | `MOONSHOT_API_KEY` | `https://api.moonshot.cn` | 同搜索 |
| `bing` | 无 | `https://cn.bing.com` | — |
| `aihot` | 无 | `https://aihot.news` | 仅专用 API |

扩展项字段：`enabled`（布尔值，条目内默认 `true`）、`apiKeyEnv`（字符串引用名）、`fetchApiKeyEnv`（豆包专用字符串引用名）、`baseURL` 和 `fetchBaseURL`（字符串基础地址）。Kimi 的 `searchMode` 为 `basic` 或 `pro`，省略时使用 `pro`。省略整个条目不会创建该扩展；新安装 bundle 仅启用 Firecrawl、Tavily 两个扩展及 AnySearch 服务；其他远程服务与重排默认关闭。直接 HTTP 抓取作为静态资源基础能力保留。已保存的显式开关设置优先于安装默认。

智谱 `anthropic` 通道通过 HTTP Messages API 请求服务端 `web_search_20250305`，结果块完整后结束流读取。备用 `tools-api` 调用 `search_pro`，查询截断至 70 字符。本插件接入的两条智谱搜索通道均为付费使用：Coding Plan 消耗付费订阅额度，`search_pro` 按次计费。套餐额度不等于免费额度，账号资格和计费以服务商为准；两条通道均无需 MCP。

## 提取路由

静态扩展名和 `staticDomains` 按 URL 匹配，命中时走内置 HTTP。`staticExtensions` 省略时使用内置表；显式配置会替换整张表。没有预先的 Content-Type 探测。

这里的 HTTP 是聚合插件复用的 DSH 抓取组件，直接访问目标网站，不调用 DeepSeek 模型 API。模型处理工具结果时仍会产生模型 token 用量；直接抓取本身不消耗 DeepSeek 模型额度。

已启用且在提取参与列表中的 AIHOT 专用 API 在通用分流前直接读取，不调用其他提取服务。其余 URL 在 `staticRouting: false` 时全部使用内置 HTTP 提取。动态路径默认整理多路正文，单路限时 45 秒、操作总限时 50 秒；规则见[正文整理](./content-organization.md)。限流按冷却时间恢复；额度耗尽按本地日期恢复。搜索与提取的熔断器分别维护进程内状态。

## 正文与调用控制

`controls` 支持设置页修改，保存后下一次操作读取配置快照；正在执行的操作继续使用其原有预算。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `organize` | 默认正文整理；`select` 返回旧版单份正文 |
| `preset` | `custom` | `free` 免费接口、`balanced` 最多三路、`deep` 所选全部服务、`custom` 自定义 |
| `searchServices` | 全部搜索服务 ID | 按数组顺序选择，空数组禁用搜索派发 |
| `fetchServices` | 全部提取服务 ID | 普通提取及 AIHOT 参与范围，静态 HTTP 独立 |
| `maxSearchServices` | `16` | 每个查询的服务上限，范围 1–16 |
| `maxFetchServices` | `11` | 每个 URL 的普通提取服务上限，范围 1–11 |
| `maxRequests` | `32` | 每次 provider 操作的插件 HTTP 请求上限，范围 1–256 |
| `searchDeadlineMs` | `15000` | 搜索操作总限时，范围 1–3,600,000 毫秒 |
| `fetchDeadlineMs` | `50000` | 提取操作总限时，范围 1–3,600,000 毫秒 |
| `maxOutputChars` | `100000` | 整理结果含说明的字符上限，范围 1,000–1,000,000 |

免费接口预设只派发 TinyFish、Bing RSS、GitHub 和已主动启用的 AIHOT，仍遵守凭证、用途和限流要求。硅基流动免费标准模型可继续重排。免费额度、试用额度和智谱付费订阅不属于此预设；使用自定义端点的服务也不会被当作免费。静态 HTTP 路径保持独立，模型 token 用量不受此预设控制。

均衡预设按参与列表顺序，从已启用、未熔断且具备凭证的适用服务中最多派发三路。深度和自定义预设按指定数量上限派发，不自动开启扩展或提高预算。请求上限计入额度查询、重试和重排，不等于人民币费用上限，也不限制上游服务的内部工具调用次数。HTTP 静态路径沿用宿主响应、重定向和长度限制；插件总限时仍适用。日志记录插件请求次数，返回结果附带预算耗尽、超时或未派发说明。

插件的 API 请求拒绝 HTTP 重定向，避免额外请求绕过计数或把鉴权信息转交其他端点；自定义端点应填写最终 API 地址。操作总限时到期时返回已完成的搜索或提取结果，并标记 `truncated`；搜索重排未完成时保留 RRF 顺序。尚无可用结果时返回对应超时错误，调用方主动取消则返回 `WEB_ABORTED`。

GitHub 提取只识别仓库根 URL 与 `/blob/<ref>/<path>`，不提供任意 GitHub 网页解析。含斜杠的分支名暂未专门解析，二进制内容不作为正文返回。

## 工具超时配置

插件配置单路和操作总预算，不覆盖宿主工具层。给实际运行的 `tool-web` 实例配置足够余量，例如：

```yaml
- id: tool-web
  config:
    fetch: true
    searchTimeoutMs: 60000
    fetchTimeoutMs: 90000
```

在 Web profile 中，工具实例可能位于 agent preset 的 `config.plugins` 内。DSH `0.2.1-alpha.2` 的顶层 id 补丁不会递归修改该数组；只修改顶层条目可能命中被禁用的实例。应通过宿主 preset 编辑方式修改实际实例，保存时保留其完整配置，再创建会话检查生效状态。只看 `--dump-config` 不足以证明真实会话正在使用新预算。

## Web 设置卡片

新安装默认启用 AnySearch、Firecrawl、Tavily，无需填写密钥。AnySearch 官方 `/v1/search` 和 `/v1/extract` 使用公共匿名额度；Firecrawl 官方 `/v2/search` 和 `/v2/scrape` 使用匿名额度；Tavily 官方 `/search` 和 `/extract` 携带 `x-tavily-access-mode: keyless`。匿名访问有限流和额度限制，密钥配置后使用账户模式，不自动回退。自定义端点仍需密钥。AnySearch 域名发现接口仍需密钥，匿名错误正文不输出，额度耗尽时不自动使用上游生成的账号。

匿名额度与免费接口预设分别处理：`free` 排除额度型服务；推荐默认组合使用 `custom` 预设。其他服务作为增强按需开启，已保存的显式开关与凭证保持不变；旧版未设置开关的服务采用新版默认。依据见 [README 匿名访问说明](../README.md#服务费用)。

打开「设置 → 内置插件 → 网络搜索与提取」。卡片与 README 的完整接入清单一致，覆盖 18 项服务、16 个凭证位，包括无需凭证的 Bing RSS、AIHOT 和直接 HTTP 抓取。豆包搜索与提取分别填写密钥；智谱只保留搜索。

用服务名称或用途搜索，按搜索 / 提取 / 重排筛选，或只查看待配置、未保存及无需密钥的服务。点击服务行展开密钥与说明；切换筛选或折叠保留草稿。保存和放弃更改位于列表下方，全局计数包含筛选后隐藏的修改。

页面上方设置正文处理模式、调用预设和各项预算，服务详情内分别勾选搜索与提取参与。修改参与范围不会删除密钥或自定义端点。保存仅提交修改路径；放弃更改同时清除未保存的模式、预算和参与范围。

18 项服务均提供总开关，控制该服务的全部能力。Firecrawl 的总开关同时控制搜索与提取。旧 `engines.firecrawl.enabled` 仍只控制搜索；设置页的「参与搜索」会反映并修改这个旧字段。GitHub 提取限定仓库 README / 文件。扩展服务开关和智谱通道均在保存后影响下一次调用，无需重挂插件。

密钥通过 DSH credentials 域写入。留空保持现值；保存成功清空输入框，刷新后只显示配置状态。环境变量提供的凭证遵循宿主只读规则。AnySearch 或 Firecrawl 的搜索与提取若使用不同引用，一次填写会更新两处引用；豆包两把密钥分别更新。

凭证引用名仍按上述配置契约设置。宿主通过 `--patch` 或 home patch 覆盖的配置不能由设置页改写，需要 GUI 编辑的值应放入可写 profile。配置状态只表示凭证存在，不代表 API 认证或接口健康。

凭证引用名、端点与调优字段仍通过配置文件管理。卡片命名空间绑定 `web-search-fetch` entry id；使用自定义 entry id 的部署需要单独处理卡片绑定。

## TinyFish、Serply 与免费 Bing

- TinyFish 默认搜索 `https://api.search.tinyfish.ai`，提取 `https://api.fetch.tinyfish.ai`；使用 `X-API-Key`，提取请求 Markdown 并设置 `ttl: 0`。
- Serply 默认 `https://api.serply.io`，使用 `X-Api-Key`；搜索为 `GET /v1/search/?q=...`，提取为 `POST /v1/request`，Markdown 响应按文本读取。
- Bing 默认 `https://cn.bing.com/search?q=...&format=rss`，无需凭证、不消耗 Serply 额度；只解析 RSS，不解析搜索 HTML，不绕过验证码。其他地区可根据访问条件覆盖 `baseURL`。重定向或非 RSS 响应会使该路失败，不影响其他搜索路。

Bing RSS 是免费公开 feed，不是具有正式 API 服务承诺的微软 Search API。TinyFish 当前 Search / Fetch 免费，受频率和用量限制；其 Agent / Browser 属于另外的付费产品，本插件未接入。Serply 提供限时的新账号免费 credits，后续可充值使用。具体规则见 [TinyFish 定价](https://www.tinyfish.ai/pricing) 和 [Serply 定价](https://serply.io/pricing)。

## Kimi REST 搜索与提取

Kimi 使用 `MOONSHOT_API_KEY`，默认基础地址为 `https://api.moonshot.cn`，鉴权为 Bearer。搜索和提取共用密钥；设置页提供凭证填写与启用开关，搜索档位通过配置文件设置。

| 配置或能力 | 请求 | 当前插件行为 |
| --- | --- | --- |
| `engines.kimi.searchMode: pro`（默认） | `POST /v1/tools/search_pro` | 返回摘要与相关正文片段，保留来源和日期 |
| `engines.kimi.searchMode: basic` | `POST /v1/tools/search` | 设置 `include_content: false`，只请求摘要 |
| 网页提取 | `POST /v1/tools/fetch` | 返回标题与 Markdown 正文 |

一次查询只选择一个搜索档位，不同时请求两档，也不通过聊天补全触发搜索。搜索请求最多取 20 条，接口 `timeout_seconds` 固定为 10；编排仍受 `search.maxFanoutMs` 约束。单条摘要与正文片段合计最多保留 6,000 字符。来源等级由 Kimi 返回，插件不据此验证真实性。

当前适配器未暴露官方 `sites`、`time_window` 或 Basic 整页正文选项。接口按次计费，赠送额度与账户条件以 [Kimi 官方定价](https://platform.kimi.com/docs/pricing/websearch)为准。协议依据见 [Kimi 官方接口说明](https://www.kimi.com/academy/best-practices-for-web-search)。

## AIHOT 可选 AI 资讯源

可在设置页打开 AIHOT 开关并保存，或在完整插件配置的 `engines` 中加入 `aihot: { enabled: true }`（或 `aihot: {}`）即可启用；默认 bundle 设置为关闭。原有配置覆盖规则不变，保留其他需要的服务条目。

默认 API 为 `https://aihot.news/api/v1/items`，匿名 GET，无需密钥；请求 `mode=all`、`window=7d`，关键词为原始查询去除首尾空白，长度须为 2–200 个 Unicode 字符。结果优先使用原文 URL，在摘要中保留原始来源、AIHOT canonical 和 attribution；`page.hasMore` 反映到结果截断状态。原生 `web_fetch` 另支持官方 Markdown 和 JSON API：热点、事件、日报、周报、月报、重置记录、精选快照与增量。它们直接读取指定接口，不加入通用网页提取竞争；路径和示例见 [AIHOT 接入](./aihot.md)。

仅此源使用条件 GET 缓存：按完整请求 URL 分开保存，普通接口默认 60 秒，重置接口默认至少 10 分钟；遵循上游 max-age / no-cache / no-store，最多 32 项。过期携带 ETag；304 复用已有内容，新的 200 替换旧条目，失败不返回过期数据。429 / 503 的 Retry-After 进入客户端冷却，搜索另维护熔断状态，不并发重试，不伪装客户端或绕过安全拦截。

[AIHOT 使用规则](https://aihot.news/terms)允许个人非商业、公益非商业及组织内部使用；对外提供代理、收费产品或再分发等需要书面授权。仓库 MIT 许可仅覆盖插件代码。只使用新 `/api/v1`，不使用即将停用的 `/api/public`。
