# 贡献指南

欢迎通过 Issue 反馈问题和提出功能建议，通过 Pull Request 提交修复或文档改进。较大的接口变更请先说明使用场景和预期行为。

## 本地开发

使用 Node.js `^22.19.0 || >=24.0.0` 和 pnpm 12.10.1。

```sh
pnpm install --frozen-lockfile
pnpm run check
```

| 命令 | 用途 |
| --- | --- |
| `pnpm run build` | 编译 TypeScript，生成 ESM 与类型声明到 `lib/` |
| `pnpm test` | 运行 Vitest 测试 |
| `pnpm run typecheck` | 检查源码与测试类型 |
| `pnpm run check:repository` | 检查公开文件、文档链接和包入口 |
| `pnpm run check` | 构建、测试、类型检查与仓库检查 |
| `pnpm run benchmark:content` | 同一组合成提取结果的正文保留、去重和差异评估，不访问网络 |
| `npm pack --dry-run` | 检查 npm 分发文件清单，不发布包 |

测试使用本地模拟服务或注入请求实现，不需要真实服务凭证。`client/index.js` 通过 DSH ModuleLoader 装载，不由 TypeScript 编译；其注册和保存路径由浏览器模块测试覆盖。

## 实现约定

- 服务协议映射与 HTTP 传输分离，provider 注册放在插件入口。
- 使用 DSH 原生 `web_search` 和 `web_fetch` 接口，保留统一错误语义。
- 凭证通过 DSH 凭证服务按操作解析，配置不保存实际值。
- `.volatile()` 字段按操作读取，避免挂载时快照导致设置失效。
- 使用结构化错误信号触发熔断，不从错误消息推断限流或额度。
- 保留第三方版权声明。引入外部代码时同步更新 `NOTICE`。

模块职责见[架构说明](./DESIGN.md)，参数与默认值见[配置参考](./docs/configuration.md)。

## 测试与提交

行为修复需提供能复现旧行为的回归测试。使用夹具和本地模拟服务覆盖请求、响应、超时及取消，不在测试中调用真实付费服务。

提交前运行 `pnpm run check`，确认文档与实际配置一致。涉及分发文件时检查 `npm pack --dry-run` 的清单。涉及 DSH 宿主交互或 UI 时，还需在独立 profile 中验证，并在 PR 中说明实际验证范围。

PR 描述应说明问题、最终行为、验证命令和未验证部分。不要提交本机路径、开发会话、凭证、日志、临时报告、`node_modules/` 或编译产物。

## 问题反馈

普通问题使用 [GitHub Issues](https://github.com/qikairo7/dsh-web-search-fetch/issues)。提供版本、步骤、预期结果和实际结果。可能泄露敏感数据的安全问题使用[私密报告方式](./SECURITY.md#漏洞报告)。
