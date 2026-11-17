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


## No git remote

This repo has no remote yet. Where the section above says to pull or push, commit locally instead and stop there. Do not add a remote or try to push.

## Working a bead

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
