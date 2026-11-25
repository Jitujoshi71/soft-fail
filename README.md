# soft-fail

**GitLab-style `allow_failure` for GitHub Actions — finally.**

Run a flaky or external-dependency step so that when it fails, the job and the PR stay green, **but the failure stays visible** as a neutral check run with the full log. No more choosing between a red PR and a hidden failure.

## The problem

GitHub Actions has no native "allow failure". The feature has been requested since 2020 — [actions/runner#2347](https://github.com/actions/runner/issues/2347) (1,590+ reactions, 188 comments, still open) — and GitHub acknowledged it but never shipped it.

Today you only have two bad options:

| | PR status | Failure visible? |
|---|---|---|
| Normal failing job | 🔴 red | ✅ yes |
| `continue-on-error: true` | 🟢 green | ❌ no — the job is marked **success** and the failure disappears |

`soft-fail` gives you the third option:

| | PR status | Failure visible? |
|---|---|---|
| `soft-fail` | 🟢 green | ✅ yes — neutral check run + job summary, with the full log |

This is exactly how GitLab's `allow_failure: true` behaves.

## Usage

```yaml
permissions:
  checks: write   # soft-fail needs this to record the failure
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Flaky external check: must not block the PR, must not vanish either.
      - uses: Jitujoshi71/soft-fail@v1
        with:
          run: npm run test:external-api
          check-name: external-api (soft)

      # This step still runs — the job was not failed by the step above.
      - run: echo "job stayed green"
```

If the command exits `0`, the step passes normally. If it exits non-zero, `soft-fail`:

1. Creates a check run named `check-name` on the commit, with conclusion **neutral** (neutral never blocks a PR) and the command's output attached.
2. Adds a **job summary** entry pointing at that check run.
3. Exits `0`, so the job stays green. Outputs: `outcome` (`success` / `soft-failed`) and `exit-code`.

## Making soft failures visible on the PR

A neutral check run alone still shows the workflow as green ("all checks have passed"), which reviewers can easily miss — that was the first piece of feedback on this action. With `comment-on-pr: true`, soft-fail also posts (or updates) a comment on the pull request listing the soft failures of the latest run, with a link to each check run:

```yaml
permissions:
  checks: write
  contents: read
  pull-requests: write   # needed for the PR comment

- uses: Jitujoshi71/soft-fail@v1
  with:
    run: npm run test:external-api
    check-name: external-api (soft)
    comment-on-pr: true
```

- Several soft-fail steps in one run accumulate into the same comment (one line per check name; a retried step replaces its own line).
- When a later run of the same PR has no soft failures, the stale comment is removed by the first passing soft-fail step.
- Only the newest run may touch the comment: run ids grow over time, and an older run finishing after a newer one leaves the newer run's comment alone.
- If the comment cannot be posted (for example the workflow lacks `pull-requests: write`), soft-fail warns in the log but keeps the step green — the failure is already recorded as a neutral check run.
- The comment only applies to `pull_request` events; on other events the input is ignored.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `run` | ✅ | — | Command to run |
| `check-name` | | `soft-fail` | Name of the check run created on soft failure |
| `working-directory` | | `` | Directory to run the command in |
| `shell` | | `bash` | `bash`, `sh`, or `pwsh` |
| `create-summary` | | `true` | Add a job summary entry on soft failure |
| `comment-on-pr` | | `false` | Post or update a PR comment listing soft failures; remove it when a later run has none (needs `pull-requests: write`, `pull_request` events only) |
| `token` | | `${{ github.token }}` | Token used to create the check run (needs `checks: write`) |

## Outputs

| Output | Description |
|---|---|
| `outcome` | `success` or `soft-failed` |
| `exit-code` | Exit code of the command |

You can branch on the outcome in a later step:

```yaml
- uses: Jitujoshi71/soft-fail@v1
  id: soft
  with:
    run: ./scripts/flaky-check.sh
- if: steps.soft.outputs.outcome == 'soft-failed'
  run: echo "flaky check failed — paging the on-call, but not blocking the PR"
```

## Why not `continue-on-error`?

`continue-on-error: true` marks the failed job as **success**. The failure is invisible in the Checks tab and in branch protection — that is the gap 1,590 people were asking GitHub to close. `soft-fail` keeps the failure recorded as a real check run (neutral conclusion), so it is visible and auditable, while still not blocking the PR.

## Permissions

The workflow token needs `checks: write`. Add it at the top of your workflow file (shown above) or in the repository settings. If the check run cannot be created, `soft-fail` deliberately **fails the step** rather than silently hiding the failure — that guarantee is the whole point.

`comment-on-pr: true` additionally needs `pull-requests: write`. Without it the PR comment is skipped with a warning, while the check run is still recorded.

## Limitations

- **Fork PRs:** for `pull_request` events from forks, the default `GITHUB_TOKEN` is read-only and cannot create check runs. Use `pull_request_target` or a PAT with `checks: write` for those.
- **One command per step:** wrap multi-command sequences in a script or a single shell command (`cmd1 && cmd2`).
- **Log size:** the check run keeps the last ~6,000 characters of output (Checks API limit is 65,535).
- **PR comment:** only for `pull_request` events, and only while at least one soft-fail step in the run has `comment-on-pr: true`. The comment is removed by the first passing soft-fail step of a clean run — a workflow with no soft-fail steps never touches it.

## Development

```bash
npm run build   # copies src/index.js into dist/ (commit dist/ — Actions run from it)
```

Zero dependencies (Node 20 builtins only), so there is nothing to install.

The repo's own `.github/workflows/test.yml` exercises the action on every push: one intentionally failing command (must produce a neutral check and a green job) and one passing command.

## License

MIT — see [LICENSE](LICENSE).
