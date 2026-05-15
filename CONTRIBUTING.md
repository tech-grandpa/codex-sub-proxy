# Contributing

Thanks for helping improve `codex-sub-proxy`.

## Branches

Use short-lived feature branches for all changes:

```text
feat/<short-description>
fix/<short-description>
docs/<short-description>
ci/<short-description>
```

Changes are merged through pull requests targeting `main`. Pull requests are squash-merged so the PR title becomes the commit that lands on `main`.

## Pull Request Titles

PR titles must follow Conventional Commits:

```text
feat: add model cache
fix: handle upstream timeout
docs: clarify Docker setup
ci: update release workflow
```

The title is the release signal:

| Title | Release impact |
| --- | --- |
| `fix: ...` | Patch |
| `feat: ...` | Minor |
| `feat!: ...` | Major |
| Footer `BREAKING CHANGE: ...` | Major |
| `docs: ...`, `ci: ...`, `chore: ...` | No release by default |

## Documentation-Only Changes

Documentation-only PRs can add the `ci:docs-only` label. CI verifies that only documentation paths changed before skipping npm install, build, tests, and Docker build.

Documentation-only paths are:

- `README.md`
- `SECURITY.md`
- `LICENSE`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `docs/**`
- `.github/*.md`

## Docker Images

Feature branches are transient. They run verification, but they do not publish persistent Docker images.

Pull requests build the Docker image without pushing it. Persistent images are published only for:

- `main`
- immutable commit SHA tags
- version tags such as `v0.2.0`

## Releases

Releases use release-please and Conventional Commits.

After releasable commits land on `main`, release-please opens or updates a release PR. Merging that PR updates package metadata and changelog content, creates the next semver tag, creates a GitHub Release, and publishes the matching Docker image tag.

For protected branches, release-please should use a `RELEASE_PLEASE_TOKEN` repository secret from a fine-grained personal access token or GitHub App token that can create pull requests. That lets CI run on release PRs. Without that secret, the workflow falls back to `GITHUB_TOKEN`, which can prepare releases but may not trigger follow-up workflows for bot-created PRs.

Manual tags matching `v*` are also treated as releases. A tag push creates GitHub release notes from the commits since the previous release and publishes the matching Docker image tag.
