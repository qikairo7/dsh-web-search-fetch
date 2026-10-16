# 原 HTTPS 提取失败的补充追查（2026-10-16）

## 当前状态

**UNRESOLVED：未捕获原 HTTPS 故障的失败响应，尚不能归因或宣称修复。** 原来的两次输入都是 `https://example.com`。日志只保留了适配器状态 200、正文 919 字符和整理器的笼统拒绝，没有返回 URL、RequestId 或挑战判定。本轮得到的新响应不能还原历史响应。

这次补充交付了可选的进程内调试器抓取脚本，并在真实 DSH 上验证它能捕获返回 URL 和实际拒绝分支。脚本、受控测试和[脱敏证据](./doubao-https-incident-20261016.json)进入仓库；插件运行代码未增加猜测性修复。[已确认的 HTTP 升级缺陷](./doubao-fetch-20261016.md)仍单独记录。

## 本轮排查

旧候选包 SHA-256 为 `ecc4a140509e5d7b7afd12505aa2d93d82bed6e7476a85f1c86ab0d1165bf6e8`。使用相同的完整 Web profile、DSH 0.2.1-alpha.3 和原生 ToolRuntime。每次调用单独保存输入、适配器响应与整理器判定，文件按进程和序号隔离，避免后续调用覆盖旧证据。

| 检查 | 具体结果及边界 |
| --- | --- |
| 原服务顺序、设置切换 | 捕获了适配器和整理器边界；未出现原 HTTPS 拒绝 |
| HTTP／HTTPS 重叠调用 | 每次调用使用独立 AsyncLocalStorage；已知 HTTP 拒绝没有污染并行 HTTPS 候选 |
| 重用原生 callId | 测试 `lifecycle-1`、`lifecycle-25`、`lifecycle-1000`；未观察到 HTTP 结果被 HTTPS 调用复用 |
| 新建网络连接 | 仍收到正常 HTTPS 最终地址；不能证明历史服务端返回相同 |
| 绕过现有代理直连 | 发生传输失败，没有可用的服务端响应；属于其他故障，不计作复现 |
| URL 解析器 | 采样时 `globalThis.URL` 与 `node:url` 的 URL 相同；历史状态未知 |
| 不改旧整理器重放 | 新进程按原 `lifecycle-N` 顺序执行故障前的 25 项调用；未复现。此轮只在适配器加探针 |

这些检查限定了本轮观察范围，没有排除所有历史状态或服务端瞬时差异。没有把次数或重复通过作为根因结论。

## 调试器抓取的真实拒绝

最后使用 [capture-fetch-rejection.mjs](../../scripts/capture-fetch-rejection.mjs) 作为 Node preload。它通过进程内 `inspector.Session` 在豆包适配器返回点和整理器抛错点读取局部变量，不修改插件模块，也不开调试器网络端口。调试器会影响执行时序，因此不能据此排除所有时序问题。

两个旧模块都与原候选包的字节一致：整理器 SHA-256 为 `f2d74d737cf70dff980f9e732aed34be436fe80165ad90c9df52e4874f137f07`，适配器为 `18c64ec1018476ff0294897b82a8cb970147ff1f3d33c53743aaea8954d1bd5f`。

| HTTP 对照失败的字段 | 抓取值 |
| --- | --- |
| 工具输入 | `http://example.com` |
| 最终返回 URL | `https://example.com/` |
| 目标页状态／挑战判定 | 200／false |
| 原始正文／适配器正文长度 | 901／919；适配器补入标题 |
| 整理器请求目标／候选目标 | `http://example.com/`／`https://example.com/` |
| successful／compatible／usable | false／false／0 |
| RequestId | `2026101616210681527ADCD480704CCD44` |

这个失败用于检验抓取脚本，**输入是 HTTP，不是原来的 HTTPS 故障**。同进程前后的 HTTPS 调用没有触发拒绝。安装已确认的 HTTP 升级修复候选后，HTTP 和 HTTPS 原生工具都通过，抓取仍能读取豆包响应。完整字段及时间戳见 JSON。

## 再次出现时如何取证

脚本只观察原案例的两个精确输入字符串：`https://example.com` 和 `http://example.com`。它不访问凭证、不保存认证头或正文；正文只保存长度与 SHA-256。URL 去掉用户信息、查询和片段，并保留原字符串 SHA-256；无需脱敏时保留原始拼写，包括末尾斜杠。诊断使用独立导入的 Node URL 解析器。不能用脱敏后的 URL 判断被删参数是否相同，需结合哈希。输出含 RequestId／LogId，应先作为本地诊断文件保存。

在仓库根目录、已配置好的隔离 `DSH_HOME` 下启动。`$dshCli` 需指向实际 DSH 的 `lib/bin.js`，Node 版本应满足项目要求。目标文件的父目录必须已存在，文件本身必须不存在。

```powershell
$env:DSH_FETCH_TRACE_FILE = Join-Path $PWD '.scratch/doubao-incident.jsonl'
node --import ./scripts/capture-fetch-rejection.mjs $dshCli --profile web --no-open
Remove-Item Env:DSH_FETCH_TRACE_FILE
```

输出必须包含 `adapter-breakpoint-ready`，否则该版本没有挂上适配器断点，不能据此宣称取得完整证据。`doubao-response` 保存服务端地址与 RequestId；`organizer-rejection` 保存真正抛错时的目标、状态、挑战判定和筛选结果。出现 `capture-error` 表示局部变量读取失败，应停止据此归因。原因区分命令失败、求值抛错、结果缺失和解码失败；不复制可能包含私密内容的原错误文本。

事件也通过 Node `diagnostics_channel` 的 `dsh-web-search-fetch:incident` 发布。本轮调试宿主以此收集单次串行原生调用的对应事件；JSONL 文件不依赖订阅者。多调用并行时不能只按相邻行配对。

调试结束后停止该诊断进程，再按普通方式启动即可。预加载或 inspector 连接失败会使本次诊断启动失败，此时去掉 `--import` 按普通方式启动。脚本不随插件包安装，也不会常驻到正常 profile。

## 验证与清理

新增 5 项子进程检查，直接调用真实整理器，覆盖目标不匹配、挑战拒绝、私有输入排除、URL 凭证／参数／片段脱敏、正文不落盘和拒绝覆盖既有证据。另验证异常调试结果不泄露内容或终止宿主，以及模拟全局 URL 解析器失效时仍保留地址拼写。受控输入用于验证诊断机制，不计作历史故障复现。

`pnpm run check`：40 个测试文件、765 项测试、类型与仓库检查通过。`pnpm run check:distribution`：106 项必要文件通过。

候选包已用 CLI 卸载；只清理本插件的残留覆盖项，保留另一个设置项。重新启动的完整 profile 无本插件，恢复 `deepseek-official`／`http`，原生 HTTP 提取 200（678 ms）。随后停止隔离服务，释放两个验收端口，删除复制的凭证和代理环境文件。正式 DSH 包和配置未替换。

## 未满足的完成条件

需要真实 HTTPS 失败当次的服务端返回地址与整理器局部变量，才能区分目标不匹配和登录／挑战拒绝，再针对已证实的条件做旧代码 FAIL／修复后 PASS。目前既没有取回历史响应，也没有重新捕获同样失败。因此不关闭原问题，不将 HTTP 对照或当前成功样本当作原问题的修复证据。
