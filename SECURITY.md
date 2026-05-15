# Security Policy

## Supported Versions

This project is experimental and tracks private ChatGPT/Codex backend behavior. Only the current `main` branch is supported.

## Reporting Issues

Please report security-sensitive issues privately to the repository owner instead of opening a public issue.

## Deployment Guidance

- Do not expose the proxy directly to the public internet.
- Always set `PROXY_API_KEY` outside isolated local development.
- Store `.env` securely and never commit real OAuth tokens.
- Treat `OPENAI_REFRESH_TOKEN` as a long-lived secret.
- Put the service behind private networking, firewall rules, or a trusted reverse proxy.
- Avoid logging request bodies, model outputs, OAuth tokens, or caller API keys.

## Automated Checks

The repository uses GitHub-native checks for routine maintenance and security visibility:

- Dependabot checks npm, Docker, and GitHub Actions updates weekly.
- Dependency Review blocks pull requests that introduce vulnerable dependencies at moderate severity or higher.
- CodeQL runs on pushes, pull requests, and a weekly schedule.
- The Security workflow runs `npm audit` and Trivy filesystem/image scans, then uploads SARIF results to GitHub code scanning.

## Known Risk

This proxy depends on unofficial/private ChatGPT/Codex backend behavior. That backend can change without notice, and its use may have legal, provider-terms, operational, or security implications. Review those risks before deploying.
