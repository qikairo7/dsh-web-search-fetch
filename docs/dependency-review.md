# 运行依赖审阅材料

## 范围与状态

本文回应 [DSH Store #1415 的复检意见](https://github.com/AI-Scarlett/DSH-Store/issues/1415#issuecomment-6195716034)，提供 `0.2.11` 的作者侧分发修复与依赖材料。固定 Git 树缺少入口的问题已补齐；Store 的独立供应链审阅及准入决定仍待完成。`0.2.15` 未改变本插件直接运行依赖；开发依赖升级到 DSH `0.2.1-alpha.4`，用于编译、类型检查和测试适配。依赖清单和审阅边界不因版本号提升而自动免除复核。

后续已完成 `0.2.12` 在 DSH `0.2.1-alpha.3` 上的隔离安装、启动、原生工具、设置保存、卸载与版本回滚，见[生命周期验收记录](./verification/profile-lifecycle-20261016.md)。后续运行证据与本文的依赖审阅材料分别记录，均不代替 Store 的独立审阅。

全部服务配置、逐路原生搜索／提取与五种决策模型的后续验证见[全服务实测](./verification/all-services-20261016.md)。该记录还包含未发布 PR 候选包对 GitHub 提取的两处修复及失败历史，与正式 Release 身份分别标注。

`0.2.14` 已完成正式 Web profile 升级、宿主重启和原生 `web_fetch` 验证，见[正式 profile 安装验证](./verification/formal-profile-v0.2.14-20261016.md)。该运行证据不替代本页的依赖审阅，也不改变 Store 的独立结论。`0.2.15` 的 alpha.4 适配证据以对应 Release 记录为准。

[依赖清单](./dependency-inventory.json) 记录 2026-10-16 查询 npm 官方 Registry 得到的版本、来源仓库、许可证、tarball URL、SHA-512 integrity、安装脚本、源码构建脚本及公告响应。它覆盖 5 个直接运行依赖及其锁定传递依赖，共 15 个包；宿主提供的 peer 依赖与开发依赖不在此范围内。

Registry 元数据中的 integrity 与项目锁文件逐项一致，15 个包均未声明 `preinstall`、`install`、`postinstall`。公共漏洞公告接口此次返回空对象，仅表示本次查询未返回公告。未验证发布者签名或 provenance，也未据此断言包内代码安全。本文及清单均不替代 Store 或其他审阅者的独立审计。

## 直接运行依赖

| 包与锁定版本 | 来源 | 本插件用途与审阅边界 |
| --- | --- | --- |
| `@deepseek-ai/schemastery@3.18.5-alpha.2` | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 在 `src/index.ts` 声明配置 schema。上游官方命名空间是依赖来源，本插件包名不占用该命名空间。传递引入 cosmokit 与 Standard Schema 类型。 |
| `@joplin/turndown-plugin-gfm@1.0.68` | [Joplin GFM 插件](https://github.com/laurent22/joplin-turndown-plugin-gfm) | 在 `src/fetch-document/blocks.ts` 补充表格等 HTML 转换规则。npm 包带构建产物；源码 `prepare` 为 `npm run build`，安装本项目时不从依赖的 Git 源构建。 |
| `fast-xml-parser@5.11.2` | [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | 在 `src/engines/additional/adapters.ts` 解析 Bing RSS。不可信输入先拒绝 `DOCTYPE` 并验证 XML；仍需审阅解析器及其传递依赖的资源消耗与输入处理。 |
| `turndown@7.2.4` | [Turndown](https://github.com/mixmark-io/turndown) | 在 `src/fetch-document/blocks.ts` 将 HTML 转成 Markdown，移除 script、style、noscript。通过 domino 解析 DOM，不执行页面脚本；这不等于对输出做安全过滤或验证内容可信度。 |
| `undici@8.11.2` | [Node.js Undici](https://github.com/nodejs/undici) | 在 `src/engines/decision/client.ts` 发出决策请求，复用宿主代理 dispatcher，保持 Undici 主版本一致。具备网络访问能力，需连同自定义端点及凭证发送范围审阅。声明 Node.js `>=22.19.0`。 |

五个直接依赖均声明 MIT。传递依赖中 `@mixmark-io/domino@2.2.0` 声明 BSD-2-Clause，其余声明 MIT；完整许可证及来源字段见清单。依赖不内联到插件编译文件，由包管理器安装并保留自身许可文件。

## 分发与权限

- `lib/` 包含 49 个 ESM 模块和 49 个类型声明，随固定 Git 提交提供。`client/index.js` 与 `cordis.patch.yml` 同时保留，安装方不需要执行 TypeScript 构建。
- 本插件没有 `preinstall`、`install`、`postinstall` 或 `prepare`。作者打包时的 `prepack` 运行本仓库清理脚本及 TypeScript 编译器；这与安装已生成的固定源码是不同操作。
- Bundle 的 `web` 行覆盖该配置层的整个 config，选择 `aggregated` 搜索／提取 provider；新增入口为 `web-search-fetch`。应用前应单独审阅配置覆盖对原有 provider 设置的影响。
- 插件代码以宿主进程权限运行。凭证读写、外部网络、自定义端点、日志与资源限制见[安全说明](../SECURITY.md)。依赖没有安装脚本，不表示运行时没有权限或风险。
- 保留 manifest 已有的精确兼容矩阵；未验证版本保持 `unknown`。原始审查范围是分发与离线回归，不包含实际 profile 安装、卸载、回滚或上架成功声明。后续独立完成的隔离生命周期、全服务矩阵和 `0.2.14` 正式 profile 升级见本节链接；它们不替代本页的依赖审阅。

## 复核方法

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check:distribution
pnpm run check
git diff --exit-code -- lib
npm pack --dry-run --ignore-scripts
node scripts/audit-runtime-dependencies.mjs
```

最后一条命令只读取项目 manifest、锁文件并查询 npm 官方 Registry，将 JSON 输出到终端，不安装或执行第三方包。网络需经环境代理时，Node.js 24 可使用 `node --use-env-proxy scripts/audit-runtime-dependencies.mjs`。脚本会在来源、锁定 integrity 不一致或接口失败时退出失败；返回任何公告也会退出失败，交由审阅者进一步判断版本是否受影响。

pnpm 12 的锁文件含两个 YAML 文档：包管理器依赖和项目依赖。复核脚本使用 `parseAllDocuments` 并选择项目依赖文档，避免只检查包管理器。本次未将普通 `pnpm audit --prod` 的输出作为项目依赖已覆盖的证据。

CI 在构建前检查完整编译产物已进入 Git，构建后检查 `lib/` 与提交内容一致。该检查能防止缺失或陈旧产物；不能证明宿主运行效果或完成独立供应链审核。
