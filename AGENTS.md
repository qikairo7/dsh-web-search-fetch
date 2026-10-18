# AGENTS.md

## Dev loop

Development requests run through the `dev-loop` workflow-lite graph (impl → verify → accept → release, `subagent` mode). Entry: the user describes a need; the lead compiles the graph with the request. Ledger of delivered requests: `.scratch/dev-loop/ledger.md`. Rules the loop already enforces: worktree task branches, `pnpm run check` gate, red-on-revert regression proof, no merge/push without explicit user authorization. PR bodies follow the `pr` skill; Issue/PR triage follows `issue-pipeline`; acceptance probes reuse `.scratch/dev-loop/live-probe.mjs` (parameterize the query list, never rewrite).

Model routing is strict — `spawn_teammate` cannot select a model, so every step with a required model dispatches via `subagent` instead (the graph runs in `subagent` mode for the same reason): impl / verify / accept → provider `magpie`, model `group/deepseek-v4.1-flash1017`, reasoning_effort `high`; release and GitHub Issue/PR maintenance → `group/glm-5.3-flash`, `high`. The lead keeps glm-5.3 for analysis, review and decisions.

Toolchain on this machine: node/pnpm are not on PATH. node = `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`; pnpm = `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs` (run as `node <pnpm.mjs> <args>`). Nested `pnpm run` needs shims: create `node.cmd` + `pnpm.cmd` in `%TEMP%` forwarding to those paths, delete after. Fresh worktrees need `pnpm install --frozen-lockfile --prefer-offline` once (~1s, local store).

Review rule earned in PR #21's rework: when a change widens an early-return condition (dropping a guard like `fused.length > 0 &&`), the reviewer must run old-vs-new probes on the previously-fall-through path and compare every observable field, not just the changed message — a green suite does not prove untracked fields (`truncated`, operation notes) survived.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `qikairo7/dsh-web-search-fetch`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles map 1:1 to existing labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Testing third-party API contracts

When a test fixture encodes a third-party response shape, read the vendor's official API reference first and cite its URL in the fixture's comment. A fixture written from memory of a library type is unverified: it can go red on a path the real API never takes. Per-engine behaviour is in `docs/troubleshooting.md#目标站返回-4xx却报成服务不可用`.

## Proving a regression test bites

After fixing a bug, revert the fix in place, run the new test, and confirm it fails. Restore the fix, confirm it passes. A green test proves the code runs; only a red-on-revert test proves the test guards the behaviour.

An assertion that accepts two outcomes ("result with status 404, or an error whose message mentions 404") passes on both sides of the revert and guards neither. Assert the single observable the bug report names.

This is a manual step by design: the suite runs in seconds, so one revert costs less than a mutation-testing dependency.

