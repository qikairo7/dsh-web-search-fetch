# 领域文档

engineering skills 在探索本仓库代码时，如何使用本仓库的领域文档。

## 探索前先读

- 仓库根的 **`GLOSSARY.md`**。
- **`docs/adr/`**：读与你将要改动的区域相关的 ADR。

这些文件若不存在，**安静地继续**。不要提示它们缺失，也不要预先建议创建。`/domain-modeling` skill（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 触达）会在术语或决策真正落定时惰性创建它们。

## 文件结构

单上下文仓库：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

`docs/adr/` 目前不存在。第一条难以回退的决策被记录时由 `/domain-modeling` 创建，不预建空目录。

`DESIGN.md` 不是 ADR 意义上的领域文档：它描述当前模块职责，随代码一起维护。架构问题读它；但约束后续工作的决策要记成 ADR。

## 用术语表的词汇

你的产出命名领域概念时（issue 标题、重构提案、假设、测试名），使用 `GLOSSARY.md` 定义的术语，不要漂移到术语表明确避开同义词。

你需要的概念还不在术语表里时，这是一个信号：要么你在发明项目不用的语言（重新考虑），要么存在真实缺口（记给 `/domain-modeling`）。

## 标出 ADR 冲突

你的产出与现有 ADR 矛盾时，显式指出而不是静默覆盖：

> _与 ADR-0007（订单事件溯源）矛盾，但值得重开，因为……_
