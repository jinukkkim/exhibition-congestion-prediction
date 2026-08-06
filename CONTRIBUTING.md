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

- **Title**: English, follows the commit convention format (`type(scope): subject`)
- **Description**: Korean, follows the template below
  - 기술적이고 간결하게 작성
  - 종결어미는 명사형 종결 사용 (예: `~수정`, `~추가`, `~분리` / ~~`~수정했습니다`~~, ~~`~추가함`~~)
- Merge via "Merge commit" (not squash/rebase) — keep each commit as-is in `develop`/`main` history
- Include tests for new features / bug fixes
- Prefer new commits over force-pushing to an open PR

