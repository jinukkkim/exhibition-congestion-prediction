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
- Merge via "Merge commit" (not squash/rebase) — keep each commit as-is in `develop`/`main` history
- Include tests for new features / bug fixes
- Prefer new commits over force-pushing to an open PR

### PR description template

```markdown
## 설명

<!-- 이 PR이 구현한 기능, 수정 사항 -->

## 구현 내용

<!-- 변경 사항을 세밀하고 정확하게 기술 -->

## 테스트

<!-- tests -->

```
