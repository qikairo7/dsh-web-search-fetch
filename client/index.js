window.__ModuleLoader__.load({
	id: "dsh-web-search-fetch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
        const React = require("react");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
        //#region locales
        const zh = {
            servicesTitle: '服务与凭证', settingsTitle: '调用设置', advanced: '高级调用限制', advancedHint: '请求数、超时与正文长度',
            startGuide: '推荐服务与匿名额度', organizeHint: '合并多份正文，去重与互补，保留来源与差异。', selectHint: '兼容旧版，仅返回一份提取正文。',
            customPresetHint: '按服务开关、参与范围与调用限制执行。', balancedPresetHint: '每次最多调用三路服务，兼顾覆盖范围与调用用量。', deepPresetHint: '调用已选择且可用的服务，仍受调用限制约束。',
            invalidNumber: '请输入范围内的整数：', invalidControls: '请先修正调用限制', resetField: '撤销此项', range: '范围',

            title: '网络搜索与提取', intro: '新安装默认启用 AnySearch、Firecrawl、Tavily，使用官方匿名额度，无需填写密钥；其他服务按需开启作为增强。匿名额度有限流，填写密钥后使用账户额度。',
            controlsTitle: '正文整理与调用控制', modeLabel: '网页正文处理', organizeMode: '整理正文', selectMode: '单份正文',
            presetLabel: '调用预设', customPreset: '自定义', freePreset: '免费接口', balancedPreset: '均衡', deepPreset: '深度',
            maxSearchServices: '每个查询的搜索服务上限', maxFetchServices: '每个 URL 的提取服务上限', maxRequests: '每次操作的 HTTP 请求上限',
            searchDeadlineMs: '搜索总限时（毫秒）', fetchDeadlineMs: '提取总限时（毫秒）', maxOutputChars: '整理输出上限（字符）',
            participateSearch: '参与搜索', participateFetch: '参与提取',
            controlsHint: '整理保留原文和提取来源；差异不会自动判定真伪。请求上限包括重试、额度检查与重排，不是金额上限；宿主 HTTP 抓取另有独立限制。处理情况见本次工具结果和日志。',
            freeHint: '免费预设仅使用 Bing RSS、TinyFish、GitHub 公开 API 和已启用的 AIHOT；部分仍需密钥，AIHOT 仍受用途限制。不调用免费额度用尽后收费的接口。',
            keysHint: '留空保留原密钥。保存后只显示配置状态。', keyHint: '留空保留原密钥',
            anysearch: 'AnySearch API Key', zhipu: '智谱 API Key', zhihu: '知乎 Access Secret',
            firecrawl: 'Firecrawl API Key', tavily: 'Tavily API Key', exa: 'Exa API Key', keenable: 'Keenable API Key',
            crawl4ai: 'Crawl4AI Cloud API Key', github: 'GitHub Token', qianfan: '百度千帆 API Key',
            'doubao-search': '豆包搜索 API Key', 'doubao-fetch': '豆包提取 API Key',
            tinyfish: 'TinyFish API Key', serply: 'Serply API Key', kimi: 'Kimi API Key', siliconflow: '硅基流动 API Key',
            'anysearch-service': 'AnySearch AI', 'zhipu-service': '智谱', 'zhihu-service': '知乎',
            'firecrawl-service': 'Firecrawl', 'tavily-service': 'Tavily', 'exa-service': 'Exa', 'keenable-service': 'Keenable',
            'crawl4ai-service': 'Crawl4AI Cloud', 'github-service': 'GitHub', 'qianfan-service': '百度千帆 AI 搜索',
            'doubao-service': '豆包 Custom', 'tinyfish-service': 'TinyFish', 'serply-service': 'Serply', 'kimi-service': 'Kimi',
            'bing-service': 'Bing RSS', 'aihot-service': 'AIHOT', 'siliconflow-service': '硅基流动', 'http-service': '直接 HTTP 抓取',
            all: '全部', search: '搜索', fetch: '提取', rerank: '重排', searchFetch: '搜索 · 提取',
            githubCapabilities: '仓库搜索 · README / 文件提取', staticFetch: '静态资源提取', aiNews: 'AI 资讯搜索 · API 读取',
            anonymous: '匿名额度', recommended: '推荐', enhancement: '可选增强', configured: '已配置', unconfigured: '未配密钥', partial: '部分配置', staged: '待保存', readOnly: '只读',
            checking: '读取中…', statusFailed: '状态未知', noKey: '无需密钥', configure: '配置',
            enable: '启用',
            searchLabel: '查找服务', searchPlaceholder: '搜索服务名称或用途', clearSearch: '清空搜索',
            statusFilter: '筛选配置状态', allStatus: '全部状态', needsKey: '未配置凭证', pending: '有未保存修改',
            servicesCount: '个服务', keysCount: '个凭证位', matches: '项匹配', noMatches: '没有匹配的服务',
            noMatchesHint: '试试其他关键词，或清除筛选条件。', resetFilters: '清除筛选',
            transportLabel: '智谱搜索通道', transportAnthropic: '套餐额度', transportToolsApi: '按次计费',
            transportHint: 'GLM Coding Plan 为付费订阅；tools-api 使用按次计费的 search_pro。套餐额度不属于免费额度，两条通道共用此密钥。',
            baseHint: '启用后按参与范围调用。关闭会保留凭证与参与范围。',
            extensionHint: '启用并保存后，参与下一次搜索或适用网页的提取。',
            anysearchHint: '推荐服务。官方搜索与提取支持匿名额度，按 IP 限流；配置 API Key 后使用账户额度。自定义端点需要密钥。',
            tavilyHint: '推荐服务。官方 search / extract 支持 keyless 匿名额度，受共享限流约束；配置 API Key 后使用账户额度。自定义端点需要密钥。',
            firecrawlHint: '推荐服务。官方端点未配置密钥时使用匿名额度，受服务方额度及限流约束。填写密钥后使用账户额度，自定义端点仍需密钥。总开关控制搜索与提取，下方可分别选择参与范围。',
            githubHint: '搜索公开仓库；提取仅适用于仓库 README 和 blob 文件 URL。',
            doubaoHint: '搜索和提取分别使用密钥，可独立配置。',
            tinyfishHint: 'Search 与 Fetch 使用独立 API 地址，共用此密钥。',
            serplyHint: 'Google 搜索与 Markdown 网页提取，共用此密钥。',
            kimiHint: 'REST 搜索与 Markdown 提取，共用密钥。搜索默认 Pro；Basic 在配置文件中设置。接口按次计费。',
            bingHint: '免费公开 RSS 搜索，无需密钥。它只提供搜索，不经过 Serply 计费接口。',
            aihotHint: '默认关闭。搜索近 7 天 AI 资讯；原生 web_fetch 可读取热点、报告与精选 API，保留来源和署名。',
            aihotTerms: '使用范围：个人非商业、公益及组织内部使用；对外代理、收费或再分发须取得书面授权。',
            rerankHint: '使用硅基流动免费模型 BAAI/bge-reranker-v2-m3，仍需 API Key。对融合结果重排，不计入搜索来源数量。',
            siliconflowInvite: '注册硅基流动并获取 API Key（邀请链接）',
            httpHint: '静态资源由 DSH HTTP 组件直接抓取，无需密钥。关闭后静态 URL 会报错，不会自动改走其他提取服务。',
            enableWarning: '此服务尚未启用。填写密钥后，记得打开右侧开关并保存。',
            missingWarning: '已启用，但凭证尚未配置；此路可能无法返回结果。',
            unavailable: '插件当前未加载，暂时无法配置。', readOnlyHint: '当前部署配置为只读。',
            saveFailed: '保存未全部完成。部分值可能已写入，草稿已保留，可重试。',
            save: '保存更改', saving: '保存中…', discard: '放弃更改', saved: '已保存，下一次调用生效',
            clean: '暂无待保存更改', dirty: '项未保存', refresh: '刷新凭证状态',
        };
        const en = {
            servicesTitle: 'Services & credentials', settingsTitle: 'Call settings', advanced: 'Advanced limits', advancedHint: 'Requests, deadlines and content length',
            startGuide: 'Recommended services and anonymous quotas', organizeHint: 'Combine extracts, remove duplicates and retain sources and differences.', selectHint: 'Legacy behavior: return one extract.',
            customPresetHint: 'Use service switches, participation and call limits.', balancedPresetHint: 'Use up to three services per operation to balance coverage and usage.', deepPresetHint: 'Use selected, available services within the call limits.',
            invalidNumber: 'Enter an integer within ', invalidControls: 'Correct the call limits first', resetField: 'Undo this field', range: 'Range',

            title: 'Web search & fetch', intro: 'New installations enable AnySearch, Firecrawl and Tavily with official anonymous quotas. Enable other services when needed. Anonymous access is rate-limited; configured keys use account quotas.',
            controlsTitle: 'Content organization and call limits', modeLabel: 'Page content', organizeMode: 'Organize', selectMode: 'Single extract',
            presetLabel: 'Call preset', customPreset: 'Custom', freePreset: 'Free APIs', balancedPreset: 'Balanced', deepPreset: 'Deep',
            maxSearchServices: 'Search services per query', maxFetchServices: 'Extraction services per URL', maxRequests: 'HTTP requests per operation',
            searchDeadlineMs: 'Search deadline (ms)', fetchDeadlineMs: 'Extraction deadline (ms)', maxOutputChars: 'Organized output limit (characters)',
            participateSearch: 'Participate in search', participateFetch: 'Participate in extraction',
            controlsHint: 'Retains original text and extraction provenance without deciding which variant is true. Request limits include retries, quota checks and reranking, not monetary costs. Host HTTP retrieval has separate limits. Processing notes appear in tool results and logs.',
            freeHint: 'Free preset uses Bing RSS, TinyFish, public GitHub APIs and enabled AIHOT only. Keys may still be required; AIHOT usage terms apply. APIs with paid overages are excluded.',
            keysHint: 'Leave blank to keep a key. Saved keys show status only.', keyHint: 'Leave blank to keep the key',
            anysearch: 'AnySearch API key', zhipu: 'Zhipu API key', zhihu: 'Zhihu access secret',
            firecrawl: 'Firecrawl API key', tavily: 'Tavily API key', exa: 'Exa API key', keenable: 'Keenable API key',
            crawl4ai: 'Crawl4AI Cloud API key', github: 'GitHub token', qianfan: 'Baidu Qianfan API key',
            'doubao-search': 'Doubao search API key', 'doubao-fetch': 'Doubao extraction API key',
            tinyfish: 'TinyFish API key', serply: 'Serply API key', kimi: 'Kimi API key', siliconflow: 'SiliconFlow API key',
            'anysearch-service': 'AnySearch AI', 'zhipu-service': 'Zhipu', 'zhihu-service': 'Zhihu',
            'firecrawl-service': 'Firecrawl', 'tavily-service': 'Tavily', 'exa-service': 'Exa', 'keenable-service': 'Keenable',
            'crawl4ai-service': 'Crawl4AI Cloud', 'github-service': 'GitHub', 'qianfan-service': 'Baidu Qianfan AI Search',
            'doubao-service': 'Doubao Custom', 'tinyfish-service': 'TinyFish', 'serply-service': 'Serply', 'kimi-service': 'Kimi',
            'bing-service': 'Bing RSS', 'aihot-service': 'AIHOT', 'siliconflow-service': 'SiliconFlow', 'http-service': 'Direct HTTP fetch',
            all: 'All', search: 'Search', fetch: 'Extraction', rerank: 'Reranking', searchFetch: 'Search · Extraction',
            githubCapabilities: 'Repository search · README / Files', staticFetch: 'Static resources', aiNews: 'AI news search · API reading',
            anonymous: 'Anonymous quota', recommended: 'Recommended', enhancement: 'Optional', configured: 'Configured', unconfigured: 'Needs key', partial: 'Partially configured', staged: 'Unsaved', readOnly: 'Read-only',
            checking: 'Checking…', statusFailed: 'Status unknown', noKey: 'No key needed', configure: 'Configure',
            enable: 'Enable',
            searchLabel: 'Find a service', searchPlaceholder: 'Search by service or purpose', clearSearch: 'Clear search',
            statusFilter: 'Filter configuration status', allStatus: 'All statuses', needsKey: 'Needs credentials', pending: 'Unsaved changes',
            servicesCount: 'services', keysCount: 'credential inputs', matches: 'matches', noMatches: 'No matching services',
            noMatchesHint: 'Try another keyword or clear the filters.', resetFilters: 'Clear filters',
            transportLabel: 'Zhipu search transport', transportAnthropic: 'Coding Plan', transportToolsApi: 'Pay per call',
            transportHint: 'Coding Plan is a paid subscription; tools-api uses pay-per-call search_pro. Plan credits are not free credits. Both share this key.',
            baseHint: 'Enable to use the selected capabilities. Disabling preserves credentials and participation settings.',
            extensionHint: 'Enable and save to join the next search or supported page extraction.',
            anysearchHint: 'Recommended. Official search and extraction support anonymous quotas with IP rate limits. A configured key uses account quotas; custom endpoints require a key.',
            tavilyHint: 'Recommended. Official search and extract support keyless access with a shared rate limit. A configured key uses account quotas; custom endpoints require a key.',
            firecrawlHint: 'Recommended. Official endpoints use anonymous credits without a key, subject to quota and rate limits. A configured key uses account credits; custom endpoints still require a key. The switch controls both search and extraction; select each capability below.',
            githubHint: 'Search public repositories; extract only repository README and blob file URLs.',
            doubaoHint: 'Search and extraction use separate credentials.',
            tinyfishHint: 'Separate Search and Fetch API endpoints share this key.',
            serplyHint: 'Google search and Markdown extraction share this key.',
            kimiHint: 'REST search and Markdown extraction share this key. Pro by default; configure Basic in the profile. APIs are billed per call.',
            bingHint: 'Free public RSS search without a key or Serply billing. Search only.',
            aihotHint: 'Off by default. Search recent AI news and read hot topics, reports and selected-item APIs through native web_fetch with attribution.',
            aihotTerms: 'Personal noncommercial, charitable and internal use; external proxies, paid use or redistribution require written authorization.',
            rerankHint: 'Uses the free BAAI/bge-reranker-v2-m3 model on SiliconFlow. An API key is required. Reranks fused results; excluded from search source counts.',
            siliconflowInvite: 'Register with SiliconFlow and get an API key (invitation link)',
            httpHint: 'DSH HTTP fetches static resources without a key. When disabled, static URLs return an error and do not switch to other extraction services.',
            enableWarning: 'This service is off. Enable it and save after entering a key.',
            missingWarning: 'Enabled without credentials. This source may not return results.',
            unavailable: 'The plugin is not loaded.', readOnlyHint: 'This deployment is read-only.',
            saveFailed: 'Some writes failed. Some may have succeeded. Drafts are preserved for retry.',
            save: 'Save changes', saving: 'Saving…', discard: 'Discard changes', saved: 'Saved; applies to the next call',
            clean: 'No unsaved changes', dirty: 'unsaved changes', refresh: 'Refresh credential status',
        };
        //#endregion
		//#region surface
		/**
		* Namespace of this plugin's settings section. Spelled here rather than
		* imported: a client package must not depend on a Host package.
		*/
		const SETTINGS_NS = "web-search-fetch";
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.webSearchFetch";
		/** Config path of the one control this card edits through the settings form. */
		const TRANSPORT_PATH = ["search", "zhipuTransport"];
        const NUMBER_CONTROLS = {
            maxSearchServices: { initial: 16, min: 1, max: 16 },
            maxFetchServices: { initial: 11, min: 1, max: 11 },
            maxRequests: { initial: 32, min: 1, max: 256 },
            searchDeadlineMs: { initial: 15000, min: 1, max: 3600000 },
            fetchDeadlineMs: { initial: 50000, min: 1, max: 3600000 },
            maxOutputChars: { initial: 100000, min: 1000, max: 1000000 },
        };
        const EXTENSIONS = ["tavily", "exa", "keenable", "crawl4ai", "github", "qianfan", "doubao", "firecrawl", "tinyfish", "serply", "kimi", "bing", "aihot"];
		/**
		* The complete credential slots, mirroring `src/settings-surface.ts`.
		*
		* A client bundle cannot import a Host module, so the table is restated
		* here; a node-half test pins the two copies together by parsing this
		* literal, which is why it is written as JSON rather than as JS shorthand.
		* Each entry names the config paths that may override its reference,
		* outermost first, and the reference used when none does.
		*/
		const CREDENTIAL_SLOTS = [
			{"id": "anysearch", "overridePaths": [["search", "anysearchApiKeyEnv"]], "defaultRef": "ANYSEARCH_API_KEY", "additionalPaths": [["fetch", "anysearchApiKeyEnv"]]},
			{"id": "zhipu", "overridePaths": [["search", "zhipuApiKeyEnv"], ["apiKeyEnv"]], "defaultRef": "ZHIPU_API_KEY"},
			{"id": "zhihu", "overridePaths": [["search", "zhihuAccessSecretEnv"]], "defaultRef": "ZHIHU_ACCESS_SECRET"},
			{"id": "firecrawl", "overridePaths": [["fetch", "firecrawlApiKeyEnv"]], "defaultRef": "FIRECRAWL_API_KEY", "additionalPaths": [["engines", "firecrawl", "apiKeyEnv"]]},
			{"id": "tavily", "overridePaths": [["engines", "tavily", "apiKeyEnv"]], "defaultRef": "TAVILY_API_KEY"},
			{"id": "exa", "overridePaths": [["engines", "exa", "apiKeyEnv"]], "defaultRef": "EXA_API_KEY"},
			{"id": "keenable", "overridePaths": [["engines", "keenable", "apiKeyEnv"]], "defaultRef": "KEENABLE_API_KEY"},
			{"id": "crawl4ai", "overridePaths": [["engines", "crawl4ai", "apiKeyEnv"]], "defaultRef": "CRAWL4AI_API_KEY"},
			{"id": "github", "overridePaths": [["engines", "github", "apiKeyEnv"]], "defaultRef": "GITHUB_TOKEN"},
			{"id": "qianfan", "overridePaths": [["engines", "qianfan", "apiKeyEnv"]], "defaultRef": "QIANFAN_API_KEY"},
			{"id": "doubao-search", "overridePaths": [["engines", "doubao", "apiKeyEnv"]], "defaultRef": "DOUBAO_SEARCH_API_KEY"},
			{"id": "doubao-fetch", "overridePaths": [["engines", "doubao", "fetchApiKeyEnv"]], "defaultRef": "DOUBAO_FETCH_API_KEY"},
			{"id": "tinyfish", "overridePaths": [["engines", "tinyfish", "apiKeyEnv"]], "defaultRef": "TINYFISH_API_KEY"},
			{"id": "serply", "overridePaths": [["engines", "serply", "apiKeyEnv"]], "defaultRef": "SERPLY_API_KEY"},
			{"id": "kimi", "overridePaths": [["engines", "kimi", "apiKeyEnv"]], "defaultRef": "MOONSHOT_API_KEY"},
			{"id": "siliconflow", "overridePaths": [["search", "siliconflowApiKeyEnv"]], "defaultRef": "SILICONFLOW_API_KEY"}
		];
		/** DOM id of one slot's key field. */
		function slotDomId(id) {
			return `plugin-config-web-search-fetch-${id}`;
		}
		/** Read one config path out of a served settings section. */
		function readPath(root, path) {
			let node = root;
			for (const segment of path) {
				if (typeof node !== "object" || node === null) return void 0;
				node = node[segment];
			}
			return node;
		}
		/**
		* Resolve every slot to the reference the served section names.
		* @param value - the served settings value, or undefined before the first read.
		* @returns one `{ id, ref }` per slot, in slot order.
		*/
		function resolveSlotRefs(value) {
            return CREDENTIAL_SLOTS.map(slot => {
                const ref = slot.overridePaths.map(path => readPath(value, path)).find(name => typeof name === 'string' && name.length) ?? slot.defaultRef;
                const refs = [...new Set([ref, ...(slot.additionalPaths ?? []).map(path => readPath(value, path)).filter(name => typeof name === 'string' && name.length)])];
                return { id: slot.id, ref, refs };
            });
        }
		//#endregion
		//#region controller
		/**
		* The page's staged form over the `web-search-fetch` settings namespace and
		* the credentials domain.
		*
		* Two kinds of control, deliberately kept apart. The Zhipu transport is a
		* settings field, so a save writes it as one path-addressed mutation — a
		* nested path, which is why this stages its own edits rather than using the
		* shared `SettingsFormModel` (that model addresses top-level fields only).
		* The service credentials are credential values: their literal never rides a
		* response, so the page learns only whether one is configured, and writes
		* them through the credentials domain addressed by the reference the served
		* section names. One save covers both, and a blank key draft writes nothing,
		* which keeps the stored key rather than clearing it.
		*/
		var WebSearchFetchCardController = class {
			scope;
			ctx;
			store;
			unsubscribe;
			/** Staged transport, or undefined while the served value stands. */
			transportDraft;
            engineDrafts = new Map();
            controlDrafts = new Map();
            numberDrafts = new Map();
            controls() {
                return { mode: 'organize', preset: 'custom', ...Object.fromEntries(Object.entries(NUMBER_CONTROLS).map(([name, spec]) => [name, spec.initial])),
                    serviceEnabled: {}, searchServices: SERVICES.filter(service => service.capabilities.includes('search')).map(service => service.id),
                    fetchServices: SERVICES.filter(service => service.capabilities.includes('fetch') && service.id !== 'http').map(service => service.id),
                    ...this.section()?.controls, ...Object.fromEntries(this.controlDrafts) };
            }
            numberField(name) {
                const spec = NUMBER_CONTROLS[name];
                const served = this.section()?.controls?.[name] ?? spec.initial;
                const text = this.numberDrafts.get(name) ?? String(this.controlDrafts.get(name) ?? served);
                const value = Number(text);
                return { text, servedText: String(served), min: spec.min, max: spec.max,
                    dirty: this.numberDrafts.has(name) || this.controlDrafts.has(name),
                    invalid: !/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value < spec.min || value > spec.max };
            }
            editNumber(name, text) {
                if (this.saving || !Object.hasOwn(NUMBER_CONTROLS, name)) return;
                this.baselineRevision ??= this.scope.getSnapshot().revision;
                this.numberDrafts.set(name, text);
                const field = this.numberField(name);
                if (field.invalid) this.controlDrafts.delete(name);
                else if (Number(text) === Number(field.servedText)) {
                    this.numberDrafts.delete(name);
                    this.controlDrafts.delete(name);
                } else this.controlDrafts.set(name, Number(text));
                this.failed = false;
                this.saved = false;
                this.publish();
            }
            editControl(name, value) {
                if (this.saving) return;
                const ranges = Object.fromEntries(Object.entries(NUMBER_CONTROLS).map(([name, spec]) => [name, spec.max]));
                if (name in ranges && (!Number.isInteger(value) || value < (name === 'maxOutputChars' ? 1000 : 1) || value > ranges[name])) return;
                if (name === 'mode' && !['organize', 'select'].includes(value) || name === 'preset' && !['custom', 'free', 'balanced', 'deep'].includes(value)) return;
                if (['searchServices', 'fetchServices'].includes(name) && (!Array.isArray(value) || value.some(id => !SERVICES.some(service => service.id === id)))) return;
                if (name === 'serviceEnabled' && (value === null || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(flag => typeof flag !== 'boolean'))) return;
                if (!['mode', 'preset', 'searchServices', 'fetchServices', 'serviceEnabled', ...Object.keys(ranges)].includes(name)) return;
                this.numberDrafts.delete(name);
                this.baselineRevision ??= this.scope.getSnapshot().revision;
                const served = this.section()?.controls?.[name] ?? (name === 'serviceEnabled' ? {}
                    : name === 'searchServices' || name === 'fetchServices' ? SERVICES.filter(service => service.capabilities.includes(name === 'searchServices' ? 'search' : 'fetch') && service.id !== 'http').map(service => service.id) : undefined);
                if (JSON.stringify(served) === JSON.stringify(value)) this.controlDrafts.delete(name); else this.controlDrafts.set(name, value);
                this.failed = false; this.saved = false; this.publish();
            }
            editParticipation(id, face, enabled) {
                if (this.saving) return;
                const key = face === 'search' ? 'searchServices' : 'fetchServices';
                const current = this.controls()[key];
                if (id === 'firecrawl' && face === 'search') {
                    const served = this.section()?.controls?.searchServices ?? SERVICES.filter(service => service.capabilities.includes('search')).map(service => service.id);
                    const original = this.engineEnabled(id, false) && served.includes(id);
                    if (enabled === original) {
                        this.engineDrafts.delete(id);
                        const restored = current.filter(value => value !== id);
                        if (served.includes(id)) {
                            const next = served.slice(served.indexOf(id) + 1).find(value => restored.includes(value));
                            restored.splice(next === undefined ? restored.length : restored.indexOf(next), 0, id);
                        }
                        this.editControl(key, restored);
                        return;
                    }
                    if (enabled) this.editEngine(id, true);
                }
                this.editControl(key, enabled ? [...new Set([...current, id])] : current.filter(value => value !== id));
            }
            keyRefs = new Map();
            readGeneration = 0;
            disposed = false;
			/** Staged key text per slot id; a blank draft writes nothing. */
			keyDrafts = /* @__PURE__ */ new Map();
			/**
			* Revision the drafts were staged against, captured on the first stage.
			*
			* A save fences its mutation with this, so an edit made elsewhere
			* between typing and saving is refused rather than silently overwritten.
			*/
			baselineRevision;
			/** Configured/writable facts per slot id, never a value. */
			credentials = /* @__PURE__ */ new Map();
			/** Reference each slot resolves to, as last read. */
			slotRefs = resolveSlotRefs(void 0);
			saving = false;
            discardAfterSave = false;
            failed = false;
            saved = false;
            view = { query: '', capability: 'all', status: 'all', expandedId: null };
            editView(next) {
                this.view = { ...this.view, ...next };
                this.publish();
            }
            toggleService(id) {
                this.editView({ expandedId: this.view.expandedId === id ? null : id });
            }
            serviceDirty(service) {
                return this.serviceEnabled(service.id) !== this.serviceEnabled(service.id, false) || service.keys.some(id => this.keyDrafts.has(id)) || this.engineDrafts.has(service.id) || ['searchServices', 'fetchServices'].some(name => this.controlDrafts.has(name) && this.controlDrafts.get(name).includes(service.id) !== (this.section()?.controls?.[name] ?? SERVICES.filter(item => item.capabilities.includes(name === 'searchServices' ? 'search' : 'fetch')).map(item => item.id)).includes(service.id)) || (service.id === 'zhipu' && this.transportDraft !== undefined);
            }
            matchesService(service) {
                const { query, capability, status } = this.view;
                const words = `${service.id} ${zh[service.id + '-service']} ${en[service.id + '-service']} ${zh[service.capability]} ${en[service.capability]} ${service.keywords ?? ''}`.toLowerCase();
                return words.includes(query.trim().toLowerCase())
                    && (capability === 'all' || service.capabilities.includes(capability))
                    && (status === 'all' || status === 'pending' && this.serviceDirty(service)
                        || status === 'noKey' && (service.keys.length === 0 || anonymousService(service, { section: this.section() }))
                        || status === 'needsKey' && !anonymousService(service, { section: this.section() }) && service.keys.some(id => this.credentials.get(id)?.ready && !this.credentials.get(id)?.configured && !this.keyDrafts.has(id)));
            }
			/**
			* @param scope - the bound settings scope for the `web-search-fetch` namespace.
			* @param ctx - the page plugin's context, whose `remote.credentials`
			* namespace reads and writes the engine keys.
			*/
			constructor(scope, ctx) {
				this.scope = scope;
				this.ctx = ctx;
				this.store = _deepseek_ai_dsh_client_store.createSnapshotStore(this.projection());
				this.unsubscribe = scope.subscribe(() => {
					this.readCredentials();
					this.publish();
				});
				this.readCredentials();
			}
			/** The served settings section, or undefined before the first read. */
			section() {
				const snapshot = this.scope.getSnapshot();
				return snapshot.status === "ready" && typeof snapshot.value === "object" && snapshot.value !== null
					? snapshot.value
					: void 0;
			}
			/** The transport the served section carries, resolved like the host does. */
			servedTransport() {
				return readPath(this.section(), TRANSPORT_PATH) === "tools-api" ? "tools-api" : "anthropic";
			}
			/** The transport a save would store: the staged draft, else the served value. */
			transport() {
				return this.transportDraft ?? this.servedTransport();
			}
			/**
			* Stage a key draft. A blank draft stages nothing, so saving leaves the
			* stored key alone instead of clearing it.
			* @param id - slot id.
			* @param text - what the user typed.
			*/
			editKey(id, text) {
                if (this.saving || !CREDENTIAL_SLOTS.some(slot => slot.id === id)) return;
				this.baselineRevision ??= this.scope.getSnapshot().revision;
				if (text.trim() === "") { this.keyDrafts.delete(id); this.keyRefs.delete(id); }
                else { this.keyDrafts.set(id, text.trim()); this.keyRefs.set(id, this.slotRefs.find(slot => slot.id === id)?.refs ?? []); }
				this.failed = false;
                this.saved = false;
				this.publish();
			}
			/** Stage the transport, or drop the draft when it matches the served value. */
			editTransport(next) {
                if (this.saving || !["anthropic", "tools-api"].includes(next)) return;
				this.baselineRevision ??= this.scope.getSnapshot().revision;
				this.transportDraft = next === this.servedTransport() ? void 0 : next;
				this.failed = false;
                this.saved = false;
				this.publish();
			}
			/** Whether a save would write anything. */
            serviceEnabled(id, draft = true) {
                const section = this.section();
                const flags = draft ? this.controls().serviceEnabled : section?.controls?.serviceEnabled ?? {};
                // Firecrawl extraction exists independently of its legacy search-only entry.
                if (EXTENSIONS.includes(id) && id !== 'firecrawl') return this.engineEnabled(id, draft) && flags[id] !== false;
                return flags[id] ?? (id === 'siliconflow' ? section?.search?.rerank !== false : true);
            }
            engineEnabled(id, draft = true) {
                const entry = this.section()?.engines?.[id];
                const served = entry !== undefined && entry.enabled !== false;
                return draft ? this.engineDrafts.get(id) ?? served : served;
            }
            editService(id, enabled) {
                if (this.saving || typeof enabled !== 'boolean' || !SERVICES.some(service => service.id === id)) return;
                const flags = { ...this.controls().serviceEnabled };
                if (enabled === this.serviceEnabled(id, false)) {
                    const served = this.section()?.controls?.serviceEnabled;
                    if (served && Object.hasOwn(served, id)) flags[id] = served[id]; else delete flags[id];
                } else flags[id] = enabled;
                if (EXTENSIONS.includes(id) && id !== 'firecrawl') {
                    if (enabled === this.serviceEnabled(id, false)) this.engineDrafts.delete(id);
                    else if (enabled) this.editEngine(id, true);
                }
                this.editControl('serviceEnabled', flags);
            }
            editEngine(id, enabled) {
                if (!EXTENSIONS.includes(id) || this.saving) return;
                this.baselineRevision ??= this.scope.getSnapshot().revision;
                const served = this.section()?.engines?.[id];
                if ((served !== undefined && served.enabled !== false) === enabled) this.engineDrafts.delete(id);
                else this.engineDrafts.set(id, enabled);
                this.failed = false;
                this.saved = false;
                this.publish();
            }
			dirty() {
				return this.transportDraft !== void 0 || this.engineDrafts.size > 0 || this.keyDrafts.size > 0 || this.controlDrafts.size > 0 || this.numberDrafts.size > 0;
			}
			/**
			* Ask the credentials domain about the reference each slot resolves to.
			*
			* The answer is stored per slot: the section can change between the
			* request and its response, and two reads can settle out of order, so a
			* response is published only while it still answers for the references in
			* force.
			*/
			async readCredentials() {
				const generation = ++this.readGeneration;
                const refs = resolveSlotRefs(this.section());
                const names = [...new Set(refs.flatMap(slot => slot.refs))];
				let response;
				try {
					response = await this.ctx.remote.credentials.describe(names);
				} catch (_error) { response = { ok: false }; }
                if (this.disposed || generation !== this.readGeneration) return;
				const current = resolveSlotRefs(this.section());
				if (JSON.stringify(current) !== JSON.stringify(refs)) return;
				this.slotRefs = refs;
				const next = /* @__PURE__ */ new Map();
				for (const slot of refs) {
					const views = slot.refs.map(ref => response?.ok ? response.value?.[ref] : undefined);
					next.set(slot.id, {
						configured: views.every(view => view?.configured === true),
                        partial: views.some(view => view?.configured === true) && !views.every(view => view?.configured === true),
                        ready: response?.ok === true,
                        writable: views.every(view => view?.writable !== false)
					});
				}
				this.credentials = next;
				this.publish();
			}
			/**
			* Re-read after the Host reports a change to a reference this page watches.
			* @param ref - the reference the Host reports as changed.
			*/
			refreshCredential(ref) {
				if (!this.slotRefs.some(slot => slot.refs.includes(ref))) return;
				this.readCredentials();
			}
			/**
			* Write the staged edits, then re-read what the Host accepted.
			*
			* The settings mutation lands first, so a refused transport write leaves
			* the key drafts intact for correction; every key is then written through
			* the credentials domain. A key literal is passed straight through and is
			* never logged, echoed, or kept on this object beyond the staged draft.
			* @returns settlement after every write and the read-back.
			*/
			async save() {
				if (this.saving || this.shell().invalid) return;
				const snapshot = this.scope.getSnapshot();
				if (snapshot.writable !== true) return;
				const ops = this.transportDraft === void 0
					? []
					: [{ op: "set", path: [...TRANSPORT_PATH], value: this.transportDraft }];
				ops.push(...[...this.engineDrafts].map(([id, enabled]) => ({ op: "set", path: ["engines", id, "enabled"], value: enabled })));
                ops.push(...[...this.controlDrafts].map(([name, value]) => ({ op: 'set', path: ['controls', name], value })));
                // Keep the submitted references independent of a page closing during the write.
                const keys = [...this.keyDrafts].map(([id, text]) => [id, text, this.keyRefs.get(id)]);
				if (ops.length === 0 && keys.length === 0) return;
				this.saving = true;
				this.failed = false;
                this.saved = false;
				this.publish();
				let landed = true;
				try {
					if (ops.length > 0) {
                            landed = await this.scope.mutate(ops, this.baselineRevision);
                            if (landed) {
                                // Accepted configuration is no longer a draft, even if a credential write fails.
                                this.transportDraft = undefined;
                                this.engineDrafts.clear();
                                this.controlDrafts.clear();
                                this.numberDrafts.clear();
                                this.baselineRevision = this.scope.getSnapshot().revision;
                            }
                        }
					if (landed) {
						for (const [id, text, stagedRefs] of keys) {
                            const refs = resolveSlotRefs(this.section()).find(slot => slot.id === id)?.refs ?? [];
                            if (JSON.stringify(refs) !== JSON.stringify(stagedRefs)) { landed = false; continue; }
                            for (const ref of refs) {
                                const response = await this.ctx.remote.credentials.set(ref, text);
                                if (response?.ok !== true) landed = false;
                            }
						}
					}
				} catch (_error) {
					landed = false;
				} finally {
					if (landed) {
						this.transportDraft = void 0;
						this.keyDrafts.clear();
                        this.keyRefs.clear();
                        this.engineDrafts.clear();
                        this.controlDrafts.clear();
                         this.numberDrafts.clear();
						this.baselineRevision = void 0;
					}
					this.failed = !landed;
                    this.saved = landed;
					this.saving = false;
                    if (this.discardAfterSave) {
                        this.clearDrafts();
                        this.discardAfterSave = false;
                        this.failed = false;
                        this.saved = false;
                    }
				}
				await this.readCredentials();
				this.publish();
			}
			/** Drop every staged edit. */
            clearDrafts() {
                this.transportDraft = undefined;
                this.keyDrafts.clear();
                this.keyRefs.clear();
                this.engineDrafts.clear();
                this.controlDrafts.clear();
                this.numberDrafts.clear();
                this.baselineRevision = undefined;
            }
            leave() {
                if (!this.saving) { this.discard(); return; }
                this.discardAfterSave = true;
                this.clearDrafts();
                this.publish();
            }
			discard() {
                if (this.saving) return;
				if (!this.dirty() && !this.failed) return;
				this.transportDraft = void 0;
				this.keyDrafts.clear();
                        this.keyRefs.clear();
                        this.engineDrafts.clear();
                        this.controlDrafts.clear();
                         this.numberDrafts.clear();
				this.baselineRevision = void 0;
				this.failed = false;
                this.saved = false;
				this.publish();
			}
			/** The form frame's state: what the Host serves, and what a save would do. */
			shell() {
				const snapshot = this.scope.getSnapshot();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable === true,
					dirty: this.dirty(),
					invalid: Object.keys(NUMBER_CONTROLS).some(name => this.numberField(name).invalid),
					saving: this.saving,
					failed: this.failed
				};
			}
			/** The card's whole render state. */
			projection() {
				this.slotRefs = resolveSlotRefs(this.section());
				return {
					...this.shell(),
                    saved: this.saved,
                    controls: this.controls(),
                    numberFields: Object.fromEntries(Object.keys(NUMBER_CONTROLS).map(name => [name, this.numberField(name)])),
                    view: { ...this.view },
                    visibleServiceIds: SERVICES.filter(service => this.matchesService(service)).map(service => service.id),
                    changedServiceIds: SERVICES.filter(service => this.serviceDirty(service)).map(service => service.id),
                    changeCount: this.keyDrafts.size + this.engineDrafts.size + new Set([...this.controlDrafts.keys(), ...this.numberDrafts.keys()]).size + (this.transportDraft === undefined ? 0 : 1),
					transport: this.transport(),
					transportDirty: this.transportDraft !== void 0,
                    engines: Object.fromEntries(SERVICES.map(service => [service.id, this.serviceEnabled(service.id)])),
                    firecrawlSearchEnabled: this.engineEnabled('firecrawl'),
                    section: this.section(),
					keys: CREDENTIAL_SLOTS.map((slot) => {
						const draft = this.keyDrafts.get(slot.id) ?? "";
						const info = this.credentials.get(slot.id);
						return {
							id: slot.id,
							text: draft,
							staged: draft !== "",
                            ready: info?.ready,
							configured: info?.configured === true,
                            partial: info?.partial === true,
							writable: info?.writable !== false
						};
					})
				};
			}
			/** Publish the current projection to the card's store. */
			publish() {
                if (!this.dirty()) this.baselineRevision = undefined;
				this.store.set(this.projection());
			}
			/** Release the scope subscription. */
			dispose() {
                this.disposed = true;
                ++this.readGeneration;
				this.unsubscribe();
			}
		};
		//#endregion
        //#region card
        const SERVICES = [
            { id: 'anysearch', mark: 'AS', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['anysearch'] },
            { id: 'firecrawl', mark: 'FC', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['firecrawl'], extension: true },
            { id: 'tavily', mark: 'TV', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['tavily'], extension: true },
            { id: 'zhipu', mark: '智', capability: 'search', capabilities: ['search'], keys: ['zhipu'] },
            { id: 'zhihu', mark: '知', capability: 'search', capabilities: ['search'], keys: ['zhihu'] },
            { id: 'exa', mark: 'EX', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['exa'], extension: true },
            { id: 'keenable', mark: 'KE', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['keenable'], extension: true },
            { id: 'crawl4ai', mark: 'C4', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['crawl4ai'], extension: true },
            { id: 'github', mark: 'GH', capability: 'githubCapabilities', capabilities: ['search', 'fetch'], keys: ['github'], extension: true },
            { id: 'qianfan', mark: '千', capability: 'search', capabilities: ['search'], keys: ['qianfan'], extension: true },
            { id: 'doubao', mark: '豆', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['doubao-search', 'doubao-fetch'], extension: true },
            { id: 'tinyfish', mark: 'TF', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['tinyfish'], extension: true },
            { id: 'serply', keywords: 'Google Markdown', mark: 'SP', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['serply'], extension: true },
            { id: 'kimi', keywords: 'Moonshot 月之暗面 REST Basic Pro Markdown', mark: 'K', capability: 'searchFetch', capabilities: ['search', 'fetch'], keys: ['kimi'], extension: true },
            { id: 'bing', keywords: 'RSS 免费 匿名 free anonymous', mark: 'B', capability: 'search', capabilities: ['search'], keys: [], extension: true },
            { id: 'aihot', keywords: 'AI news 新闻 资讯', mark: 'AI', capability: 'aiNews', capabilities: ['search', 'fetch'], keys: [], extension: true },
            { id: 'siliconflow', mark: '硅', capability: 'rerank', capabilities: ['rerank'], keys: ['siliconflow'] },
            { id: 'http', mark: '↗', capability: 'staticFetch', capabilities: ['fetch'], keys: [] },
        ];
        const SETTINGS_CSS = `
            .wsf-settings{color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;min-inline-size:0;container-type:inline-size;display:flex;flex-direction:column}
            .wsf-settings p,.wsf-settings h3{margin-block:0}
            .wsf-settings :is(button,input,select,summary,a):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
            .wsf-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
            .wsf-heading{display:flex;align-items:center;gap:12px;padding-block:12px 4px}
            .wsf-heading h3{font-size:13px;font-weight:600;flex:1;min-inline-size:0}
            .wsf-count{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
            .wsf-preference{display:grid;gap:6px;padding-block:12px;border-block-end:.5px solid var(--dsw-alias-border-l2)}
            .wsf-setting-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px}
            .wsf-setting-label{font-weight:500;flex:1 1 70px}
            .wsf-setting-row [role=tablist]{max-inline-size:100%}
            .wsf-setting-row [role=tab]{padding-inline:12px}
            .wsf-call-settings>summary strong{font-weight:500}.wsf-current-settings{margin-inline-start:auto;color:var(--dsw-alias-label-tertiary);font-size:12px}.wsf-call-settings{border-block-end:.5px solid var(--dsw-alias-border-l2)}
            .wsf-advanced{border-block-end:.5px solid var(--dsw-alias-border-l2)}
            .wsf-call-settings>summary,.wsf-advanced>summary,.wsf-guide>summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;border-radius:var(--dsw-radius-sm);padding-block:12px;user-select:none}
            .wsf-advanced>summary::-webkit-details-marker,.wsf-guide>summary::-webkit-details-marker{display:none}
            .wsf-disclosure-copy{display:grid;gap:2px;flex:1;min-inline-size:0}
            .wsf-disclosure-copy strong{font-weight:500}
            .wsf-chevron{flex:none;inline-size:16px;block-size:16px;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);font-size:17px;line-height:1}
            details[open]>summary .wsf-chevron{rotate:90deg}
            .wsf-control-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:0 16px}
            .wsf-controls-hint{padding-block:4px 12px}
            .wsf-guide{margin-block-end:10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
            .wsf-guide>summary{padding-block:6px;justify-content:flex-start}
            .wsf-guide p{padding-block:4px 8px}
            .wsf-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-block-end:8px}
            .wsf-search{position:relative;flex:1 1 190px;min-inline-size:0}
            .wsf-search-field{box-sizing:border-box;inline-size:100%;padding-inline-end:36px}
            .wsf-search input::-webkit-search-cancel-button{display:none}
            .wsf-clear{position:absolute;inset-inline-end:2px;inset-block-start:2px;inline-size:28px;min-inline-size:28px;padding-inline:0!important}
            .wsf-status-filter{box-sizing:border-box;block-size:32px;max-inline-size:100%;padding-inline:10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
            .wsf-filters{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-block-end:8px}
            .wsf-filter{padding-inline:10px!important}
            .wsf-filter-count{margin-inline-start:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
            .wsf-results-count{margin-inline-start:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
            .wsf-list{border-block-start:.5px solid var(--dsw-alias-border-l2)}
            .wsf-service{border-block-end:.5px solid var(--dsw-alias-border-l2);min-inline-size:0}
            .wsf-row{display:grid;grid-template-columns:minmax(0,1fr) auto 36px auto;align-items:center;gap:12px;min-block-size:58px}
            .wsf-row>[role=switch]{grid-column:3;grid-row:1;z-index:1}
            .wsf-open{grid-area:1/1/2/-1;display:grid;grid-template-columns:subgrid;align-items:center;gap:12px;min-inline-size:0;text-align:start;border:0;border-radius:var(--dsw-radius-sm);color:inherit;background:transparent;padding-block:10px;padding-inline:4px;cursor:pointer;font:inherit}
            .wsf-name{grid-column:1;min-inline-size:0}
            .wsf-name strong{display:block;font-size:13px;font-weight:500;overflow-wrap:anywhere}
            .wsf-name small{display:block;margin-block-start:2px;color:var(--dsw-alias-label-tertiary);font-size:11px}
            .wsf-state{grid-column:2;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
            .wsf-chevron{grid-column:-2/-1}
            .wsf-state[data-dirty=true]{color:var(--dsw-alias-label-secondary);font-weight:500}
            .wsf-detail{padding-block:2px 14px;padding-inline:4px;display:grid;gap:10px}
            .wsf-participation{display:flex;flex-wrap:wrap;gap:12px 20px}
            .wsf-notice{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;padding-block:8px}
            .wsf-transport{display:grid;gap:6px}
            .wsf-empty{display:grid;justify-items:center;gap:8px;padding-block:32px;text-align:center}
            .wsf-empty h3{font-size:13px;font-weight:500}
            .wsf-footer{position:sticky;inset-block-end:0;z-index:1;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding-block:12px;border-block-start:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
            .wsf-footer-status{flex:1 1 140px;min-inline-size:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
            .wsf-footer-actions{display:flex;gap:8px;margin-inline-start:auto}
            .wsf-error{color:var(--dsw-alias-state-error-primary);font-size:12px;padding-block:8px}
            .wsf-link{min-block-size:28px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);padding-inline:0;cursor:pointer;font:inherit;font-size:12px;text-decoration:underline;text-underline-offset:3px}
            .wsf-open:active,.wsf-call-settings>summary:active,.wsf-advanced>summary:active,.wsf-guide>summary:active,.wsf-link:active{background:var(--dsw-alias-interactive-bg-hover)}
            @media(hover:hover) and (pointer:fine){.wsf-open:hover,.wsf-call-settings>summary:hover,.wsf-advanced>summary:hover,.wsf-guide>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}.wsf-link:hover{color:var(--dsw-alias-label-primary)}}
            @container(max-width:360px){.wsf-row,.wsf-open{gap:6px}.wsf-filters{gap:2px}.wsf-filter{padding-inline:8px!important}.wsf-filter-count{margin-inline-start:4px}.wsf-setting-row [role=tab]{padding-inline:8px}}
        `;
        function KeyField({ t, row, disabled, onEdit }) {
            const status = row.ready === undefined ? 'checking' : !row.ready ? 'statusFailed' : row.configured ? 'configured' : row.partial ? 'partial' : 'unconfigured';
            return react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.SettingsSecretField, {
                id: slotDomId(row.id), label: t(row.id), hint: t('keyHint'), disabled: disabled || !row.writable,
                text: row.text, configured: row.configured,
                stateLabel: t(row.staged ? 'staged' : status) + (!row.writable ? ` · ${t('readOnly')}` : ''), onEdit,
            });
        }
        function anonymousService(service, state) {
            const section = state.section ?? {};
            const valid = (value, origin, path) => { try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && url.pathname.replace(/\/+$/, '') === path && !url.search && !url.hash; } catch { return false; } };
            if (service.id === 'anysearch') return valid(section.search?.anysearchBaseURL ?? 'https://api.anysearch.com', 'https://api.anysearch.com', '') && valid(section.fetch?.anysearchBaseURL ?? 'https://api.anysearch.com', 'https://api.anysearch.com', '');
            if (service.id === 'tavily') return valid(section.engines?.tavily?.baseURL ?? 'https://api.tavily.com', 'https://api.tavily.com', '') && valid(section.engines?.tavily?.fetchBaseURL ?? section.engines?.tavily?.baseURL ?? 'https://api.tavily.com', 'https://api.tavily.com', '');
            if (service.id === 'firecrawl') return valid(section.engines?.firecrawl?.baseURL ?? 'https://api.firecrawl.dev', 'https://api.firecrawl.dev', '') && valid(section.fetch?.firecrawlBaseURL ?? 'https://api.firecrawl.dev/v2/scrape', 'https://api.firecrawl.dev', '/v2/scrape');
            return false;
        }
        function serviceStatus(service, state) {
            if (state.changedServiceIds.includes(service.id)) return 'staged';
            const rows = service.keys.map(id => state.keys.find(row => row.id === id));
            if (!rows.length) return 'noKey';
            if (rows.some(row => row.ready === undefined)) return 'checking';
            if (rows.some(row => !row.ready)) return 'statusFailed';
            if (rows.every(row => row.configured)) return 'configured';
            if (rows.some(row => row.partial)) return 'partial';
            if (anonymousService(service, state)) return 'anonymous';
            return rows.some(row => row.configured) ? 'partial' : 'unconfigured';
        }
        function WebSearchFetchCard(props) {
            const { t, editKey, editTransport, editService, editControl, editNumber, editParticipation, editView, toggleService, refresh, save, discard } = props;
            const state = props.useWebSearchFetch(snapshot => snapshot);
            const onDiscard = React.useRef(props.leave);
            onDiscard.current = props.leave;
            React.useEffect(() => () => onDiscard.current(), []);
            const disabled = !state.available || !state.writable || state.saving;
            const jsx = react_jsx_runtime.jsx, jsxs = react_jsx_runtime.jsxs;
            const ui = _deepseek_ai_dsh_client_ui_primitives;
            const visible = SERVICES.filter(service => state.visibleServiceIds.includes(service.id));
            const modeId = 'wsf-mode-' + state.controls.mode;
            const presetId = 'wsf-preset-' + state.controls.preset;
            return jsxs('form', { className: 'wsf-settings', 'aria-label': t('title'), 'aria-busy': state.saving,
                onSubmit: event => event.preventDefault(), children: [
                    jsx('style', { children: SETTINGS_CSS }),
                    !state.available && jsx('p', { role: 'status', className: 'wsf-notice', children: t('unavailable') }),
                    !state.writable && state.available && jsx('p', { className: 'wsf-notice', children: t('readOnlyHint') }),
                    jsxs('details', { className: 'wsf-call-settings', children: [
                        jsxs('summary', { children: [
                            jsx('strong', { children: t('settingsTitle') }),
                            jsx('span', { className: state.invalid ? 'wsf-current-settings wsf-error' : 'wsf-current-settings', children: state.invalid ? t('invalidControls') : t(state.controls.preset + 'Preset') + ' · ' + t(state.controls.mode + 'Mode') }),
                            jsx('span', { className: 'wsf-chevron', 'aria-hidden': true, children: '›' }),
                        ] }),
                    jsxs('div', { className: 'wsf-preference', children: [
                        jsxs('div', { className: 'wsf-setting-row', children: [
                            jsx('span', { className: 'wsf-setting-label', children: t('presetLabel') }),
                            jsx(ui.SegmentedControl, { id: 'wsf-preset', value: state.controls.preset,
                                label: t('presetLabel'), disabled, onChange: value => editControl('preset', value),
                                options: ['free', 'balanced', 'deep', 'custom'].map(value => ({ value, label: t(value + 'Preset') })) }),
                        ] }),
                        jsx('p', { id: presetId + '-panel', role: 'tabpanel', 'aria-labelledby': presetId, className: 'wsf-muted',
                            children: t(state.controls.preset === 'free' ? 'freeHint' : state.controls.preset + 'PresetHint') }),
                    ] }),
                    jsxs('div', { className: 'wsf-preference', children: [
                        jsxs('div', { className: 'wsf-setting-row', children: [
                            jsx('span', { className: 'wsf-setting-label', children: t('modeLabel') }),
                            jsx(ui.SegmentedControl, { id: 'wsf-mode', value: state.controls.mode,
                                label: t('modeLabel'), disabled, onChange: value => editControl('mode', value),
                                options: ['organize', 'select'].map(value => ({ value, label: t(value + 'Mode') })) }),
                        ] }),
                        jsx('p', { id: modeId + '-panel', role: 'tabpanel', 'aria-labelledby': modeId, className: 'wsf-muted', children: t(state.controls.mode + 'Hint') }),
                    ] }),
                    jsxs('details', { className: 'wsf-advanced', children: [
                        jsxs('summary', { children: [
                            jsxs('span', { className: 'wsf-disclosure-copy', children: [jsx('strong', { children: t('advanced') }), jsx('span', { className: state.invalid ? 'wsf-error' : 'wsf-muted', children: t(state.invalid ? 'invalidControls' : 'advancedHint') })] }),
                            jsx('span', { className: 'wsf-chevron', 'aria-hidden': true, children: '›' }),
                        ] }),
                        jsx('div', { className: 'wsf-control-grid', children: Object.keys(NUMBER_CONTROLS).map(name => {
                            const field = state.numberFields[name];
                            return jsx('div', { children: jsx(ui.SettingsValueField, {
                                id: 'wsf-limit-' + name, label: t(name), numeric: true, disabled,
                                text: field.text, invalid: field.invalid, overridden: field.dirty,
                                overriddenLabel: t('staged'), resetLabel: t('resetField'),
                                invalidLabel: t('invalidNumber') + field.min + '–' + field.max,
                                hint: t('range') + ': ' + field.min + '–' + field.max,
                                onEdit: text => editNumber(name, text), onReset: () => editNumber(name, field.servedText),
                            }) }, name);
                        }) }),
                        jsx('p', { className: 'wsf-muted wsf-controls-hint', children: t('controlsHint') }),
                    ] }),
                    ] }),
                    jsxs('div', { className: 'wsf-heading', children: [
                        jsx('h3', { children: t('servicesTitle') }),
                        jsx('span', { className: 'wsf-count', children: SERVICES.length + ' ' + t('servicesCount') }),
                        jsx(ui.Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: refresh, disabled: state.saving, children: t('refresh') }),
                    ] }),
                    jsxs('details', { className: 'wsf-guide', children: [
                        jsxs('summary', { children: [jsx('span', { className: 'wsf-chevron', 'aria-hidden': true, children: '›' }), t('startGuide')] }),
                        jsx('p', { children: t('intro') }),
                    ] }),
                    jsxs('div', { className: 'wsf-tools', children: [
                        jsxs('div', { className: 'wsf-search', children: [
                            jsx(ui.Input, { className: 'wsf-search-field', type: 'search', 'aria-label': t('searchLabel'), placeholder: t('searchPlaceholder'), value: state.view.query,
                                onChange: event => editView({ query: event.target.value }) }),
                            state.view.query && jsx(ui.Button, { type: 'button', variant: 'ghost', size: 'sm', className: 'wsf-clear', 'aria-label': t('clearSearch'),
                                onClick: event => { editView({ query: '' }); event.currentTarget.closest('.wsf-search').querySelector('input').focus(); }, children: '×' }),
                        ] }),
                        jsx('select', { className: 'wsf-status-filter', 'aria-label': t('statusFilter'), value: state.view.status, onChange: event => editView({ status: event.target.value }),
                            children: ['all', 'needsKey', 'pending', 'noKey'].map(value => jsx('option', { value, children: t(value === 'all' ? 'allStatus' : value) }, value)) }),
                    ] }),
                    jsxs('div', { className: 'wsf-filters', role: 'group', 'aria-label': t('searchLabel'), children: [
                        ...['all', 'search', 'fetch', 'rerank'].map(capability => jsxs(ui.Button, { type: 'button', size: 'sm', variant: state.view.capability === capability ? 'outline' : 'ghost', className: 'wsf-filter',
                            'aria-pressed': state.view.capability === capability, onClick: () => editView({ capability }), children: [
                                t(capability), jsx('span', { className: 'wsf-filter-count', 'aria-hidden': true,
                                    children: SERVICES.filter(service => capability === 'all' || service.capabilities.includes(capability)).length }),
                            ] }, capability)),
                        jsx('span', { className: 'wsf-results-count', role: 'status', children: visible.length + ' ' + t('matches') }),
                    ] }),
                    jsx('div', { className: 'wsf-list', children: visible.length ? visible.map(service => {
                        const expanded = state.view.expandedId === service.id;
                        const status = serviceStatus(service, state);
                        const missingKey = service.keys.some(id => { const row = state.keys.find(row => row.id === id); return row.ready && !row.configured && !row.staged; });
                        const name = t(service.id + '-service');
                        const detailId = 'wsf-detail-' + service.id;
                        const specificHint = ['http', 'siliconflow', 'anysearch', 'tavily', 'firecrawl', 'github', 'doubao', 'tinyfish', 'serply', 'kimi', 'bing', 'aihot'].includes(service.id)
                            ? (service.id === 'siliconflow' ? 'rerankHint' : service.id + 'Hint') : service.extension ? 'extensionHint' : 'baseHint';
                        return jsxs('section', { className: 'wsf-service', 'aria-label': name, children: [
                            jsxs('div', { className: 'wsf-row', children: [
                                jsxs('button', { type: 'button', className: 'wsf-open', 'aria-expanded': expanded,
                                    'aria-controls': detailId, 'aria-label': t('configure') + ' ' + name, onClick: () => toggleService(service.id), children: [
                                        jsxs('span', { className: 'wsf-name', children: [jsx('strong', { children: name }), jsx('small', { children: t(service.capability) + (['anysearch', 'firecrawl', 'tavily'].includes(service.id) ? ' · ' + t('recommended') : service.id === 'http' ? '' : ' · ' + t('enhancement')) })] }),
                                        jsx('span', { className: 'wsf-state', 'data-dirty': status === 'staged', children: t(status) }),
                                        jsx('span', { className: 'wsf-chevron', 'aria-hidden': true, children: expanded ? '⌄' : '›' }),
                                    ] }),
                                jsx(ui.Switch, { label: t('enable') + ' ' + name,
                                    checked: state.engines[service.id], disabled, onChange: checked => editService(service.id, checked) }),
                            ] }),
                            jsx('div', { id: detailId, hidden: !expanded, children: expanded && jsxs('div', { className: 'wsf-detail', children: [
                                jsx('p', { className: 'wsf-muted', children: t(specificHint) }),
                                service.id !== 'http' && service.id !== 'siliconflow' && jsx('div', { className: 'wsf-participation', children: service.capabilities.filter(face => face === 'search' || face === 'fetch').map(face => {
                                    const allowed = state.controls.preset !== 'free' || ['tinyfish', 'bing', 'github', 'aihot'].includes(service.id);
                                    return jsx(ui.Checkbox, { disabled: disabled || !allowed, label: t(face === 'search' ? 'participateSearch' : 'participateFetch'),
                                        checked: allowed && (service.id !== 'firecrawl' || face !== 'search' || state.firecrawlSearchEnabled) && state.controls[face === 'search' ? 'searchServices' : 'fetchServices'].includes(service.id),
                                        onChange: checked => editParticipation(service.id, face, checked) }, face);
                                }) }),
                                service.id === 'aihot' && jsx('p', { className: 'wsf-muted', children: t('aihotTerms') }),
                                service.id === 'siliconflow' && jsx('p', { className: 'wsf-muted', children: jsx('a', {
                                    href: 'https://cloud.siliconflow.cn/i/E3nhNFP4', target: '_blank', rel: 'noopener noreferrer', children: t('siliconflowInvite'),
                                }) }),
                                ...service.keys.map(id => jsx(KeyField, { t, row: state.keys.find(row => row.id === id), disabled, onEdit: text => editKey(id, text) }, id)),
                                service.id === 'zhipu' && jsxs('div', { className: 'wsf-transport', children: [
                                    jsx(ui.SegmentedControl, { id: 'plugin-config-web-search-fetch-transport', value: state.transport,
                                        options: [{ value: 'anthropic', label: t('transportAnthropic') }, { value: 'tools-api', label: t('transportToolsApi') }],
                                        label: t('transportLabel'), disabled, onChange: editTransport }),
                                    jsx('p', { className: 'wsf-muted', children: t('transportHint') }),
                                ] }),
                                service.extension && service.keys.length > 0 && (!state.engines[service.id] || missingKey && !anonymousService(service, state))
                                    && jsx('p', { className: 'wsf-notice', children: t(!state.engines[service.id] ? 'enableWarning' : 'missingWarning') }),
                                service.keys.length > 0 && status === 'statusFailed' && jsx('button', { type: 'button', className: 'wsf-link', onClick: refresh, children: t('refresh') }),
                            ] }) }),
                        ] }, service.id);
                    }) : jsxs('div', { className: 'wsf-empty', children: [
                        jsx('h3', { children: t('noMatches') }), jsx('p', { className: 'wsf-muted', children: t('noMatchesHint') }),
                        jsx(ui.Button, { type: 'button', variant: 'outline', size: 'sm', onClick: () => editView({ query: '', capability: 'all', status: 'all' }), children: t('resetFilters') }),
                    ] }) }),
                    state.failed && jsx('p', { role: 'alert', className: 'wsf-error', children: t('saveFailed') }),
                    jsxs('div', { className: 'wsf-footer', children: [
                        jsx('p', { className: state.invalid ? 'wsf-footer-status wsf-error' : 'wsf-footer-status', role: 'status', children: state.invalid ? t('invalidControls') : state.saving ? t('saving') : state.dirty ? state.changeCount + ' ' + t('dirty') : state.saved ? t('saved') : t('clean') }),
                        jsxs('div', { className: 'wsf-footer-actions', children: [
                            jsx(ui.Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: state.saving || !state.dirty, onClick: discard, children: t('discard') }),
                            jsx(ui.Button, { type: 'button', variant: 'primary', size: 'sm', disabled: disabled || !state.dirty || state.invalid, onClick: save, children: t(state.saving ? 'saving' : 'save') }),
                        ] }),
                    ] }),
                ] });
        }
        //#endregion
		//#region apply
		/** Required services (cordis fiber inject). */
		const inject = [ "slots", "locale", "remote", "remote.credentials", "configForms" ];
		/**
		* Mount this plugin's settings tab while the Host serves its namespace.
		*
		* The registration follows `configForms.whileServed`, so a deployment that
		* never composed this plugin shows no trace of the tab.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-settings-web-search-fetch: dictionaries");
			const card = new WebSearchFetchCardController(ctx.configForms.get(SETTINGS_NS), ctx);
			ctx.effect(() => () => {
				card.dispose();
			}, "ui-settings-web-search-fetch: form subscription");
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
				card.refreshCredential(ref);
			}), "ui-settings-web-search-fetch: credential invalidations");
			ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "web-search-fetch",
				order: 20,
				label: () => t("title"),
				locale: NS,
				inject: () => ({
					hooks: { webSearchFetch: card.store },
					editKey: (id, text) => {
						card.editKey(id, text);
					},
                    editView: (next) => card.editView(next),
                    toggleService: (id) => card.toggleService(id),
                    refresh: () => card.readCredentials(),
					editEngine: (id, enabled) => card.editEngine(id, enabled),
                    editService: (id, enabled) => card.editService(id, enabled),
                    editControl: (name, value) => card.editControl(name, value),
                    editNumber: (name, text) => card.editNumber(name, text),
                    leave: () => card.leave(),
                    editParticipation: (id, face, enabled) => card.editParticipation(id, face, enabled),
                    editTransport: (next) => {
						card.editTransport(next);
					},
					save: () => card.save(),
					discard: () => {
						card.discard();
					}
				})
			}, WebSearchFetchCard))), "ui-settings-web-search-fetch: page");
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
