# Cocos Creator 3.7 MCP

[![CI](https://github.com/patrickleehua/cocos-creator-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/patrickleehua/cocos-creator-mcp/actions/workflows/ci.yml)

[简体中文](README.md) · [Feature comparison](docs/COMPARISON.md) · [Operations](docs/OPERATIONS.md) · [Stability and evidence](docs/STABILITY.md)

Control Cocos Creator 3.7 projects from an MCP client through native editor APIs: inspect scenes, edit nodes and components, set typed properties and references, manage assets and prefabs, and request previews and builds.

The MCP server runs in an external modern Node.js process. A small project extension runs inside Creator's older runtime. The implementation defines **17 MCP tools and 36 bridge commands**, filtered by the capabilities of the connected editor session. The internal authenticated HTTP bridge is not an HTTP MCP endpoint; clients use **stdio MCP**.

**Status: 0.1.0, experimental public testing.** Native Windows x64 workflows have been exercised on **3.7.0–3.7.4**, including actual **3.7.1 and 3.7.2** installations. A successful complete `web-desktop` build with `debug:true` is recorded only for the local, backported 3.7.3 installation. Long-running reliability, native macOS/Linux editors and all build targets have not been validated. Evaluate on a version-controlled project copy. This is not a production-stable claim.

## Quick start

Requirements: Creator **3.7.x**, a working project, external Node.js **20+** with npm, and a stdio MCP client. Node.js **22 or 24 LTS** is recommended for normal use; see the [official Node.js release schedule](https://github.com/nodejs/Release).

Close Creator for the target project, clone the repository, then install the extension:

```sh
git clone https://github.com/patrickleehua/cocos-creator-mcp.git
cd cocos-creator-mcp
npm ci
node scripts/install-extension.mjs "D:/projects/MyGame"
```

The extension is installed under `<project>/extensions/cocos-creator-mcp`. Enable it as a **project extension** in Creator's Extension Manager, restart Creator, open the project and a scene, and wait for asset import to finish. The console prints `[cocos-creator-mcp] Bridge ready ...` when ready. The **Cocos MCP** menu provides Start bridge, Stop bridge and Show status.

For an existing installation, close Creator and use `--update`, then restart:

```sh
node scripts/install-extension.mjs "D:/projects/MyGame" --update
```

The installer checks project identity and version, rejects symlink/junction paths and unrelated destination directories, stages and verifies files before replacement, and attempts rollback if replacement fails. It is not a power-loss transaction. Recovery details are in [STABILITY.md](docs/STABILITY.md#安装与更新).

Configure a client that accepts `mcpServers` as follows. Replace both paths with absolute paths on your machine:

```json
{
  "mcpServers": {
    "cocos-creator-37": {
      "command": "node",
      "args": [
        "D:/tools/cocos-creator-mcp/src/server.mjs",
        "--project",
        "D:/projects/MyGame"
      ]
    }
  }
}
```

Use an absolute Node executable path if your client cannot find `node`. One server process targets one project, which must match the open Creator project. Start with `editor_info` and `scene_query` to check identity, version and unsaved state.

Example request:

> Inspect the scene. Under Canvas, create a Greeting node with a Label containing “Hello, Cocos 3.7”. Read the result back, then save the scene.

The service CLI is `node src/server.mjs --project "D:/projects/MyGame" [--timeout 45000]`. Timeout is in milliseconds, defaults to 15000, and applies to one bridge request rather than the lifetime of a background build. A stdio server waits for protocol input without an interactive prompt.

### Windows console windows

Let the MCP client launch `node` directly; avoid `cmd /c start` wrappers. Ordinary scene operations do not launch test editors or extra terminals. A manually opened service terminal must remain running. Node test subprocesses use `windowsHide:true`.

Native test launches previously used extra `--enable-logging` diagnostics and left child processes behind, producing console windows. The test procedure now omits that switch, redirects output to files and cleans up its own processes. See [Electron's Windows logging limitations](https://www.electronjs.org/docs/latest/api/command-line-switches#--enable-loggingfile). Native build-tool subprocess behavior still depends on Creator and the target toolchain.

## Tools

| Area | MCP tools / operations |
| --- | --- |
| Editor | `editor_info`, `editor_logs`; known native log formats support level, count and millisecond timestamp filters. |
| Scenes | `scene_query`, `scene_open`, `scene_save`, `scene_create` using the installed 2D template, `scene_history` undo/redo. |
| Nodes | `node_query`; `node_edit` create/remove/reparent/duplicate. |
| Components | `component_edit` catalog/list/add/remove, including exact instance selection. |
| Properties | `property_set` with native types and readback, including tested Node/Component/Asset/array/event-reference paths. |
| Assets | `asset_query` search/info/meta/uuid/url/path; `asset_edit` create/save/import/move/copy/delete/meta. |
| Prefabs and UI | `prefab_manage` create/instantiate with identity remapping; `ui_build` recursive subtree creation. |
| Preview | `editor_preview` info/open/refresh. |
| Build | `project_build` config/start/status/cancel with asynchronous task tracking. |

Use the current tool schema for complete arguments. [OPERATIONS.md](docs/OPERATIONS.md) explains persistence, typed values, SpriteFrame import, Label sizing, partial failures, preview and build semantics. Detailed comparison and operations documents are currently in Chinese.

## Compatibility and limits

The reference [cocos-mcp-server](https://github.com/DaxianLee/cocos-mcp-server) snapshot is package **1.5.4**, declaring Creator **≥3.8.6**. The [comparison](docs/COMPARISON.md) pins its source commit, inventories actual public dispatch paths, and separates implementation gaps from observed editor-version differences. The reference extension has not been runtime-tested in this comparison. Its README includes both public-source and Pro descriptions; advertised counts are not treated as verified features.

This project is not a complete replacement. Dedicated advanced Prefab editing, clipboard/reset operations, scene-view controls, reference images and preferences remain gaps. Some broader tasks can be composed through generic component/property tools; that does not establish a complete dedicated workflow.

Creator 3.7 needs explicit adaptation for component creation/removal, asset URL arguments, typed dumps, prefab identity changes and older Node.js. Grouped undo and cross-resource transactions are not provided. Compound edits may partially complete. Save before switching scenes, starting preview or building. Re-query identities after prefab conversion or scene reopen.

The bridge binds only to `127.0.0.1`, uses a random port and Bearer authentication, checks Host/Origin and project/session identity, and serializes allowlisted RPCs. It is intended for a trusted local client. **Never share or commit `<project>/temp/cocos-creator-mcp/session.json`**, which contains session credentials.

Writes are never automatically retried. A timeout/disconnect may leave an operation running; inspect state before deciding what to do next. Preview `requested:true` does not prove rendering. A build task ID does not mean success: poll until terminal state; success requires native code **36**. Cancellation acceptance also requires a later terminal-state check. Avoid concurrent manual/automated edits and native builds in the same project.

## Tests and contributions

```sh
npm ci
npm test
```

The current local unit/contract suite passes **420/420** tests and requires no Creator installation. The initial source commit passed all seven [hosted CI jobs](https://github.com/patrickleehua/cocos-creator-mcp/actions/runs/38938026924): Windows/Ubuntu × Node.js 20/22/24, plus package checks. The badge shows current status. Native integration uses marked disposable projects and remains manual.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), the [validation manifest](analysis/validation/manifest.json), and [release gates](docs/STABILITY.md#发布条件). Reports distinguish source hashes, stock versus backported editors, native requests, persisted results and browser execution. Long-run and fault-recovery evidence is still required before a stable-release claim.

## Licensing and release preparation

This project's original code and documentation are licensed under [MIT](LICENSE), attributed to Cocos Creator MCP contributors. Third-party material retains its own terms; see [NOTICE.md](NOTICE.md). The reference snapshot has no standalone LICENSE and restricts commercial use and derivative code. This project's MIT license does not grant rights to that source. Complete provenance and release checks before publishing; extracted editor implementations and reference source must not enter the distribution.
