# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Git remote and PRs

The remote is `origin` (GitHub, `atzheng/planfully`). Bead work goes through a pull request on a branch named after the bead (`planfully-<id>`). Do not push bead work straight to `main`. Bead-state-only commits (`.beads/`) may go straight to `main`.

## Multi-agent workflow

One coordinator session runs several implementer and reviewer subagents. The coordinator holds the overall picture and is the only one that merges and changes bead state.

**Roles**

- **Coordinator** (main session):
  - picks beads with `bd ready`, claims them, starts implementers;
  - starts a reviewer per PR;
  - decides on findings, then merges and closes.
  - Do not read whole diffs into the coordinator context: use `gh pr diff --stat` and the reviewer's findings. Read the full diff only for high-risk beads (see below) or when a change touches `CONTRACTS.md`.
- **Implementer** (Sonnet subagent, own git worktree, one bead):
  - builds the bead per "Working a bead" below and opens the PR;
  - never runs `bd`: notes, follow-ups and contract changes go in the PR body.
- **Reviewer** (Sonnet subagent, one PR):
  - reviews independently and does not see the implementer's report;
  - never merges or edits the branch.

**Implementer, before opening the PR**

1. Merge `origin/main` into the branch.
2. Regenerate the lockfile and resolve conflicts.
3. Run `pnpm test && pnpm typecheck && pnpm lint` (and `pnpm build` for web beads).
4. Push the branch and open the PR with `gh pr create`.
5. Include in the PR body:
   - each acceptance point and how it was verified;
   - contract changes or deviations;
   - anything noticed but not done.
6. UI beads must check the result in a browser at 375px and desktop, light and dark, and attach at most four screenshots. If no browser is available, say so in the PR. Do not claim the check was done.
   - When no browser extension is connected, use headless Chrome. Install `playwright-core` into a temp dir outside the repo and launch with `executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`, a `viewport` and `colorScheme`. Check `document.documentElement.scrollWidth <= clientWidth`, then view the screenshots.

**Reviewer brief.** The coordinator gives the reviewer:
- the PR number and bead id;
- the relevant `CONTRACTS.md` sections;
- known risks for the bead;
- what the beads it blocks expect from it (from `bd show` on those beads).

That last item is how problems that span beads get caught.

**Reviewer steps**

1. Check out the branch and run the tests.
2. Try to break the change. Back a suspected bug with a failing test where practical.
3. Post the findings as one PR review comment.
4. Return the same findings to the coordinator. Each finding gives:
   - severity;
   - `file:line`;
   - the failure scenario;
   - whether it is confirmed by a test or only likely.

Keep the reviewer brief self-contained so it does not need to read all of `SPEC.md`.

**Review depth by risk**

- Low (placeholders, styling, config): the coordinator reads the `--stat` and the PR body. No reviewer is needed.
- Normal: one reviewer.
- High (crypto, auth, ingest/LLM parsing, log folding): one reviewer, and the coordinator also reads the diff.

**After review** the coordinator chooses one of four actions for each finding:
- send it to the *same* implementer via SendMessage, so it keeps its context;
- fix a trivial issue directly;
- file a follow-up bead;
- dismiss it.

Then the coordinator merges with `gh pr merge --merge`, closes the bead with a reason, and starts agents for any newly ready beads.

**Scheduling.** Start a bead only after its dependencies are merged; do not build stand-ins for unmerged work. Start new beads as earlier ones merge rather than in fixed waves.

**Worktrees.**
- Keep an implementer's and a reviewer's worktree until their PR merges. A subagent whose worktree was removed cannot be resumed with SendMessage.
- After a merge, remove the worktrees and delete the local branches.

**Bead state.** Do not silence `bd` output: a failed `bd close` otherwise goes unnoticed.

**Keeping the coordinator lean.**
- Fix environment problems once, before starting agents, and pass known pitfalls in each brief.
- Trim command output (`tail`, `grep`).
- Start a fresh coordinator session every few rounds; beads holds the state.

## Working a bead

Implementer subagents skip the `bd` steps (2, 7 and the note on blocked beads): the coordinator claims and closes, and blockers or follow-ups go in the PR body or the final report.

1. `bd show <id>` and read all of it: description, design, acceptance. Then read the sections of `SPEC.md` and `CONTRACTS.md` it names.
2. `bd update <id> --claim`.
3. Build only what the bead describes. Its design notes list the files it owns; avoid editing files owned by other beads. If you must, keep the change minimal and mention it when closing.
4. `CONTRACTS.md` fixes names, shapes and file paths shared between beads. Follow it exactly. If it is wrong or incomplete, fix it in the same commit and say so when closing — do not silently diverge.
5. Before closing: `pnpm test && pnpm typecheck && pnpm lint` must pass, and every acceptance point must be checked. For UI beads, run `pnpm dev` and `pnpm seed` and look at the result in a browser at desktop and phone width.
6. Commit with the bead id in the message, e.g. `planfully-j7b.2: shared schema and time helpers`. Commit only your own files.
7. `bd close <id> --reason "<what was done, anything the next bead should know>"`. File a new bead for anything you found but did not do.

If a bead cannot be finished (missing key, unclear contract, blocked by something not listed as a dependency), do not guess: leave a note with `bd update <id> --append-notes "..."` and stop.

## Build & Test

```bash
pnpm install
pnpm test          # all packages
pnpm typecheck
pnpm lint
pnpm dev           # Worker on :8787, Vite on :5173 with /api proxied
pnpm seed          # creates a sample trip on the local Worker, prints its URL
```

These exist once the scaffold bead (`planfully-j7b.1`) is closed.

## Architecture Overview

Read `SPEC.md` (what the product does) and `CONTRACTS.md` (exact interfaces). In short: a Cloudflare Worker receives email, parses it with Claude, encrypts the resulting events to the trip's public key and stores ciphertext in D1 (records) and R2 (attachments). The React app holds the private key from the URL fragment, downloads the ciphertext, decrypts and renders it. The server cannot read stored trip data.

- `packages/shared` — schema, crypto, log folding. Used by both sides; must run in the browser, Workers and Node.
- `packages/worker` — email handler, HTTP API, LLM parsing, geocoding.
- `packages/web` — React app.

## Conventions & Patterns

- TypeScript strict. No `any` without a comment saying why.
- Pure logic (folding, filtering, layout, time, weather resolution) lives in plain functions with unit tests, separate from React components.
- The trip secret lives only in the URL fragment and in memory (later IndexedDB). Never put it in a query string, a request, or a log.
- The Worker never logs email content, event content, or tokens.
- Every UI feature must work at 375px wide and in light and dark themes.
- Tests must not call real external services. Anthropic, Google and Open-Meteo are mocked in tests; scripts that hit real APIs are opt-in and separate.
- The code must run with `ANTHROPIC_API_KEY` and the Google Maps keys unset (see `CONTRACTS.md` section 8).
- For anything involving the Anthropic API, load the `claude-api` skill or read current docs first; do not write request shapes from memory.
