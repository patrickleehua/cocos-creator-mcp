# Security policy

## Report vulnerabilities privately

Do not put suspected vulnerabilities, exploit details, live tokens or sensitive project data in public issues, pull requests, discussions or CI logs.

If this repository has GitHub private vulnerability reporting enabled, use **Security → Report a vulnerability**. If that option is unavailable, use a maintainer's published contact method to request a private reporting channel before sharing technical details. The initial request should only ask how to report privately; do not include the exploit, credentials or confidential attachments. Wait for an agreed private channel if none is published.

The public repository is [patrickleehua/cocos-creator-mcp](https://github.com/patrickleehua/cocos-creator-mcp). Private reporting has been enabled; use [Report a vulnerability](https://github.com/patrickleehua/cocos-creator-mcp/security/advisories/new) for sensitive reports.

For ordinary reproducible bugs that do not expose a security issue, use the public bug form after redacting sensitive information. See [CONTRIBUTING.md](CONTRIBUTING.md) for reproduction guidance.

## Useful private report details

- Affected package version or revision, exact Creator version, OS/architecture, external Node.js and editor Node/Electron versions.
- Whether the editor is stock or locally patched, including relevant backport module names and manifest entries.
- The affected trust boundary and impact: for example authentication bypass, non-loopback access, session/project confusion, command allowlist bypass or unintended file changes.
- Minimal steps with a synthetic disposable project, expected behavior and the observed result. Include error codes and timestamps where useful.
- Suggested mitigation, if known, and whether any uncertain writes or background builds remain in progress.

Redact live Bearer tokens, Authorization headers, session credentials, API keys, cookies, environment secrets, personal filesystem paths, private asset URLs and proprietary code. Do not send a complete live session.json or an entire production project. Use throwaway credentials in a synthetic reproduction if credentials are needed to demonstrate the issue.

## Security boundaries

The MCP service is intended for a trusted client that is allowed to edit the selected local Creator project. Native scene, asset and build commands can write files. The loopback HTTP bridge uses a per-session Bearer token, project/session identity checks, a command allowlist, bounded request bodies and Host/Origin validation.

The session discovery file under `<project>/temp/cocos-creator-mcp/session.json` contains credentials. Treat access to that file and the local user account as trusted. The bridge is not a sandbox between processes running as the same user, and a loopback listener does not make an exposed token harmless.

Do not expose the bridge through a public bind address, tunnel, reverse proxy or browser integration that bypasses its checks. Do not disable authentication or commit discovery files to source control. Keep the configured project path and the editor session aligned.

If a token may have leaked, disconnect the MCP client and stop the bridge or disable the extension. Inspect already dispatched writes and background build jobs: disconnecting a client or stopping discovery does not undo native work. Restarting the bridge creates a new token/session; review the project's observed state before repeating an uncertain operation.

## Scope and handling

Report issues on the current development code or an identified distributed version, and include the exact revision so maintainers can reproduce them. Creator itself, proprietary packages and third-party dependencies may require a separate report to their maintainers; describe the affected component without assuming this project can patch it.

Keep additional exploit details in the agreed private channel during triage. Coordinate any public disclosure with the maintainer rather than posting credentials or a working exploit in a public issue.
