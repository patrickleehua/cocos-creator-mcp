# Contributing

Start with the [README](README.md) for installation and current compatibility results. Use the bug or feature forms for public reports. Suspected vulnerabilities must follow [SECURITY.md](SECURITY.md).

## Development setup

Use external Node.js 20 or newer and npm. From the repository root:

```sh
npm ci
node scripts/test.mjs
```

The launcher enumerates `tests/*.test.cjs`, `tests/*.test.mjs` and `tests/*.test.js` with the filesystem API, sorts the filenames and starts the current Node executable with `--test`. It does not depend on shell glob expansion, so the same command works on Windows and Unix. Output is inherited; failures and interruptions propagate to the caller.

Pass additional Node test-runner flags after the launcher name:

```sh
node scripts/test.mjs --test-reporter=spec
node scripts/test.mjs --test-name-pattern="preview.open"
node scripts/test.mjs --test-concurrency=1
```

The package test script forwards options in the same way: `npm test -- --test-name-pattern="preview.open"`.

## Windows process windows and stdio clients

Configure an MCP stdio client to launch the external Node executable directly, for example `C:/Program Files/nodejs/node.exe`, with the absolute path to `src/server.mjs`, `--project` and the absolute project path as separate arguments. Use the client configuration example in the [README](README.md). Avoid `cmd`, `start`, batch files or shell wrappers; they add process and console behavior outside the stdio service.

The public Node test launcher and SDK child-process launches already use `windowsHide: true`. An earlier ignored private native test launcher used Electron's `--enable-logging` flag, which was associated with native child console popups; that flag has been removed. This does not guarantee that every native Creator or builder subprocess will remain windowless. If a popup recurs, include the exact launch command and a sanitized process tree in the report.

Real integration still requires the Creator GUI with the fixture open, the extension enabled and the editor ready. These launch settings do not provide a headless Creator workflow; public unit tests do not require the editor.

## Architecture and change boundaries

| Area | Responsibility |
| --- | --- |
| [src/server.mjs](src/server.mjs) | CLI and stdio MCP lifecycle. Keep stdout reserved for protocol messages; diagnostics go to stderr. |
| [src/tools.mjs](src/tools.mjs) | MCP schemas, tool/action validation, dynamic capability exposure and structured errors. |
| [src/bridge-client.mjs](src/bridge-client.mjs) | Project discovery, authenticated health checks, session identity, timeouts and unknown write outcomes. |
| [bridge.js](extensions/cocos-creator-mcp/bridge.js) | Loopback-only HTTP, Bearer authentication, Host/Origin checks, body bounds, serial dispatch, deduplication and discovery ownership. |
| [adapter.js](extensions/cocos-creator-mcp/adapter.js) | Native scene, asset, component, property and prefab operations with readback and identity remapping. |
| [extras.js](extensions/cocos-creator-mcp/extras.js) | Preview, native logger normalization and background build jobs/cancellation ownership. |
| [scene.js](extensions/cocos-creator-mcp/scene.js) | Scene-process helpers where native scene access is required. |
| [tests](tests/) | Mocked Editor contracts, real local HTTP and SDK/stdio tests; no Creator installation is required. |

The external service uses Node.js 20+. Code loaded inside Creator must remain CommonJS and compatible with its embedded Node.js 14 runtime. Do not introduce `fetch`, `node:` imports, newer optional runtime APIs or external runtime dependencies into the extension without an explicit compatibility change and native validation.

For a native command change, inspect the installed editor's actual `<Editor.App.path>/builtin/<module>/package.json` and its `contributions.messages`. A manifest entry establishes registration, not the argument contract or successful execution. Match the installed version, check declarations where available, and verify the real callee/result on a disposable project. Keep unsupported capabilities out of tool discovery.

Preserve error codes and JSON-safe details. Distinguish accepted requests, verified mutations and saved data. Keep queued mutations serial even when a client disconnects; never release a dispatch lock merely because a timeout race finished. Background builds must keep their busy lock until the native promise settles. A write with `outcome:"unknown"` must be inspected before any repeat attempt.

## Tests and CI scope

The CI workflow runs `npm ci` and `node scripts/test.mjs` on Windows and Ubuntu with Node.js 20, 22 and 24. Its packaging job checks CLI help, performs an `npm pack` dry run and creates a local tarball with lifecycle scripts disabled. It does not publish a package.

These jobs do not install or start Creator. A passing CI matrix demonstrates the covered service, bridge and mocked contracts on those Node/OS combinations; it does not establish native Creator compatibility on those operating systems.

Add a focused regression for changed behavior or a reproduced bug. Include meaningful failure paths and readback assertions rather than assuming that a native request returning proves success. Run the unit launcher before submitting. Describe which manual Editor checks ran, including exact versions and report step counts; mark checks that were not run.

## Manual Creator integration

The three suites modify scenes and assets, save project files and may reimport scripts. Run them sequentially against a dedicated disposable fixture, with no concurrent editor automation. Never point them at a production project.

Create a new fixture using the installed editor's template and identity. The directory passed to the creator script must not already exist. This example uses a local Windows installation; replace the installation path with the actual Creator directory:

```sh
node -e "require('node:fs').mkdirSync('.work', { recursive: true })"
node scripts/create-test-project.mjs ".work/contributor-3.7.3" "C:/ProgramData/cocos/editors/Creator/3.7.3"
```

The helper copies the installed scene template, installs the project extension and writes `.cocos-mcp-test-project.json`. Its UUID must equal the project's `package.json` UUID, and its `purpose` must be `cocos-creator-mcp integration tests`. Each suite verifies the marker; do not bypass those checks or add the marker to an existing personal project.

Open that fixture in the matching Creator version, enable the project extension, restart the editor and wait for a saved scene and asset database to become ready. After changing extension code, update the fixture copy and restart before rerunning:

```sh
node scripts/install-extension.mjs ".work/contributor-3.7.3" --update
```

Run the three suites in order, using separate report files:

```sh
node scripts/integration.mjs ".work/contributor-3.7.3" ".work/contributor-core.json"
node scripts/integration-references.mjs ".work/contributor-3.7.3" ".work/contributor-references.json"
node scripts/integration-extras.mjs ".work/contributor-3.7.3" ".work/contributor-extras.json"
```

| Suite | Coverage |
| --- | --- |
| `integration.mjs` | SDK handshake, scene/node/component edits, history, assets, UI, prefab and persistence/readback. |
| `integration-references.mjs` | Compiled custom scripts, derived image subassets, serialized references, events, prefab remapping and scene reopen. |
| `integration-extras.mjs` | Native preview URL/refresh, filtered native logger data and registered build configuration. |

For repeated native read/write, save/reopen and SDK connection lifecycle checks, use `scripts/soak.mjs`. It defaults to eight hours, requires a marked disposable fixture and writes a new report outside that fixture. See [production qualification](docs/PRODUCTION-READINESS.md) for commands, resource limits, finite pilot runs and report semantics. A short pilot or an interrupted run does not establish an eight-hour pass.

Real build cancellation is an explicit additional test. It starts a native Web build, writes build output, identifies the job's own native task and waits for terminal state:

```sh
node scripts/integration-extras.mjs ".work/contributor-3.7.3" ".work/contributor-cancel.json" --build-cancel
```

A cancellation returning native code 34 with an interrupted-build message can validate cancellation; it is not a successful build. An unknown terminal outcome must be inspected before starting another job. Preview request acceptance, an intercepted `openExternal` URL, independent browser rendering and a successful build each need their own evidence; do not combine them into an unsupported end-to-end claim.

## Version and evidence records

The [validation manifest](analysis/validation/manifest.json) records exact editor versions, distribution identity, ASAR hashes and report coverage. Existing stock/official package evidence for 3.7.0, 3.7.1, 3.7.2 and 3.7.4 is distinct from the local 3.7.3 installation with `resources/repack.json` backports. The latter includes modules such as builder-ui, engine and global-builtin-hot-update and must not be described as an unmodified stock 3.7.3 validation.

For new native results, record OS/architecture, editor version, external Node version, editor Node/Electron versions, stock versus modified distribution, relevant manifest entries and installation hash when available. Keep static observations, mock tests, native requests and persisted/browser results separate. Use a fresh fixture per editor version. Do not claim a version or platform passed because a nearby version or unit test did.

## Reproducible reports and changes

Include the minimal numbered reproduction, exact MCP tool/action arguments or test command, expected result, observed side effects, error `code`/`details`/`outcome`, log `scope`, exit status and failed suite step. Replace private filesystem paths and asset URLs with consistent placeholders such as `<PROJECT>` and `db://assets/Repro/`; preserve relationships needed to understand the failure.

Before attaching JSON reports, screenshots or logs, remove Bearer tokens, Authorization headers, session tokens, API keys, environment secrets, usernames, private project/asset paths and proprietary source or assets. Do not attach `temp/cocos-creator-mcp/session.json`. Use synthetic fixtures and upload only sanitized excerpts. Security details go through the private process in SECURITY.md.

Keep changes focused. Explain the concrete behavior change, why it is needed, relevant compatibility boundaries and the exact validation performed. Do not submit `node_modules`, local `.work`/`.research` data, installed editor files, extracted proprietary implementations, build outputs or tarballs. Use only code and assets you have permission to contribute.

## Contribution licensing and attribution

Original code and documentation contributions are expected to be licensed under this project's [MIT License](LICENSE). Submit only material you have the right to contribute under those terms, and preserve applicable copyright and permission notices.

Read [NOTICE.md](NOTICE.md) for attribution and source boundaries. Include source attributions and permission records when proposing third-party material. Creator packages, dependencies and reference projects retain their own terms; this project's MIT license does not relicense them.

The reference snapshot identified in NOTICE.md has no standalone LICENSE and includes commercial-use and derivative-code restrictions in its README. Do not import that code without verified permission covering the intended distribution. A publicly visible repository, a similarity scan or a passing test suite does not establish permission to reuse its contents.
