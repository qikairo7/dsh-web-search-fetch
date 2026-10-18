# AGENTS.md

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

