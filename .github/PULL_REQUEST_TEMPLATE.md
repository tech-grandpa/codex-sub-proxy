## Release Impact

Choose the PR title prefix that matches the intended release impact:

- `feat:` for a minor version bump
- `fix:` for a patch version bump
- `feat!:` or `BREAKING CHANGE:` for a major version bump
- `docs:`, `ci:`, `chore:`, `test:`, `refactor:`, `style:`, `build:`, or `perf:` when no user-facing release is needed

For documentation-only changes, add the `ci:docs-only` label to make the CI skip explicit.

## Checklist

- [ ] The PR title follows Conventional Commits.
- [ ] The release impact above matches the change.
- [ ] Documentation was updated when behavior or user-facing workflow changed.

