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

Never commit directly on `main` or `develop`. Always create a new branch
(e.g. `feat/...`, `fix/...`, `test/...`, `docs/...`) off `develop` for any
change, and open a PR into `develop` — including docs-only or small changes.
`develop` is protected against force-push, so a mistaken direct commit can
only be undone with a revert PR, not erased.
