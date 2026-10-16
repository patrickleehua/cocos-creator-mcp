# 与 cocos-mcp-server 1.5.4 的源码能力对照

对照快照：**2026-10-17（Asia/Singapore）**。工具目录和本项目文件哈希记录的是本轮读取时状态；归档报告与后续回归进度分开标注，不把新的执行状态倒写为旧快照的证据。

本项目集中在 Creator 3.7 的工程自动化：创建和修改场景、组件与资源、保留有类型引用、生成 UI 子树，以及原生预览和后台构建。参考项目的公开目录更广，包含剪贴板、属性重置、Prefab 编辑态、场景视图、参考图和偏好设置；这些工作流本项目尚未全部提供。**目前不能称为参考项目的完整替代品。**

对照固定为 [DaxianLee/cocos-mcp-server @ a5db895b3299dccd78979ca0268193e4b6ebf037](https://github.com/DaxianLee/cocos-mcp-server/tree/a5db895b3299dccd78979ca0268193e4b6ebf037)，package **1.5.4**，声明 `editor >=3.8.6`。已核对本地 HEAD、origin 和干净工作树；**未运行参考项目**。下文“参考有”仅表示这个提交有可达的源码分派路径，不表示已在 3.8.6 或其他版本运行成功，不包含 README 宣传数或 Pro 功能。

许可必须与功能分开看：参考仓库没有独立 LICENSE 文件，[README 的许可段](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/README.md#L522)明确限制本项目代码及衍生代码的商用、转售。不能把源码公开推定为 MIT、通用开放源代码授权或可转授权；来源审计要求见文末。

## 先看用户工作流

| 你要完成的任务 | 参考提交的实际源码路径 | 本项目当前覆盖与差距 |
| --- | --- | --- |
| 创建场景、搭节点、修改文字和资源、保存再打开 | scene / node / component / asset 工具均有分派路径 | 核心闭环已有分版本报告；Scene 采用安装模板，属性按实际 dump 写入并读回。接口和字段不是原工具的直接兼容层。 |
| 做能重复使用的复杂 UI / Prefab | 有原生创建路径、实例操作及 enter/save/exit/test 编辑态；另有手写文件回退 | 已验证脚本、多实例组件、Node/Component/Node[]、SpriteFrame 和 Button 事件的转换与重开保真；尚缺 apply/revert/unlink 与完整 Prefab 编辑态。 |
| 在编辑器中精细搭建和整理 | 有 clipboard、reset、数组元素操作、gizmo、相机、参考图工作流 | 有复制/换父、属性和有类型数组写入，缺剪贴板、原生 reset/数组移动、视图和参考图控制；不能全归因于 3.7 API 缺失。 |
| 批量导入和整理资源、查依赖、导出清单 | 有批量 import/delete、依赖查询、manifest、生成可用 URL；源码的 manifest 不生成 CSV/XML 文件 | 单资源 CRUD/import/meta 已实现；批量汇总、独立 reimport/refresh、URL 分配和专用导出缺失。依赖查询另受已检查安装包的注册差异影响。 |
| 启动预览、产出构建、取消自己的任务 | `project_manage.run/build` 实际只打开 builder 面板 | 有真实 preview 请求、URL、刷新，以及原生构建 start/status/cancel。3.7.3 有完整 Web 构建及浏览器执行证据；不是“打开面板即构建成功”。 |
| 查日志和性能、观察编辑器事件 | 项目日志文件 read/search/info；Console 捕获未接入，广播 on/off 被注释；性能查询有不可用回退 | 读取原生 Logger 快照并过滤，必要时明确回退桥接日志；没有历史日志文件搜索、性能采样或广播订阅工具。 |
| 管理全局/本地偏好与备份 | 有 preferences 读取、修改、重置、搜索、导出和备份校验 | 仅 builder 配置可查；通用偏好与备份没有公开实现。 |
| 让客户端可靠地区分失败、工程和重连 | 扩展内自制 HTTP JSON-RPC；源码处理 initialize/tools/list/tools/call | 外部 Node + 官方 SDK stdio，薄桥校验工程和会话；未知写入结果不自动重试。仍无分组撤销、跨资源原子回滚或长期稳定性保证。 |

这张表按用户意图比较，不把“可由多次调用组合”说成已有同等便利接口，也不以工具数量给稳定性打分。

## 计数口径与可复核清单

[reference-capabilities.json](../analysis/reference-capabilities.json) 保存完整目录、每个 selector 分支、固定提交链接、源码 SHA-256、别名、逐操作映射和复核脚本。脚本只读取和解析常量定义，不导入、编译或执行参考扩展。

- 参考 `initializeTools()` 注册 **13 类**；从各类 `getTools()` 得到 **50 个公开工具**。名称实际按 `category + '_' + localName` 组装，例如 `scene_scene_management`、`sceneView_scene_view_camera_control`。参见 [类别注册](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/mcp-server.ts#L44)、[名称与目录生成](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/mcp-server.ts#L104)。
- 将工具的 `action` 或 `operation` 枚举展开，无 selector 的工具记一次，共 **159 个操作入口**。这不是 159 个独立原生 API 或独立用户能力；例如 import/delete 出现在不止一组工具里。
- `component_configure_click_event` 使用 `operation`，不是 `action`；不把 propertyType、format、component category 等参数枚举误算成工具操作。
- `ComponentTools.execute` 另接受 **5 个未列出的兼容别名**：`component_add_component`、`component_remove_component`、`component_get_components`、`component_get_component_info`、`component_get_available_components`。它们单列在 JSON，不加进 50/159。[dispatcher](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L174)
- 已注释的 `asset_optimize/compress_textures`、unused/validate_refs 分支，以及商业版本描述均不计入；“代码里出现过名字”不是公开工具。[被注释的目录项](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L113)、[实际 dispatcher](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L269)
- 本项目是 **17 个 MCP 工具、36 个桥接命令**。`asset.query` 在一个命令下还有 6 个查询 selector；按相同的有限入口规则可数为 **41 个工具操作入口**。它仍不能与参考的 159 直接换算成覆盖比例。

| 参考类别 | 公开工具数 | 展开操作入口数 |
| --- | --- | --- |
| `scene` | 5 | 23 |
| `node` | 8 | 21 |
| `component` | 4 | 10 |
| `prefab` | 4 | 13 |
| `project` | 2 | 7 |
| `debug` | 3 | 7 |
| `preferences` | 3 | 9 |
| `server` | 2 | 6 |
| `broadcast` | 2 | 5 |
| `sceneView` | 5 | 20 |
| `referenceImage` | 4 | 12 |
| `assetAdvanced` | 5 | 23 |
| `validation` | 3 | 3 |
| **合计** | **50** | **159** |

复核提取结果（需要 Node，修改最后的参考仓库路径即可）：

```powershell
$inventory = Get-Content -Raw analysis/reference-capabilities.json | ConvertFrom-Json
$inventory.reproduction.extractorJavaScript | node - 'D:/workplace/cocos-mcp-server'
```

提取器重算原始目录及分派信息；JSON 中的语义映射、风险说明和路线优先级属于人工审阅结果，不能由计数脚本自动证明。

## 完整参考目录与语义映射

“有对应”只表示用户意图有实现路径；“部分/组合”表示参数、返回形态、便利层或流程不同；“未实现”不表示 3.7 无能力；“范围取舍”主要指固定白名单、CLI 或协议层职责；“本机注册缺失”仅限下一节给出的静态安装包证据。**所有参考分支的运行状态都是未执行。**

每行给出真实 wire 名及固定提交的定义／handler 一基行号。JSON 进一步把每个 action 映射到本项目命令和本地实现行号。

| 参考工具（定义 · 分派） | 实际 selector / 操作 | 本项目语义映射与缺口 |
| --- | --- | --- |
| [scene_scene_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L8) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L718) | action: `get_current` / `get_list` / `open` / `save` / `create` / `save_as` / `close` | 有对应、部分/组合、未实现。场景身份、列表、打开、保存、创建已有对应；另存为和关闭缺失。 对应 `scene_query` / `asset_query` / `scene_open` / `scene_save` / `scene_create`。 |
| [scene_scene_hierarchy](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L44) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L447) | 直接调用（无 action/operation） | 有对应。层级和 dump 查询已有对应。 对应 `scene_query` / `node_query`。 |
| [scene_scene_execution_control](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L60) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L741) | action: `execute_component_method` / `execute_scene_script` / `restore_prefab` | 范围取舍、未实现。不开放通用脚本/组件方法代理；Prefab restore 工作流缺失。 |
| [scene_scene_state_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L104) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L756) | action: `create_snapshot` / `abort_snapshot` / `begin_undo` / `end_undo` / `cancel_undo` / `soft_reload` | 部分/组合、未实现、本机注册缺失。内部 snapshot 与单步 undo/redo 已有；公开录制事务不支持。 对应 `property_set`。 |
| [scene_scene_query_system](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L130) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-tools.ts#L777) | action: `check_ready` / `check_dirty` / `list_classes` / `list_components` / `check_script` / `find_nodes_by_asset` | 有对应、部分/组合、未实现。ready/dirty、注册类与组件列表部分对应；脚本检查和按资源反查节点缺失。 对应 `scene_query` / `component_edit`。 |
| [node_node_query](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L13) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L403) | action: `info` / `find` / `find_by_name` / `list_all` / `detect_type` / `tree` | 有对应、部分/组合。节点 UUID/路径/精确名称与层级可查；模糊匹配、类型诊断便利层较少。 对应 `node_query`。 |
| [node_node_lifecycle](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L54) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L442) | action: `create` / `delete` | 有对应。创建/删除原生节点。 对应 `node_edit`。 |
| [node_node_transform](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L139) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L463) | 直接调用（无 action/operation） | 部分/组合。通过 property_set 操作实际节点 dump；不是上游多属性便利接口。 对应 `property_set` / `node_edit`。 |
| [node_node_hierarchy](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L202) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L470) | action: `move` / `duplicate` | 有对应。换父节点和复制已有对应。 对应 `node_edit`。 |
| [node_node_clipboard](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L243) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L491) | action: `copy` / `paste` / `cut` | 未实现。没有编辑器剪贴板 copy/paste/cut 工作流；duplicate 不等于 clipboard。 |
| [node_node_property_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L276) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L506) | action: `reset_property` / `reset_transform` / `reset_component` | 未实现。reset_property/reset_transform/reset_component 均未提供。 |
| [node_node_array_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L303) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L521) | action: `move_element` / `remove_element` | 部分/组合。支持有类型数组整体写入，缺少 move/remove-element 专用入口。 对应 `property_set`。 |
| [node_node_script_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L341) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/node-tools.ts#L1792) | action: `attach` / `remove` | 部分/组合。资产编译后可按注册类添加/删除脚本实例；没有按路径一键挂脚本。 对应 `asset_edit` / `component_edit`。 |
| [component_component_manage](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L7) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L201) | action: `add` / `remove` | 有对应。组件增删；本项目支持精确实例选择。 对应 `component_edit`。 |
| [component_component_query](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L31) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L214) | action: `list` / `info` / `available_types` | 有对应、部分/组合。实例信息和目录已有对应；注册类目录与上游硬编码类型列表语义不同。 对应 `component_edit` / `node_query`。 |
| [component_set_component_property](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L60) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L672) | 直接调用（无 action/operation） | 部分/组合。单属性写入和有类型引用已实现；批量便利接口不同。 对应 `property_set`。 |
| [component_configure_click_event](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L132) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L2059) | operation: `add` / `modify` / `remove` / `clear` | 部分/组合。Button EventHandler 数组可写，未提供四个专用按钮事件 action。 对应 `property_set`。 |
| [prefab_prefab_browse](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L9) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L922) | action: `list` / `info` / `validate` | 部分/组合、未实现。资源搜索/详情可查；独立文件结构校验器缺失。 对应 `asset_query`。 |
| [prefab_prefab_lifecycle](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L35) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L948) | action: `create` / `delete` | 有对应、部分/组合。原生创建，以及通过 asset_edit 删除。 对应 `prefab_manage` / `asset_edit`。 |
| [prefab_prefab_instance](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L68) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L995) | action: `instantiate` / `unlink` / `apply` / `revert` | 有对应、未实现。仅实例化已有公开工具；unlink/apply/revert 尚未实现。 对应 `prefab_manage`。 |
| [prefab_prefab_edit](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L102) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L1057) | action: `enter` / `save` / `exit` / `test` | 未实现、部分/组合。没有完整的 enter/save/exit/test Prefab 编辑态流程。 对应 `prefab_manage` / `scene_save` / `scene_open`。 |
| [project_project_manage](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/project-tools.ts#L7) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/project-tools.ts#L76) | action: `run` / `build` / `get_info` / `get_settings` | 部分/组合。项目身份、真实预览及构建作业已有；通用工程配置较少。 对应 `editor_preview` / `project_build` / `editor_info`。 |
| [project_project_build_system](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/project-tools.ts#L47) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/project-tools.ts#L93) | action: `get_build_settings` / `open_build_panel` / `check_builder_status` | 部分/组合、范围取舍。原生后台作业/配置可查；不提供打开构建面板的 GUI 工具。 对应 `project_build`。 |
| [debug_debug_console](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/debug-tools.ts#L33) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/debug-tools.ts#L145) | action: `get_logs` / `clear` | 部分/组合、未实现。日志来源不同；没有清空编辑器 Console 工具。 对应 `editor_logs`。 |
| [debug_debug_logs](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/debug-tools.ts#L61) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/debug-tools.ts#L158) | action: `read` / `search` / `info` | 部分/组合、未实现。仅部分日志读取对应；没有历史日志文件搜索/文件信息工具。 对应 `editor_logs`。 |
| [debug_debug_system](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/debug-tools.ts#L113) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/debug-tools.ts#L173) | action: `editor_info` / `performance` | 部分/组合、未实现。版本/项目身份部分覆盖；性能采样缺失。 对应 `editor_info`。 |
| [preferences_preferences_manage](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/preferences-tools.ts#L7) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/preferences-tools.ts#L144) | action: `open_panel` / `get_config` / `set_config` / `reset_config` | 未实现。偏好设置打开/读取/写入/重置均未公开。 |
| [preferences_preferences_query](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/preferences-tools.ts#L48) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/preferences-tools.ts#L161) | action: `get_all` / `list_categories` / `search_settings` | 未实现。偏好类别聚合/搜索未实现。 |
| [preferences_preferences_backup](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/preferences-tools.ts#L88) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/preferences-tools.ts#L176) | action: `export` / `validate_backup` | 未实现。偏好导出/备份校验未实现。 |
| [server_server_information](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/server-tools.ts#L8) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/server-tools.ts#L222) | action: `get_ip_list` / `get_sorted_ip_list` / `get_port` / `get_comprehensive_status` | 未实现、部分/组合。工程会话健康检查不是编辑器内置 HTTP 服务网络诊断的完整替代。 对应 `editor_preview` / `editor_info`。 |
| [server_server_connectivity](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/server-tools.ts#L25) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/server-tools.ts#L239) | action: `test_connectivity` / `get_network_interfaces` | 部分/组合、未实现。连接校验部分覆盖；没有通用网卡枚举。 对应 `editor_info`。 |
| [broadcast_broadcast_log_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/broadcast-tools.ts#L15) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/broadcast-tools.ts#L230) | action: `get_log` / `clear_log` | 未实现。没有编辑器广播日志工具；editor_logs 不是广播订阅。 |
| [broadcast_broadcast_listener_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/broadcast-tools.ts#L44) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/broadcast-tools.ts#L243) | action: `start_listening` / `stop_listening` / `get_active_listeners` | 未实现。没有公开动态广播订阅管理。 |
| [sceneView_scene_view_gizmo_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L7) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L139) | action: `change_tool` / `query_tool` / `change_pivot` / `query_pivot` / `change_coordinate` / `query_coordinate` / `query_view_mode` | 未实现。场景视图工具尚未接入；不能统称为 3.7 不支持。 |
| [sceneView_scene_view_mode_control](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L37) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L171) | action: `change_2d_3d` / `query_2d_3d` / `set_grid` / `query_grid` | 未实现。场景视图工具尚未接入；不能统称为 3.7 不支持。 |
| [sceneView_scene_view_icon_gizmo](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L60) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L194) | action: `set_3d_mode` / `query_3d_mode` / `set_size` / `query_size` | 未实现。场景视图工具尚未接入；不能统称为 3.7 不支持。 |
| [sceneView_scene_view_camera_control](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L85) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L217) | action: `focus_on_nodes` / `align_camera_with_view` / `align_view_with_node` | 未实现。场景视图工具尚未接入；不能统称为 3.7 不支持。 |
| [sceneView_scene_view_status_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L105) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/scene-view-tools.ts#L232) | action: `get_status` / `reset_view` | 未实现。场景视图工具尚未接入；不能统称为 3.7 不支持。 |
| [referenceImage_reference_image_management](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/reference-image-tools.ts#L8) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/reference-image-tools.ts#L439) | action: `add` / `remove` / `switch` / `clear_all` | 未实现。参考图工作流尚未实现。 |
| [referenceImage_reference_image_query](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/reference-image-tools.ts#L46) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/reference-image-tools.ts#L456) | action: `get_config` / `get_current` / `list_all` | 未实现。参考图工作流尚未实现。 |
| [referenceImage_reference_image_transform](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/reference-image-tools.ts#L63) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/reference-image-tools.ts#L471) | action: `set_position` / `set_scale` / `set_opacity` / `set_data` | 未实现。参考图工作流尚未实现。 |
| [referenceImage_reference_image_display](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/reference-image-tools.ts#L118) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/reference-image-tools.ts#L488) | action: `refresh` | 未实现。参考图工作流尚未实现。 |
| [assetAdvanced_asset_manage](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L9) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L287) | action: `import` / `delete` / `save_meta` / `generate_url` | 部分/组合、未实现。单资源 CRUD/meta 覆盖，批处理便利层及自动 URL 分配不全。 对应 `asset_edit`。 |
| [assetAdvanced_asset_analyze](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L62) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L304) | action: `dependencies` / `manifest` | 本机注册缺失、部分/组合。依赖图与导出清单尚不完整。 对应 `asset_query`。 |
| [assetAdvanced_asset_system](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L129) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L335) | action: `check_ready` / `open_external` / `refresh` | 部分/组合、未实现。DB ready 为内部前置检查；外部打开和通用 refresh 未暴露。 对应 `asset_query`。 |
| [assetAdvanced_asset_query](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L152) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L350) | action: `get_info` / `get_assets` / `find_by_name` / `get_details` / `query_path` / `query_uuid` / `query_url` | 有对应、部分/组合。查询、资源元信息与 URL/UUID/path 解析大体覆盖。 对应 `asset_query`。 |
| [assetAdvanced_asset_operations](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L220) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L373) | action: `create` / `copy` / `move` / `delete` / `save` / `reimport` / `import` | 有对应、部分/组合。单资源操作覆盖；独立 reimport 缺失。 对应 `asset_edit`。 |
| [validation_validate_json_params](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/validation-tools.ts#L9) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/validation-tools.ts#L74) | 直接调用（无 action/operation） | 范围取舍。协议/JSON 校验由 SDK、Schema 与客户端处理，没有额外 Creator 工具。 |
| [validation_safe_string_value](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/validation-tools.ts#L27) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/validation-tools.ts#L130) | 直接调用（无 action/operation） | 范围取舍。协议/JSON 校验由 SDK、Schema 与客户端处理，没有额外 Creator 工具。 |
| [validation_format_mcp_request](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/validation-tools.ts#L41) · [分派](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/validation-tools.ts#L143) | 直接调用（无 action/operation） | 范围取舍。协议/JSON 校验由 SDK、Schema 与客户端处理，没有额外 Creator 工具。 |

本项目没有承诺实现全部参考目录。批量/快捷工具的减少既有范围收敛，也有实际功能缺口，不能全部包装为“合并后等价”。

## 本项目 17 工具 / 36 命令的反向对照

本地证据为 [MCP 工具定义](../src/tools.mjs#L31)、[固定命令白名单](../src/bridge-client.mjs#L10)及 JSON 内的 `commandEvidence`。工具 action 随会话实际能力过滤；目录为空也不允许调用隐藏命令。

| 本项目工具（源码） | 桥接命令 | 参考公开目录中的语义对应 |
| --- | --- | --- |
| [editor_info](../src/tools.mjs#L32) | `editor.info` | `project_project_manage` / `debug_debug_system` / `server_server_information` / `server_server_connectivity` |
| [scene_query](../src/tools.mjs#L33) | `scene.query` | `scene_scene_management` / `scene_scene_hierarchy` / `scene_scene_query_system` |
| [scene_open](../src/tools.mjs#L34) | `scene.open` | `scene_scene_management` / `prefab_prefab_edit` |
| [scene_save](../src/tools.mjs#L37) | `scene.save` | `scene_scene_management` / `prefab_prefab_edit` |
| [scene_create](../src/tools.mjs#L39) | `scene.create` | `scene_scene_management` |
| [scene_history](../src/tools.mjs#L42) | `scene.undo` / `scene.redo` | 参考公开目录无直接 undo/redo action；不要把 begin/end recording 当作 undo/redo。 |
| [node_query](../src/tools.mjs#L44) | `node.query` | `scene_scene_hierarchy` / `node_node_query` / `component_component_query` |
| [node_edit](../src/tools.mjs#L52) | `node.create` / `node.remove` / `node.reparent` / `node.duplicate` | `node_node_lifecycle` / `node_node_transform` / `node_node_hierarchy` |
| [component_edit](../src/tools.mjs#L61) | `component.catalog` / `component.list` / `component.add` / `component.remove` | `scene_scene_query_system` / `node_node_script_management` / `component_component_manage` / `component_component_query` |
| [property_set](../src/tools.mjs#L69) | `property.set` | `scene_scene_state_management` / `node_node_transform` / `node_node_array_management` / `component_set_component_property` / `component_configure_click_event` |
| [asset_query](../src/tools.mjs#L74) | `asset.query` | `scene_scene_management` / `prefab_prefab_browse` / `assetAdvanced_asset_analyze` / `assetAdvanced_asset_system` / `assetAdvanced_asset_query` |
| [asset_edit](../src/tools.mjs#L80) | `asset.create` / `asset.save` / `asset.import` / `asset.move` / `asset.copy` / `asset.delete` / `asset.meta` | `node_node_script_management` / `prefab_prefab_lifecycle` / `assetAdvanced_asset_manage` / `assetAdvanced_asset_operations` |
| [prefab_manage](../src/tools.mjs#L88) | `prefab.create` / `prefab.instantiate` | `prefab_prefab_lifecycle` / `prefab_prefab_instance` / `prefab_prefab_edit` |
| [ui_build](../src/tools.mjs#L96) | `ui.build` | 组合 node / component / property 路径；参考没有同名批量树构建工具。 |
| [editor_preview](../src/tools.mjs#L99) | `preview.info` / `preview.open` / `preview.refresh` | `project_project_manage` / `server_server_information` |
| [editor_logs](../src/tools.mjs#L101) | `editor.logs` | `debug_debug_console` / `debug_debug_logs` |
| [project_build](../src/tools.mjs#L105) | `build.config` / `build.start` / `build.status` / `build.cancel` | `project_project_manage` / `project_project_build_system` |

`scene_history` 的单步 undo/redo、`ui_build` 的递归 UI 构建、后台构建作业和 importer userData 合并，是本项目显式提供的工作流；不据此推定参考项目不能用其他方式组合完成相同用户目标。`ui_build` 明确 `atomic:false`，不是原子事务。

## 哪些是版本差异，哪些是产品缺口

补充检查覆盖了实际用于验收的五个 3.7 安装包。以下为 [native-api-matrix.json](../analysis/native-api-matrix.json) 中相应模块 `package.json` 的**消息声明**，每个 manifest 单独记录 SHA-256：

| 原生消息 | 3.7.0 | 3.7.1 | 3.7.2 | 本机 3.7.3 | 3.7.4 | 本机 3.8.7 |
| --- | --- | --- | --- | --- | --- | --- |
| scene `begin/end/cancel-recording` | 无 | 无 | 无 | 无 | 无 | 有 |
| scene `snapshot/undo/redo` | 有 | 有 | 有 | 有 | 有 | 有 |
| asset-db `query-asset-dependencies` / `query-asset-users` | 无 | 无 | 无 | 无 | 无 | 有 |
| project `query-project-data` | 有 | 有 | 有 | 有 | 有 | 无 |
| project `query-project-configs` / `set-config` | 无 | 无 | 无 | 无 | 无 | 有 |

这些结果只描述所检查的发行包。消息名存在不证明签名相同、运行可用或首发版本；某路由缺失也不等于相关需求无法通过其他 API 实现。3.7.3 保留本机 backport 限制，3.8.7 未运行本项目或参考项目。

证据来自 [creator-3.7.3-vs-3.8.7.json](../analysis/creator-3.7.3-vs-3.8.7.json) 的 `before.moduleMessages` 和 `after.moduleMessages`；可复核键在能力 JSON 的 `versionApiEvidence.lookups`。这是**本机含 backport 的 3.7.3 与指定本机 3.8.7 安装包**的静态对照，不是官方所有 3.7.x 的总表，也不是参考项目在 3.8.6 的实测。

| 功能/消息 | 本机 3.7.3 → 本机 3.8.7 注册证据 | 该如何分类 |
| --- | --- | --- |
| `begin-recording/end-recording/cancel-recording` | 无 → 有 | 不能原样移植参考录制调用。本项目 `groupedUndo:false`；缺失结论不能扩展到每个 3.7 补丁/定制包。 |
| `query-asset-dependencies`、`query-asset-users` | 无 → 有 | 原生依赖图通道存在版本适配限制；公开参考工具是 dependencies，users 仅作为注册差异，不额外计数。未来扫描器应声明覆盖范围。 |
| `snapshot/undo/redo` | 有 → 有 | 不是 3.7 不支持撤销；本项目已验收单次属性 undo/redo，缺的是分组/复合事务保证。 |
| clipboard、reset、数组元素、focus-camera、gizmo | 多项对应消息在两个注册表均存在 | 本项目尚未接工具或尚未验收，不能用版本差异解释。完整签名/返回值仍须真机核验。 |
| `unlink-prefab/apply-prefab/restore-prefab` | 有 → 有 | 高优先级的未实现工作流；原生创建/实例化通过不代表这些高级编辑动作已通过。 |
| `generate-available-url/refresh-asset/reimport-asset` | 有 → 有 | 缺独立公开动作。当前 meta 路径内部 reimport 不等于通用 reimport 工具。 |
| project 配置消息 | 旧 `query-project-data` 有 → 无；`query-project-configs/set-config` 无 → 有 | 配置需要版本适配，不能假定同一路由；也不能据此声称所有 preferences API 均不存在。 |
| reference-image、preferences 模块 | 原静态消息对照没有完整盘点这两类模块 | API 可用性未知；本项目未实现是已知事实，版本缺失是未经证明的推断。 |
| MCP 传输与通用 JSON 辅助工具 | 协议/应用架构选择 | stdio、白名单、SDK 校验不由 Creator 3.7/3.8 版本决定。 |

“3.8.7 里有”也不能证明某 API 在 3.8.6 首次提供。若要扩大版本结论，需要对应发行包注册表、签名核对及运行报告三者，而不是读取 `editor >=3.8.6` 就推断。

## 源码实现边界与稳定性证据

以下是针对固定参考提交的静态观察，不是其商业版本或实际会话的稳定性结论：

| 源码事实 | 对选择和迁移的影响 |
| --- | --- |
| [协议 handler](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/mcp-server.ts#L244)只列 initialize/tools/list/tools/call，固定协议版本；工具失败对象作为文本内容返回 | 不能把它直接视作已验证的完整 SDK 生命周期/传输实现。本文不宣称所有客户端都无法使用它。 |
| [工具开关](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/mcp-server.ts#L104)过滤目录，而 [executeToolCall](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/mcp-server.ts#L138)按类别直接分派；空启用列表走全量目录 | 禁用/能力策略与执行入口应统一；不能只看 tools/list 就判断可调用范围。 |
| [run/build](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/project-tools.ts#L109)只打开 builder 面板 | 参考源码的 action 名称不证明已经开始运行或产生构建产物；本项目与之对比的是用户意图，不是完全相同实现。 |
| [广播监听注册](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/broadcast-tools.ts#L119)被注释；[Console capture 初始化](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/debug-tools.ts#L15)只有日志 | 这两个路径不作为已工作的实时监听能力；参考 debug_logs 文件读取路径应另行看待，不能说其全部日志能力都是模拟。 |
| [属性读回后返回](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/component-tools.ts#L1338)即使 changeVerified=false 仍 success=true | 请求完成、读回一致和保存完成需要分开判定；本项目 property.set 在读回不一致时返回错误。 |
| [Prefab 创建](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L657)先尝试原生路径，失败后可能手写对象图；[Button/Label 默认值分支](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L2335)清空事件并重置部分属性 | 不能把手写回退称为保真原生序列化，也不能据此说其所有 Prefab 路径都是模拟。本项目限定原生路径，并有命名夹具的引用保真报告。 |
| [撤销 helper](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L765)为空；[实例化录制](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/prefab-tools.ts#L802)未使用 begin 返回 ID，结束 ID 自行拼造 | 是需复核的静态实现问题；不等于本文已运行并观察到具体编辑器历史记录损坏。 |
| [manifest](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/source/tools/asset-advanced-tools.ts#L590)返回对象，format 只进字段，includeMetadata 固定 false | 不能据 schema 的 json/csv/xml 枚举宣称已生成三种格式的导出文件。 |

本项目的运行证据与上述静态观察不是同一实验，**不能据此得出“比参考更稳定”的运行排名**。当前 [validation manifest](../analysis/validation/manifest.json) 与逐版本原始报告记录：

| Creator | 安装身份 | 核心 | 复杂引用 | extras |
| --- | --- | --- | --- | --- |
| 3.7.0 | 官方 Windows 便携 ZIP | [13/13](../analysis/validation/integration-3.7.0.json) | [7/7](../analysis/validation/reference-3.7.0.json) | [3/3](../analysis/validation/extras-3.7.0.json) |
| 3.7.1 | 官方 Windows 便携 ZIP | [13/13](../analysis/validation/integration-3.7.1.json) | [7/7](../analysis/validation/reference-3.7.1.json) | [4/4](../analysis/validation/extras-3.7.1.json) |
| 3.7.2 | 官方 Windows 便携 ZIP | [13/13](../analysis/validation/integration-3.7.2.json) | [7/7](../analysis/validation/reference-3.7.2.json) | [4/4](../analysis/validation/extras-3.7.2.json) |
| 3.7.3 | 本机安装，含 repack/backport | [13/13](../analysis/validation/integration-3.7.3.json) | [7/7](../analysis/validation/reference-3.7.3.json) | [4/4](../analysis/validation/extras-3.7.3.json) |
| 3.7.4 | 官方 Windows 便携 ZIP | [13/13](../analysis/validation/integration-3.7.4.json) | [7/7](../analysis/validation/reference-3.7.4.json) | [3/3](../analysis/validation/extras-3.7.4.json) |

因此本次读取的基线归档已覆盖官方 3.7.1／3.7.2，不能继续沿用较早调查中“这两个版本未执行”的状态。基线 manifest 的 completedAt 为 `2026-10-16T15:56:32.231Z`，其中的 311/311 单元/契约测试与真机步骤分开计数。原生完整 Web 构建及浏览器执行记录见 [build-3.7.3.json](../analysis/validation/build-3.7.3.json)、[build-runtime-3.7.3.json](../analysis/validation/build-runtime-3.7.3.json)；这只覆盖所记录安装与目标，不推出移动端/小游戏平台或 macOS/Linux 已通过。

<!-- latest-validation-status: update separately from the historical comparison snapshot -->
**后续验收结果（2026-10-17）：** 当前源码完整测试 **420/420 通过**；五版本顺序原生回归各 **13/13 + 7/7 + 4/4**，含真实构建取消。3.7.3 完整 Web 构建码 36、产物运行和 20 次 SDK 重连通过。报告与实现哈希见[最新清单](../analysis/validation/manifest.json)，旧基线单独保留。该结果仍不等于长期稳定或全平台验收。

**审阅初期的快照差异：** 当时归档 manifest 后已有源码/测试变化，路径为 `extensions/cocos-creator-mcp/adapter.js`、`extensions/cocos-creator-mcp/extras.js`、`extensions/cocos-creator-mcp/main.js`、`scripts/install-extension.mjs`、`tests/adapter-native-contract.test.cjs`、`tests/extras.test.cjs`。JSON 保存本次读到的源码哈希和差异列表。现有成功报告仍然有效地描述其执行快照，但不能替代这些后续变动的重新验收；本轮后续回归已绑定新的实现哈希；JSON 保留原始读取快照，并另外刷新当前命令位置和最终源码清单。

即使流程已有通过报告，也未证明所有数组/事件修改组合、任意 Prefab 覆盖图、全部失败恢复或长时间运行都通过。本项目明确保留单窗口、无 grouped undo、无跨 scene/asset 原子事务等边界；未覆盖和未实现是不同状态。

## 按用户旅程排序的补齐路线

以下是建议优先级，不是已排期或已经实现的功能承诺。

| 优先级 | 用户旅程与工作 | 可以对外宣称完成前的验收 |
| --- | --- | --- |
| P0 | **公开发布的来源与证据可审计**：逐文件溯源、许可决定、当前源码重新验收；写超时/断连/重启与部分失败状态 | 保存准确提交、实现哈希与原始报告；失败路径不伪成功、不盲重放；不将未审计参考代码纳入默认授权声明。 |
| P1 | **完成可复用 UI / Prefab 的整个编辑循环**：原生 apply/revert/unlink、进入/保存/退出编辑态 | 嵌套 Prefab、覆盖项、同类组件、Button 事件、外部资源及场景重开都保真；明确 UUID 映射、失败后的资产/场景状态和历史粒度。 |
| P1 | **日常编辑不卡在缺口上**：clipboard、原生 reset、数组元素移动/删除及相机聚焦 | 先核对已有 3.7 消息签名；读回父子/索引、引用和保存结果；验证单步 undo/redo，而不是假设整个批操作可一次回滚。 |
| P2 | **美术/设计工作流**：场景视图、gizmo、参考图 | 逐版本探测真实模块和消息，明确与编辑器 UI/窗口的关系，断开或切换场景后不污染其他工程状态。 |
| P2 | **规模化资源整理**：批量导入/删除汇总、独立 reimport/refresh、URL 分配、真正的清单导出 | 每项结果可追踪、失败项可重跑而不重复已完成写入；若标 CSV/XML 则确实生成对应格式；依赖扫描明确盲区，不把 unknown 说成 unused。 |
| P3 | **偏好/调试便利层**：偏好读取/备份/显式修改、历史日志搜索、性能采样 | 分清项目与全局作用域、敏感数据、历史文件与实时快照；不可用时明确返回，不合成性能数或虚构事件流。 |

通用脚本执行、任意组件方法代理和 JSON 格式工具不必为了“工具数追平”而加入。是否扩大接口，应由需要的用户旅程、可控的修改范围和可验证结果决定。

## 许可、架构借鉴与代码来源

[参考许可段](https://github.com/DaxianLee/cocos-mcp-server/blob/a5db895b3299dccd78979ca0268193e4b6ebf037/README.md#L520)写明允许学习交流、二次开发优化，同时声明：

> 任何本项目代码或者衍生代码均不能用于任何商用、转售，如果需要商用，请联系本人。

检查该固定提交没有独立 LICENSE 文件，package.json 也没有 license 字段。本文不把它标为 MIT，也不推定其满足一般开放源代码许可条件。**功能对照、架构/API 学习和重新实现目标，均不能自行证明本项目的法律独立性或授予转换许可证的权利。**

公开发布前应保留可审计记录：

1. 为每个参考过的文件/函数记录固定提交链接、用途及决定，区分直接复制、改写和仅研究行为/API 后另行编写；不能只写一句“参考了架构”就视为来源审计完成。
2. 对任何复制或改写片段核对作者许可、适用限制与通知保留要求；需要的商用、再分发或衍生授权应取得明确依据。没有依据时，不得用新增本项目 LICENSE 覆盖上游限制。
3. 检查代码、文案、图片、模板和第三方依赖的实际来源及各自许可；本清单是能力分析元数据，不是参考源码的重新授权或独立性证明。
4. 将实施来源记录、最终许可决定、源码哈希和验收报告分别保存，保持对外说明与实际分发内容一致。

维护者随后选择了 MIT，本项目原创代码与文档的许可见 [LICENSE](../LICENSE)，来源说明见 [NOTICE.md](../NOTICE.md)。此决定不改变上游限制，也不替代逐文件来源核对。
