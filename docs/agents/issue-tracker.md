# Issue 跟踪：GitHub

本仓库的 Issue 与 spec 放在 `qikairo7/dsh-web-search-fetch` 的 GitHub Issues，所有操作用 `gh` CLI（不走浏览器）。

安全报告不进公开队列：`CONTRIBUTING.md` 与 `SECURITY.md` 把它们导向私密漏洞报告。不要把安全报告拉进 triage，也不要在公开 issue 里引用其内容。

## 约定

- **建 Issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读 Issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列 Issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` 与 `--state` 过滤。
- **把 Issue 挂为父 Issue 的子项**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（`gh` 2.94+）。旧版 `gh`：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（数据库 id，见下文**阻塞**一节）。不支持子 issue 时，在子项正文开头写 `Part of #<parent>`。
- **评论**：`gh issue comment <number> --body "..."`
- **加 / 去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库从 `git remote -v` 推断；在克隆内运行 `gh` 会自动识别。`private-archive` 远端是归档镜像，不是 issue 面——始终面向 `origin`。

## PR 作为 triage 面

**PR 作为请求面：否。**_（若本仓库把外部 PR 当功能请求处理，改为 `yes`；`/triage` 读这个标志。）_

设为 `yes` 时，PR 走与 issue 相同的标签和状态，用 `gh pr` 的等价命令：

- **读 PR**：`gh pr view <number> --comments` 与 `gh pr diff <number>`。
- **列外部 PR 做 triage**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，光一个 `#42` 可能是任一：先用 `gh pr view 42` 解析，失败再 `gh issue view 42`。

## skill 说「发布到 issue 跟踪器」时

建一个 GitHub issue。

## skill 说「取相关工单」时

按上文**读 Issue**操作。

## Wayfinder 操作

供 `/wayfinder` 使用。**地图（map）**是一个带 `wayfinder:map` 标签的 issue，**子项**是作为工单的子 issue。

- **地图**：单个标签为 `wayfinder:map` 的 issue，正文含 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子工单**：作为 GitHub 子 issue 挂到地图（见上文**挂子项**）。子 issue 不可用时，把子项加进地图正文的任务列表，并在子项正文开头写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。被认领后分配给驱动的开发会话。
- **阻塞**：GitHub **原生 issue 依赖**，是 UI 可见的规范表示。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number` 也不是 `node_id`）。GitHub 通过 `issue_dependencies_summary.blocked_by` 汇报（仅开放阻塞方，即实时门禁）。依赖不可用时，回退为子项正文开头的 `Blocked by: #<n>, #<n>` 行。所有阻塞方关闭后，工单解除阻塞。
- **前沿查询**：列地图的开放子项（`gh issue list --state open`，限定地图的子 issue / 任务列表），剔除有开放阻塞方（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有开放 issue）或已有 assignee 的；按地图顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是会话的第一个写操作。
- **解决**：`gh issue comment <n> --body "<答案>"`，然后 `gh issue close <n>`，最后把上下文指针（gist + 链接）追加到地图的 Decisions-so-far。
