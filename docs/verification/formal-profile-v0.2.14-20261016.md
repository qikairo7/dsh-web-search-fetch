# 0.2.14 正式 profile 安装验证（2026-10-16）

## 结论与身份

`0.2.14` 已从 GitHub Release 下载、校验并安装到正式 `web` profile。安装后重启宿主，DSH Web 正常启动，插件仍接管原生 `web_search` / `web_fetch` 两个 provider，并由真实 DSH 会话完成一次 `web_fetch` 验证。

| 对象 | 身份 |
| --- | --- |
| 安装包 | `dsh-web-search-fetch-0.2.14.tgz`，398,940 字节 |
| 安装包 SHA-256 | `5e0f7834845f9f13aea9acd61be3a93b0f584993ed78b1bc7c3f5267c7422f06` |
| Release | [`v0.2.14`](https://github.com/qikairo7/dsh-web-search-fetch/releases/tag/v0.2.14)，来源提交 `bce6711c436bbc2410f257f87cdbd4061fe51a7e` |
| 目标 profile | 正式 `web` profile |
| 安装前版本 | `0.2.13` |
| 安装后版本 | `0.2.14` |
| 编译入口 | 安装后 `lib/index.js` 与 `client/index.js` 的 Git 对象哈希均与 `v0.2.14` 标签一致 |
| 宿主环境 | Windows 11、DSH `0.2.1-alpha.3`、Node.js 24.20.0 |

安装命令使用本地已下载并校验的 Release 包：

```sh
dsh plugin --profile web add file:<downloaded-release-tgz>
```

## 安装与重启检查

| 检查 | 状态 | 证据 |
| --- | --- | --- |
| Release 资产下载 | PASS | 本地包 SHA-256 与 Release `SHA256SUMS` 一致 |
| profile 升级 | PASS | CLI 输出 `dsh-web-search-fetch 0.2.13 -> 0.2.14`；profile 依赖指向 0.2.14 tgz |
| 安装产物版本 | PASS | `node_modules/dsh-web-search-fetch/package.json` 为 `0.2.14` |
| 产物身份 | PASS | `lib/index.js` 与 `client/index.js` 均匹配 `v0.2.14` 标签对象 |
| 配置装载 | PASS | `dsh --profile web --dump-config` 中 `web-search-fetch` 条目存在，`web.searchProvider` / `web.fetchProvider` 均为 `aggregated` |
| 宿主重启 | PASS | 停止旧 3080 进程后通过正式后台启动器重启；新进程监听 3080，DSH Web 登录页可用 |
| 正式会话 | PASS | 新会话中模型调用原生 `web_fetch`，轮次以 `completed` 结束 |

## 原生提取结果

验证输入为公开页面 `https://example.com`。用户消息要求调用 `web_fetch`、报告 HTTP 状态并用两句话总结页面。会话轨迹显示模型只调用原生 `web_fetch`，未使用本插件自建工具。

| 指标 | 结果 |
| --- | --- |
| 工具结果状态 | HTTP 200 |
| 提取服务 | Firecrawl、AnySearch、Tavily 三路均返回 200 |
| 返回 URL | 三路均为 `https://example.com` |
| 上游截断 | 三路均未标记截断 |
| 自动决策 | `jev-1.13.0` 判定 fast，置信度 91% |
| 提取范围 | 仅派发 3 路，未派发其余 7 路 |
| 插件 HTTP 请求 | 4 次 |
| 正文整理 | 输出含 `F#:B#` 提取来源与多语言内容块 |
| 轮次状态 | `turn/end.reason.kind = completed` |

Firecrawl、AnySearch、Tavily 的接收时间分别为 `2026-10-16T11:39:54.992Z`、`11:39:52.712Z`、`11:39:53.650Z`。这些时间是单次观察，不用于性能排名。

## 验证边界

- 本记录验证正式 profile 的安装、重启、装载和一次 `web_fetch` 实际调用，不重跑完整生命周期、设置页、逐服务搜索或 0.2.11 回滚。
- `web_search` 未在本轮调用；0.2.14 与 0.2.13 运行代码一致，正式搜索证据见[正式 DSH 会话实战验收](./live-session-20261016.md)。
- `pnpm peers check` 在正式 profile 上存在多项既有 peer 警告，涉及多个插件对宿主运行时包的声明；本轮安装前 0.2.13 同样处于该 profile 组合中，且这些警告未阻止宿主装载或工具调用。本次不修改正式 profile 的其他插件。
- `--dump-config` 继续报告既有 `subagent-claude-code` patch 警告；与本插件无关，且未影响 provider 解析。
- 重启后的启动日志仍出现既有 MiniMax 账号 signed-out 错误；与本插件无关。
- 启动日志中的认证 URL 不进入本记录；验证后正式服务保持运行。
