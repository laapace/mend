# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/laapace/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/laapace/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and `mend` reads all of them: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Old lines are matched at three tiers — exact, ignoring trailing spaces and tabs, then ignoring leading and trailing spaces and tabs — so drifted whitespace and wrong line numbers still apply. Every file is changed or nothing is.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: 0 when the tree is written (one `A`/`D`/`M`/`R` line per changed path, then `ok: <n> files`), 1 when an edit failed (one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`, and nothing is written), 2 on a usage, missing-patch, format or parse error (exactly one `error:` line).

Node 22 and its standard library alone. `runner.ts` is the kit's trial runner (kept as-is): when `MAKEFUN_ENV_URL` is set, `main.ts` hands a trial over to it. `check.ts` runs the public practice set on your own machine.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
