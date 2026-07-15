# Contributing

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>
```

- `type`: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`
- `scope` (optional): `be`, `fe`, or the touched area (e.g. `scheduler`, `prediction`)
- `subject`: lowercase, imperative mood ("add" not "added"), no trailing period, under 100 chars
- `body` (optional): explain what and why, Korean or English

Example: `fix(be): close redis pubsub connection on sse generator teardown`

## Branching

- `main` — production, only updated via PR from `develop`
- `develop` — integration branch, all feature work merges here
- `feat/...`, `fix/...` — work branches off `develop`, merged back via PR

## Pull requests

- Title follows the commit convention above (used as the squash-merge commit message)
- Description: what the PR solves, and `Closes #123` if it closes an issue
- Include tests for new features / bug fixes
- Prefer new commits over force-pushing to an open PR
