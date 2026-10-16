# 操作语义与故障处理

本文补充 [README](../README.md) 的操作契约。完整参数以当前 MCP 工具 schema 为准。

## 常见错误与处理

| 错误 / 状态 | 处理 |
| --- | --- |
| `DISCOVERY_NOT_FOUND` / `BRIDGE_UNAVAILABLE` | 确认工程路径、扩展已启用、Creator 已重启，等待资源数据库就绪；使用 Show status 检查桥接。 |
| `PROJECT_MISMATCH` / `SESSION_MISMATCH` / `SESSION_CHANGED` | 核对配置与编辑器工程身份，重新连接后先查询。不要复制其他工程的 session 文件。 |
| `UNSUPPORTED_COMMAND` | 该会话没有开放此命令；检查精确版本和原生消息清单，不要绕过能力检测。 |
| `UNSAVED_CHANGES` | 保存当前场景后再切换、预览或构建。 |
| `BUILD_BUSY` / `NATIVE_BUILD_BUSY` | 本扩展或原生 builder 有进行中任务；先查状态，等待终态。 |
| `NATIVE_TASK_NOT_IDENTIFIED` | 无法唯一确认取消目标，人工核对原生队列；不要取消其他任务。 |
| `TIMEOUT` / `CANCELLED` / `outcome:unknown` | 已派发写入可能仍运行。先只读查询现场和构建状态，确认后再决定下一步。 |
| `details.partial` / `atomic:false` | 复合操作可能部分完成，使用返回的对象身份核对并恢复。 |

安装错误见[安装与恢复](STABILITY.md#安装与更新)。

## 场景、保存与错误处理

打开其他场景前需要先保存当前修改。存在未保存修改时，`scene_open` 返回 `UNSAVED_CHANGES`。**当前适配器不支持丢弃修改**。预览启动和构建启动同样保护未保存的场景。

节点、组件和属性修改会改变编辑器场景状态，需要持久化时调用 `scene_save`。资源创建、导入、保存、删除等操作会直接影响工程资源文件。

适配器对属性、节点结构、组件或资源文件执行相应的读回校验。`verified:true` 表示相应操作的读回已通过；`saved:true` 表示原生场景保存及 dirty 状态检查已完成。预览的 `requested:true` 表示原生请求已发出并返回，构建的 taskId 表示后台作业已建立，均不能当作全部工作流完成。

复合操作可能部分完成。错误中的 `details.partial`、`created`、`createdUuids`、`asset` 或 `identityRemap` 可帮助定位已经发生的修改。`ui_build` 返回 `atomic:false`；发生错误时先查询现场，按返回的对象恢复或继续操作。撤销重做使用编辑器历史记录，复合操作不保证一次撤销即可整体回滚。

转换节点为预制体时，原生编辑器可能替换源节点并改变节点、组件 UUID；使用返回的 `source` 与 `identityRemap.nodes/components` 更新引用。切换或重新打开场景后也应重新查询节点和组件身份，不能继续假定缓存的运行时 UUID 有效。

客户端超时或断连后，已发出的写操作可能仍在执行。错误若标记 `outcome:"unknown"`，应先通过只读查询核对实际状态。MCP 服务不会自动重试 RPC，调用方也不应自动重放结果未知的写操作。

## 资源导入设置与 SpriteFrame

对已导入的图像资源，调用 `asset_edit` 的 `meta` action 可合并 importer 的 `userData`。例如，将工程中已有的图片设置为 SpriteFrame：

```json
{
  "action": "meta",
  "asset": "db://assets/ui/button.png",
  "userData": {
    "type": "sprite-frame"
  }
}
```

该操作保留主资源 UUID 和 importer 身份，保存 metadata、重新导入并读回验证请求的字段；返回前还会等待相应派生子资源完成导入。结果包含 `{asset, meta, verified:true}`，可从 `asset.subAssets` 中取得已导入的 `cc.SpriteFrame` 子资源 UUID，用于 `cc.Sprite.spriteFrame` 等资源引用。主图像与派生 SpriteFrame 的 UUID 是不同的身份。

重新导入期间父资源可能短暂为 `imported:false`。写后验证在有界时间内只读轮询；`invalid` 仍立即失败。等待超时会报告已经保存 metadata 的 `partial:true`，不会再次派发保存或重新导入。

`asset_query` 的 `meta` action 用于读取 metadata；修改导入设置应使用上面的 `asset_edit` action。

## Label 与固定 UI 尺寸

`cc.Label` 的 `overflow = 0`（NONE）会根据文本自动调整 `UITransform.contentSize`，直接设置尺寸可能在后续文本排版时被覆盖。需要固定文本区域时，先将 Label 的 `overflow` 设为 **1**，再设置同一节点上 UITransform 的 `contentSize`。组件实例 UUID 可通过 `component_edit` 的 `list` action 查询。

先调用 `property_set` 设置 Label：

```json
{
  "uuid": "<节点 UUID>",
  "componentUuid": "<Label 组件实例 UUID>",
  "path": "overflow",
  "value": 1
}
```

然后调用 `property_set` 设置 UITransform，并使用返回的读回结果确认尺寸：

```json
{
  "uuid": "<同一节点 UUID>",
  "componentUuid": "<UITransform 组件实例 UUID>",
  "path": "contentSize",
  "value": {
    "width": 240,
    "height": 64
  }
}
```

## 预览

`editor_preview` 的 `info` 查询原生预览 URL，不表示浏览器已经运行。`open` 要求当前场景 ready、已保存且有场景资源 UUID；扩展调用原生 `preview-scene-in-browser(sceneUuid)` 启动浏览器预览，返回包含 `scene=<UUID>` 的 localhost URL 和 `requested:true`。

3.7.1、3.7.2、3.7.3 的 `open` 已通过真实 MCP SDK、HTTP bridge 和原生 callee 验证：等待 1500 毫秒后捕获到原生请求的实际 URL。测试期间临时拦截 `electron.shell.openExternal`，并在 `finally` 中恢复，避免启动外部浏览器。因此，该项证据确认调用链、场景 UUID 和实际请求 URL；页面渲染证据来自上表独立的浏览器运行时验收。对应报告为 [3.7.1](../analysis/validation/preview-open-3.7.1.json)、[3.7.2](../analysis/validation/preview-open-3.7.2.json)、[3.7.3](../analysis/validation/preview-open-3.7.3.json)。

`refresh` 调用原生 `reload-terminal`，仅在 manifest 声明该消息时提供。它确认重载请求已被接受，不额外宣称页面或游戏脚本已完成加载。

## 后台构建

通过 `project_build` 调用以下 action：

| action | 参数示例 | 返回含义 |
| --- | --- | --- |
| `config` | `{"action":"config"}` 或 `{"action":"config","options":{"platform":"web-desktop"}}` | 原生 builder 工程 profile，或所选平台的原生配置。 |
| `start` | `{"action":"start","options":{"platform":"web-desktop"}}` | 立即返回本扩展的 taskId 和当前状态；其余构建选项按工程需要提供。 |
| `status` | `{"action":"status","taskId":"<start 返回的 taskId>"}` | `task` 含状态、原生完成码和错误；`native` 为真实任务队列，`nativeTask` 为可关联的原生任务。 |
| `cancel` | `{"action":"cancel","taskId":"<start 返回的 taskId>"}` | 尝试取消能明确关联到该作业的新增原生任务。 |

构建通过原生 `command-build` 在后台进行，不会占住桥接请求等待数分钟。保存 taskId 后轮询 `status`；只有 `task.state === "succeeded"` 且原生数字返回码为 **36** 才表示成功。**34** 表示构建失败，**32** 表示选项非法；其他值或 Promise 拒绝也按失败记录。

同一进行中作业的相同选项会返回同一个 taskId；不同选项返回 `BUILD_BUSY`。原生构建 Promise 真正结束前一直保持 busy，适配器也会阻止其他编辑写操作。超时、断连或收到 taskId 后不要自动重试 `start`，先查作业与原生队列。

启动前若 builder 已有活动任务，返回 `NATIVE_BUILD_BUSY`，避免覆盖用户正在进行的原生构建的完成回调。这个检查不能锁住编辑器 UI；执行 MCP 构建期间仍须避免手动同时启动另一个构建。同一进程多个场景窗口时也会拒绝启动。

取消会排除启动前已有的用户任务，并核对本作业的原生身份标记。不能唯一确认归属时返回 `NATIVE_TASK_NOT_IDENTIFIED`，不会尝试取消其他任务。`cancelRequested:true` 或 `state:"cancelling"` 只表示原生 break 请求已接受，仍需等待构建完成结果。`options.id` 和 `options.taskId` 保留用于归属跟踪，调用方不可设置。

Creator 3.7.3 已完成真实构建取消的终态验证，验收覆盖实际结束状态，而非仅检查取消请求已受理。

## 日志来源

`editor_logs` 的实际来源由返回的 `scope` 明确说明：

- 原生 `Editor.Logger.query()` 返回已识别的记录数组时，返回 `{scope, source, entries, total, limit, truncated}`，source 为 `Editor.Logger.query`，scope 为 `native Editor.Logger.query entries; normalized timestamp/level, no console interception`。原生 `time` 映射为毫秒 `timestamp`，`type:"log"` 映射为 `level:"info"`，其余 info/warn/error 保持对应级别；保留原有 time、type、process、stack、source 等字段。原生记录没有 source 时，条目 source 标注为 `Editor.Logger.query`。
- 上述数组支持 `level`（all/info/warn/error）、`since`（含边界的非负毫秒时间戳，接受数字或数字字符串）和 `limit`（正整数，默认 100，超过 1000 时截取到 1000）。返回最新的匹配记录，按时间升序排列；`total` 为截取前匹配数量，`truncated` 表示是否截取。不支持日志游标或 ISO 日期字符串。
- 原生查询返回无法识别的格式时，保留 `{scope, native}` 快照，scope 为 `native Editor.Logger.query snapshot; unfiltered native format, no console interception`。此时 `level`、`limit`、`since` 均返回 `UNSUPPORTED_FILTER`，不会悄悄忽略条件或丢弃未知记录。
- 原生查询不可用时，返回 `{scope, entries}`，scope 为 `bridge operations since extension load`。这是扩展加载以来最多 1000 条桥接操作记录，默认返回最近 100 条，可按级别、时间戳和数量筛选；不代表完整的编辑器或构建控制台历史。

首次读取可使用 `editor_logs` 的空参数 `{}`，根据 `scope` 解释结果。原生日志查询不接管全局 console，也不保证包含已被编辑器清理的记录。

## 请求预算与不确定结果

`scene_save` 在请求原生保存前，要求资源数据库就绪，且当前根 UUID 对应 `db://assets/` 下已导入的 `cc.SceneAsset`。临时场景、已删除资产、内部只读资源和 Prefab 编辑上下文会被拒绝，避免把保存请求送进需要人工选择路径的流程；需要新场景时先使用 `scene_create`，再打开它。场景已经 clean 时复核当前身份和 dirty 状态，返回 `saved:true, unchanged:true`，不重复调用原生保存；它不表示本次又写入了一次磁盘。

节点和场景操作遇到场景进程短暂未就绪时，在派发修改前最多等待五秒，仅重复只读的 readiness 检查；仍未就绪则返回 `SCENE_NOT_READY`。这不会重新执行已派发的节点创建、属性修改或保存。

`ui_build` 限制为整棵描述最多 500 个节点、深度最多 20。它按原生操作逐步执行，大批次可能超过默认 15 秒调用预算。优先拆小批；确需长调用时提高服务的 `--timeout`，并按所用 MCP 客户端的说明调整其调用超时。收到未知结果时仍应先读回，不能整批重复创建。

| 保护 | 当前限制 / 行为 |
| --- | --- |
| 单次 RPC 请求 | UTF-8 JSON 最多 2 MiB；外部客户端在发送前检查。 |
| 排队 | 最多 256 个请求；已接受、尚未完成的请求载荷合计最多 16 MiB。超出时返回 `QUEUE_FULL`。 |
| 单次结果 | JSON 最多 8 MiB，超出返回 `RESPONSE_TOO_LARGE`。先用资源分页、具体 UUID 和日志 limit 缩小查询。 |
| 去重缓存 | 已完成结果合计最多 16 MiB，且受 256 个请求和 60 秒期限约束；可以更早淘汰已完成结果。 |
| 排队过期 | 服务把本次调用的绝对截止时间传给桥接；轮到派发时已过期则返回 `REQUEST_EXPIRED`、`outcome:"not_applied"`，不调用原生接口。 |
| 已派发调用 | 客户端超时、取消或断连不会提前释放原生操作的串行位置，也不会自动重放写入。 |

原生修改前的已知拒绝与修改后的失败不同。适配器尚未请求原生修改时，写入错误带 `outcome:"not_applied"`；请求过原生修改后发生异常、读回失败，或结果无法序列化 / 过大，则按 `outcome:"unknown"` 处理，并保留 `partial`、UUID 等已有诊断。`unknown` 不等于失败前没有改动；先查询节点、资源或构建状态，再决定下一步。

去重缓存不是持久事务日志，也不提供跨编辑器重启或缓存淘汰后的 exactly-once 保证。外部服务每次新调用使用新请求 ID，从不自动重试写入。

`node_edit.create`、`prefab_manage.instantiate` 和 `ui_build` 的顶层创建在省略 `parent` 时，明确使用当前场景根节点。需要其他父节点时传其 UUID。原生 3.7 的隐式父节点在重复创建 / 删除中曾返回不在场景内的 UUID；本扩展不依赖该状态。无法唯一确认场景根节点时返回 `SCENE_IDENTITY_UNAVAILABLE`。
