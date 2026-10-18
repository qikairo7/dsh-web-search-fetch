# 配置参考

配置契约以 [`src/index.ts`](https://github.com/qikairo7/dsh-web-search-fetch/blob/main/src/index.ts) 的 `Config` schema 为准。插件注册两个 id 为 `aggregated` 的 provider；工具定义由 DSH 提供。

## 凭证与启用范围

实际密钥由 DSH credentials 服务按次解析，不缓存。配置和仓库只保留引用名。

| 服务 | 默认凭证引用 | 搜索 | 提取 |
| --- | --- | --- | --- |
| AnySearch | `ANYSEARCH_API_KEY` | 是 | 是 |
| DeepSeek Search / Fetch（默认关闭） | `DEEPSEEK_API_KEY` | 是 | 是 |
| Firecrawl | `FIRECRAWL_API_KEY` | 是 | 是 |
| Tavily | `TAVILY_API_KEY` | 是 | 是 |
| Exa | `EXA_API_KEY` | 是 | 是 |
| Keenable | `KEENABLE_API_KEY` | 是 | 是 |
| Crawl4AI Cloud | `CRAWL4AI_API_KEY` | 是 | 是 |
| GitHub | `GITHUB_TOKEN` | 公开仓库 | README / 文件 |
| TinyFish | `TINYFISH_API_KEY` | 是 | 是 |
| Serply | `SERPLY_API_KEY` | 是 | 是 |
| Kimi | `MOONSHOT_API_KEY` | 是 | 是 |
| Bing RSS | 无需凭证 | 是 | 否 |
| AIHOT（可选） | 无需凭证 | AI 资讯关键词 | 专用 API |
| 硅基流动 | `SILICONFLOW_API_KEY` | 重排 | 否 |
| 阿里决策模型 | `DASHSCOPE_API_KEY` | 自动预设路由 | 否 |
| TypeSafe | `TYPESAFE_API_KEY` | 自动预设路由 | 否 |
| 直接 HTTP 抓取 | 无需凭证 | 否 | 静态资源 |

按能力和费用选择需要的服务，费用区别见 [服务费用](../README.md#服务费用)。配置方式与价格无关：AnySearch 通过 `search` 字段配置；Firecrawl 与 AnySearch 的提取通过 `fetch` 字段配置。用 `controls.searchServices` / `controls.fetchServices` 分别控制参与范围。`engines` 中的服务仅在列出且未设 `enabled: false` 时创建。凭证服务明确报告未配置时，该路不派发；状态未知时保留实际请求验证。

在 profile 的 `cordis.patch.yml` 中按 id 覆盖配置。DSH 配置覆盖不会逐字段深合并，需重述所需配置，包括扩展服务列表。`name` 是模块匹配条件，不能用它重命名已有模块。

```yaml
- id: web-search-fetch
  config:
    controls:
      mode: organize
      preset: auto
      maxRequests: 8
      maxOutputChars: 15000
    engines:
      deepseek:
        enabled: false
      tavily: {}
      exa: {}
      keenable: {}
      crawl4ai: {}
      github: {}
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
      decisionModel: decision-model-preview
      decisionTimeoutMs: 2000
      anysearchApiKeyEnv: ANYSEARCH_API_KEY
    fetch:
      staticRouting: true
      staticDomains: []
      perEngineTimeoutMs: 45000
      engineWeights:
        firecrawl: 3
        anysearch: 2
```

省略可选字段时使用默认值；不要用 YAML `null` 代替字符串。只启用 Tavily 和 Exa 时，将示例的 `engines` 整块改为这两项。每项支持 `enabled`、`apiKeyEnv`、`baseURL`、`fetchBaseURL`；Kimi 另支持 `searchMode`。TinyFish 的搜索和提取为不同域名，`baseURL` 只覆盖搜索，`fetchBaseURL` 覆盖提取。Firecrawl 扩展配置控制搜索，网页提取由 `fetch.firecrawlApiKeyEnv` / `fetch.firecrawlBaseURL` 控制。

`deepseek` 接入 DSH `0.2.1-rc.2` 对应的 DeepSeek 新版 Search / Fetch API。基础地址默认为 `https://api.deepseek.com/v1/tools`，插件追加 `/search` 与 `/fetch`；两者共用 `DEEPSEEK_API_KEY`。该服务默认关闭，开启后与宿主内置的同名能力相互独立：本插件仍通过 `aggregated` provider 聚合结果。搜索请求发送 `query`、`count` 和 `need_content: false`，结果数上限为 50；提取返回 Markdown 正文。官方按成功且有结果的请求计费，当前为每 1,000 次 5 元；失败、无结果与超时不计费。协议依据：[DeepSeek 网页搜索与抓取](https://api-docs.deepseek.com/zh-cn/guides/search/)。

AnySearch 提取凭证优先使用 `fetch.anysearchApiKeyEnv`，其次 `search.anysearchApiKeyEnv`。

## 硅基流动重排

插件固定使用 `BAAI/bge-reranker-v2-m3`，当前在硅基流动提供免费调用，仍需配置 API Key。可通过[硅基流动邀请链接](https://cloud.siliconflow.cn/i/E3nhNFP4)注册账号并创建密钥，在设置页的「硅基流动」项中保存，默认凭证引用为 `SILICONFLOW_API_KEY`。

`search.rerank` 在 schema 中默认为 `true`，作为旧配置的兼容初始值；新安装 bundle 显式设置 `controls.serviceEnabled.siliconflow: false`，默认不调用重排。显式设置 `controls.serviceEnabled.siliconflow` 时使用该值。重排不可用时保留 RRF 融合顺序。模型费用以[官方定价](https://siliconflow.cn/pricing)为准。

## 服务总开关

`controls.serviceEnabled` 按服务 ID 保存总开关，例如 `anysearch: false` 会停止 AnySearch 的搜索与提取。关闭不会清除凭证或参与范围，重新开启后沿用原配置。扩展服务首次开启时，设置页会补齐所需的 `engines` 条目；关闭总开关会保留该条目。

直接 HTTP 抓取的 ID 为 `http`。关闭后，静态 URL 返回 `WEB_PROVIDER_ERROR`，不会自动改走其他提取服务。需要读取静态资源时，重新开启该服务。

## 搜索与提取参数

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `search.maxFanoutMs` | 正整数，毫秒 | `10000` | 单路搜索时间预算 |
| `search.rrfK` | 正整数 | `60` | RRF 常数 |
| `search.rerankPool` | 正整数 | `20` | 重排候选数 |
| `search.rerank` | 布尔值 | `true` | 是否启用重排 |
| `search.rerankTimeoutMs` | 正整数，毫秒 | `3000` | 重排请求预算 |
| `search.decisionModel` | 字符串枚举 | `decision-model-preview` | 另可选 `Kev-4b`、`SemIf`、`diffusiongemma`、`jev-latest` |
| `search.decisionTimeoutMs` | 正整数，毫秒 | `2000` | 自动预设决策请求预算 |
| `fetch.staticRouting` | 布尔值 | `true` | 按 URL 分流 |
| `fetch.staticDomains` | 主机名数组 | `[]` | 静态主机及其子域 |
| `fetch.staticExtensions` | 字符串数组 | 内置表 | 静态扩展名规则 |
| `fetch.perEngineTimeoutMs` | 正整数，毫秒 | `45000` | 单路提取预算 |
| `fetch.blockPrivateAddresses` | 布尔值 | `true` | 在派发任何第三方提取服务前拒绝本机／内网目标 |
| `fetch.probeTimeoutMs` | 正整数，毫秒 | `15000` | 自动预设首路探测的限时 |
| `fetch.singleChannelEscalate` | 布尔值 | `false` | 单通道预设是否在失败或正文不足时改走多路整理 |
| `fetch.engineWeights` | 数值字典 | `{}` | 仅旧版 `select` 模式使用的正文权重 |

内置扩展名：`txt`、`text`、`xml`、`json`、`md`、`markdown`、`csv`、`tsv`、`rss`、`atom`、`yaml`、`yml`、`log`、`ini`、`toml`、`ics`、`vtt`、`srt`。显式 `[]` 清空扩展名匹配。域名填写主机名，不写协议、路径或通配符。默认权重 Firecrawl 为 `3`，AnySearch 及未单独配置的扩展为 `2`。

搜索凭证字段 `search.anysearchApiKeyEnv`、`search.siliconflowApiKeyEnv` 及 `fetch.firecrawlApiKeyEnv` 使用凭证表中的默认引用。`fetch.anysearchApiKeyEnv` 为空时按回落关系读取。

## 端点与传输

| 配置 | 默认值 |
| --- | --- |
| `search.anysearchBaseURL` / `fetch.anysearchBaseURL` | `https://api.anysearch.com` |
| `search.rerankBaseURL` | `https://api.siliconflow.cn/v1/rerank` |
| `fetch.firecrawlBaseURL` | `https://api.firecrawl.dev/v2/scrape` |

扩展服务端点见下表；映射实现在 [`ADDITIONAL_ENGINE_DEFAULTS`](https://github.com/qikairo7/dsh-web-search-fetch/blob/main/src/engines/additional/index.ts) 和适配器中。自定义地址会改变密钥发送目标，仅配置可信 API 地址。

| 扩展 ID | 默认引用 | 搜索基础地址 | 提取基础地址 |
| --- | --- | --- | --- |
| `tavily` | `TAVILY_API_KEY` | `https://api.tavily.com` | 同搜索 |
| `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1/tools` | 同搜索 |
| `exa` | `EXA_API_KEY` | `https://api.exa.ai` | 同搜索 |
| `keenable` | `KEENABLE_API_KEY` | `https://api.keenable.ai` | 同搜索 |
| `crawl4ai` | `CRAWL4AI_API_KEY` | `https://api.crawl4ai.com` | 同搜索 |
| `github` | `GITHUB_TOKEN` | `https://api.github.com` | 同搜索 |
| `firecrawl` | `FIRECRAWL_API_KEY` | `https://api.firecrawl.dev` | 网页提取使用独立 `fetch` 配置 |
| `tinyfish` | `TINYFISH_API_KEY` | `https://api.search.tinyfish.ai` | `https://api.fetch.tinyfish.ai` |
| `serply` | `SERPLY_API_KEY` | `https://api.serply.io` | 同搜索 |
| `kimi` | `MOONSHOT_API_KEY` | `https://api.moonshot.cn` | 同搜索 |
| `bing` | 无 | `https://cn.bing.com` | — |
| `aihot` | 无 | `https://aihot.news` | 仅专用 API |

扩展项字段：`enabled`（布尔值，条目内默认 `true`）、`apiKeyEnv`（字符串引用名）、`baseURL` 和 `fetchBaseURL`（字符串基础地址）。Kimi 的 `searchMode` 为 `basic` 或 `pro`，省略时使用 `pro`。省略整个条目不会创建该扩展；新安装 bundle 仅启用 Firecrawl、Tavily 两个扩展及 AnySearch 服务；DeepSeek 新版 API、其他远程服务与重排默认关闭。直接 HTTP 抓取作为静态资源基础能力保留。已保存的显式开关设置优先于安装默认。

## 提取路由

`staticDomains` 按 URL 匹配，命中时走内置 HTTP。GitHub 仓库／blob URL 若匹配已启用、已选中、凭证可用且未熔断的 GitHub 服务，则优先使用动态提取；blob 的 `.md` 等扩展名不视为原始静态文件。其余 URL 命中静态扩展名时走内置 HTTP。`staticExtensions` 省略时使用内置表；显式配置会替换整张表。没有预先的 Content-Type 探测。

这里的 HTTP 是聚合插件复用的 DSH 抓取组件，直接访问目标网站，不调用 DeepSeek 模型 API。模型处理工具结果时仍会产生模型 token 用量；直接抓取本身不消耗 DeepSeek 模型额度。

已启用且在提取参与列表中的 AIHOT 专用 API 在通用分流前直接读取，不调用其他提取服务。其余 URL 在 `staticRouting: false` 时全部使用内置 HTTP 提取。动态路径默认整理多路正文，单路限时 45 秒、操作总限时 50 秒；规则见[正文整理](./content-organization.md)。限流按冷却时间恢复；额度耗尽按本地日期恢复。搜索与提取的熔断器分别维护进程内状态。

## 正文与调用控制

`controls` 支持设置页修改，保存后下一次操作读取配置快照；正在执行的操作继续使用其原有预算。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `organize` | 默认正文整理；`select` 返回旧版单份正文 |
| `preset` | `auto` | `auto` 按本地规则在单通道与多通道之间判断；`single` 单通道、`multi` 多通道、`free` 免费接口、`balanced` 最多三路、`deep` 所选全部服务、`custom` 自定义 |
| `decisionRouting` | `off` | 自动预设的判断方式。`off` 用本地规则，不调用模型；`model` 先问决策模型，失败时改回本地规则 |
| `searchServices` | 全部搜索服务 ID | 按数组顺序选择，空数组禁用搜索派发 |
| `fetchServices` | 全部提取服务 ID | 普通提取及 AIHOT 参与范围，静态 HTTP 独立 |
| `maxSearchServices` | `13` | 每个查询首轮派发的服务上限，范围 1–13；上限按首轮计，空结果补派是兜底，可超出该上限多接触一个服务（与提取侧 `singleChannelEscalate` 同型） |
| `maxFetchServices` | `11` | 每个 URL 的普通提取服务上限，范围 1–11 |
| `maxRequests` | `32` | 每次 provider 操作的插件 HTTP 请求上限，范围 1–256 |
| `searchDeadlineMs` | `15000` | 搜索操作总限时，范围 1–3,600,000 毫秒 |
| `fetchDeadlineMs` | `50000` | 提取操作总限时，范围 1–3,600,000 毫秒 |
| `maxOutputChars` | `15000` | 单页整理输出的字符上限（含来源与说明），范围 1,000–1,000,000 |

免费接口预设只派发 TinyFish、Bing RSS、GitHub 和已主动启用的 AIHOT，仍遵守凭证、用途和限流要求。硅基流动免费标准模型可继续重排。免费额度、试用额度和付费订阅不属于此预设；使用自定义端点的服务也不会被当作免费。静态 HTTP 路径保持独立，模型 token 用量不受此预设控制。

自动预设不需要用户切换模式。默认由本地规则判断调用范围：查询含对比、比较、综述、调研、资料、证据、引用、来源、最新、新闻、今日、近期、最近、热点或年份等意图时走多通道（所选服务范围）；官方文档意图与受支持技术项目同时命中，或查询带显式 `site:` 时同样走多通道；其余走单通道（1 路）。提取侧另有首路探测，见下文。把 `controls.decisionRouting` 设为 `model` 后改为先调用 `search.decisionModel`，`fast` 一路、`balanced` 三路、`deep` 已选服务范围。决策路由默认关闭，不需要模型凭证。

搜索走单通道时（自动档判定为单通道，或固定 `single` 预设），唯一一路成功返回却没有任何可用结果——空返回，或有返回但全被相关性过滤——会自动补派一次多路：排除已派发的那一路，按参与列表、启停、凭证、`maxSearchServices` 和剩余 `maxRequests` 选路，补派结果与首轮结果一起融合、过滤并写进说明（如「单路 anysearch 空结果，补派选择 2 路搜索」）。该路失败、超时、取消或被限流时不补派；预算不足时不补派，并在说明里写明原因。补派只发生一次，多通道预设不触发。

决策模型不可用、超时、凭证缺失或返回不可用结果时，插件记录降级原因并改按本地规则执行，本次仍返回搜索结果或提取正文；降级说明写入操作说明。自动预设调整派发数量和充分结果后的等待时间，不自动开启扩展、提高请求预算或改变正文整理规则。

单通道预设只派发 1 路，搜索不调用重排、不做官方域名补充检索；提取直接返回该路原文，不加来源标记。单通道通道失败或正文不足时默认原样失败或原样返回；把 `fetch.singleChannelEscalate` 设为 `true` 才改走多路整理。搜索侧的单通道在唯一一路成功却没有任何可用结果时自动补派一次多路，不受该开关控制，见上文。

多通道下服务同时启动。搜索至少三家服务成功、已有足够相关且去重的结果后，开始宽限等待；官方文档请求还需取得相关官方来源。正文整理需至少三家服务返回同标题、共同长段落且各有不少于 1,200 字符的段落正文。`balanced` 与单通道外的自动档宽限 500 毫秒、派发后至少等待 1,200 毫秒；决策结果为 `deep` 时宽限 1,500 毫秒、至少等待 2,500 毫秒。宽限内返回的独有内容仍纳入整理，结束时取消未完成渠道，说明可能遗漏并设置 `truncated`。短页面或多路不一致时继续等待原预算；单通道预设不采用此结束条件。

明确的受支持技术项目官方文档意图最多增加两次限定域名检索，与基础搜索并发、计入同一 HTTP 请求预算；已有 `site:` 时不追加。同一服务的补充查询不增加 RRF 票数。域名与相关性规则见[架构说明](../DESIGN.md#搜索)。

`Kev-4b`、`SemIf`、`diffusiongemma` 和阿里 `decision-model-preview` 当前由服务方提供免费调用，仍需对应 API Key；TypeSafe `jev-latest` 为付费模型。费用和额度以服务方当前页面为准。硅基流动模型使用 `SILICONFLOW_API_KEY`，阿里使用 `DASHSCOPE_API_KEY`，TypeSafe 使用 `TYPESAFE_API_KEY`。TypeSafe 直连在部分地区返回 HTTP 451；决策请求会复用 DSH 启动时安装的出站代理策略。

均衡预设按参与列表顺序，从已启用、未熔断且具备凭证的适用服务中最多派发三路。多通道、深度和自定义预设按指定数量上限派发，不自动开启扩展或提高预算。请求上限计入额度查询、重试和重排，不等于人民币费用上限，也不限制上游服务的内部工具调用次数。HTTP 静态路径沿用宿主响应、重定向和长度限制；插件总限时仍适用。日志记录插件请求次数，返回结果附带自动档判定、预算耗尽、超时或未派发说明。

## 两段式提取与地址守卫

自动预设在整理模式（`mode: organize`）下先走两段式提取：按参与顺序选出第一路，在 `fetch.probeTimeoutMs`（默认 15 秒）内取一次。结果为 2xx、返回目标与请求目标一致（同资源 HTTPS 升级允许）、不是登录或挑战页，且段落字符数不少于 400 时，直接把该路原文返回，不加 `提取来源：`、不加补充片段、不加尾注。否则升级为多路整理，已取得的这一路结果并入候选，不会重复请求同一服务。`single` 预设同样只派发一路，但按用户的明确选择原样返回，即使正文很薄；`singleChannelEscalate: true` 时才在失败或过薄时升级。

地址守卫在 AIHOT 专用 API 判定、URL 适配器和静态/动态分流之前执行。字面量地址直接判定；主机名先解析，任一答案为回环、私网、链路本地、保留或转换前缀地址时，本次以 `WEB_BLOCKED_URL` 拒绝，且不派发任何第三方引擎。解析失败不拦截。`fetch.staticDomains` 显式列出的主机跳过守卫，改由内置 HTTP 提取器按自身策略处理；`fetch.blockPrivateAddresses: false` 关闭整条守卫（仅供测试或明确放行）。

插件的 API 请求拒绝 HTTP 重定向，避免额外请求绕过计数或把鉴权信息转交其他端点；自定义端点应填写最终 API 地址。操作总限时到期时返回已完成的搜索或提取结果，并标记 `truncated`；搜索重排未完成时保留 RRF 顺序。尚无可用结果时返回对应超时错误，调用方主动取消则返回 `WEB_ABORTED`。

GitHub 提取只识别仓库根 URL 与 `/blob/<ref>/<path>`，通过 README／contents API 读取正文。同仓库 README 归属请求的仓库根页，其他仓库的返回地址仍由正文整理拒绝。该专用路径保留显式 HTTP 路由与静态域名配置的优先级，不提供任意 GitHub 网页解析。含斜杠的分支名暂未专门解析，二进制内容不作为正文返回。

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

匿名额度与免费接口预设分别处理：`free` 排除额度型服务；默认 `auto` 预设使用本地规则，不需要决策模型凭证；把判断方式切到决策模型时才需要凭证。其他服务作为增强按需开启，已保存的显式开关与凭证保持不变；旧版未设置开关的服务采用新版默认。依据见 [README 匿名访问说明](../README.md#服务费用)。

设置页顶部提供两个显式入口。「配置自动决策」选择自动预设并展开调用设置，可把判断方式切到决策模型并填写对应平台凭证；「直接体验匿名服务」选择自定义固定预设，将搜索与提取参与范围限制为官方端点且未配任何一面密钥的 AnySearch、Firecrawl、Tavily，启用这些服务与直接 HTTP 抓取，关闭其他服务和重排。两者均暂存修改，需点击「保存更改」才生效，也可放弃更改。

匿名入口不清除凭证、不改自定义端点，也不写入新的密钥。凭证状态尚未读取、读取失败、已有完整或部分密钥、存在密钥草稿或自定义端点的服务不会被选入；没有符合条件的服务时入口禁用并说明原因。选择后另外配置密钥会使对应服务使用账户额度，凭证不会因预设而被忽略。

打开「设置 → 内置插件 → 网络搜索与提取」。卡片与 README 的完整接入清单一致，覆盖 15 项搜索／提取／重排服务、14 个凭证位，另提供可选的五款决策模型与判断方式切换，包括无需凭证的 Bing RSS、AIHOT 和直接 HTTP 抓取。

用服务名称或用途搜索，按搜索 / 提取 / 重排筛选，或只查看待配置、未保存及无需密钥的服务。点击服务行展开密钥与说明；切换筛选或折叠保留草稿。保存和放弃更改位于列表下方，全局计数包含筛选后隐藏的修改。

页面上方设置正文处理模式、调用预设和各项预算，服务详情内分别勾选搜索与提取参与。修改参与范围不会删除密钥或自定义端点。保存仅提交修改路径；放弃更改同时清除未保存的模式、预算和参与范围。

15 项服务均提供总开关，控制该服务的全部能力。Firecrawl 的总开关同时控制搜索与提取。旧 `engines.firecrawl.enabled` 仍只控制搜索；设置页的「参与搜索」会反映并修改这个旧字段。GitHub 提取限定仓库 README / 文件。扩展服务开关在保存后影响下一次调用，无需重挂插件。

密钥通过 DSH credentials 域写入。留空保持现值；保存成功清空输入框，刷新后只显示配置状态。环境变量提供的凭证遵循宿主只读规则。AnySearch 或 Firecrawl 的搜索与提取若使用不同引用，一次填写会更新两处引用。

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

自动决策位于「调用设置 → 自动决策」。判断方式默认是本地规则；切到决策模型后，选择模型并只显示对应平台的密钥填写位。阿里与 TypeSafe 不是搜索服务，没有独立的服务启停开关。判断方式、模型与凭证在保存后用于下一次请求。
