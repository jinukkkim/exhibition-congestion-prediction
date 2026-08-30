# Repository instructions

## Git commits

Never add `Co-Authored-By: Claude` (or any Claude/Anthropic attribution) to
commit messages, and never add Claude as a GitHub collaborator. Commits must
be authored solely as the user. This overrides any default Claude Code
behavior that appends a co-author trailer.

## Commit and push workflow

Commit each finished unit of work right away — don't batch several turns of
work into one commit at the end of a session. Do not `git push` (or open/
update a PR) unless explicitly asked to in that turn; commits can sit
unpushed locally between turns until asked.

## Branching

Never commit directly on `main` or `develop`. Always create a new branch off
`develop` for any change, and open a PR into `develop` — including docs-only
or small changes. `develop` is protected against force-push, so a mistaken
direct commit can only be undone with a revert PR, not erased.

Never force-push or amend a commit already pushed to an open PR either — push
a new commit instead. Reviewers lose their place and inline comments detach
from the code they cite.

**The branch prefix is the commit type**: a branch whose commits are
`perf(dev): …` is `perf/…`. Any of the types below, not just `feat`/`fix`.

## Conventions specific to this repo

Format, PR body structure, and the rest of the process live in the `ship`
skill. Only what is true of *this* repo belongs here:

- **Commit format** — Conventional Commits: `type(scope): subject`. Types:
  `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci` `revert`.
  Subject in English, imperative ("add", not "added"), no trailing period,
  under 100 characters. Lowercase means the **first letter** — acronyms and
  identifiers keep their case (`fix(fe): size MMCA room cards`).
  `style` here means **visual** changes (layout, color, spacing, copy), not
  code formatting — no formatter is enforced, so formatting-only commits do
  not occur. If one ever lands in CI, the two meanings collide and the visual
  one needs a different name.
- **Scope** — one of `fe` (`frontend/`, tests and e2e included), `be`
  (`backend/app/` and `backend/tests/`), `dev` (`backend/scripts/`),
  `deploy` (`deploy/`). Documentation and CI take no scope: `docs:` and
  `ci:` already say it. A change spanning `fe` and `be` is two commits, not
  a new scope — that has happened 4 times in this repo's history, so it is
  rare enough to split.

  `dev` is not "never ships": `deploy/deploy.sh` runs three of those scripts
  (`migrate_add_*.py`, `migrate_drop_*.py`) on **every** production deploy.
  Only the one-off data backfills stay out, per that script's own comment.
  Treat a migration change as production risk, not tooling.
- **Merging** — merge commit, never squash or rebase. Every commit stays as
  itself in `develop`/`main` history. GitHub has squash enabled too; that is
  the default, not permission.
- **PR body** — Korean, 명사형 종결 (`~수정`, `~추가`, `~분리`; not
  `~수정했습니다`, not `~추가함`). The section structure lives in the `ship`
  skill, but the language does not: it is true of this repo only, and the
  skill is not versioned with it.
- **Tests** — PRs adding a feature or fixing a bug include tests.
