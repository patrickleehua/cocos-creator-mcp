import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BridgeError, COMMANDS, isReadOnlyCommand } from './bridge-client.mjs';

const string = (description) => z.string().min(1).refine((value) => value.trim().length > 0, 'Must not contain only whitespace.').describe(description);
const optionalString = (description) => string(description).optional();
const json = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]));
const object = z.record(json);
const vector = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const treeNode = z.lazy(() => z.object({
  name: string('Node name.'),
  components: z.array(z.object({ type: string('Registered component class ID, for example cc.Label.'),
    properties: object.optional() }).strict()).optional(),
  properties: object.optional(),
  children: z.array(treeNode).optional(),
}).strict());

function requireField(args, fields, context) {
  for (const field of fields) {
    if (args[field] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for ${args.action ?? 'this operation'}.` });
  }
}
function requireEither(args, fields, context) {
  if (!fields.some((field) => args[field] !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [fields[0]], message: `Provide ${fields.join(' or ')}.` });
  }
}

const definitions = [
  { name: 'editor_info', command: 'editor.info', description: 'Read the connected Cocos Creator editor version, project identity, and editor information.', shape: {} },
  { name: 'scene_query', command: 'scene.query', description: 'Read the current scene, its node hierarchy, and scene state without changing it.', shape: {} },
  { name: 'scene_open', command: 'scene.open', destructive: true,
    description: 'Open a scene asset. Save unsaved scene changes before opening another scene.',
    shape: { asset: string('Scene asset UUID or db:// URL.') } },
  { name: 'scene_save', command: 'scene.save', destructive: true,
    description: 'Save the current scene to its existing asset. Writes project files.', shape: {} },
  { name: 'scene_create', command: 'scene.create',
    description: 'Create a scene asset at a db:// URL, optionally with a scene name.',
    shape: { url: string('Destination scene db:// URL.'), name: optionalString('Optional scene name.') } },
  { name: 'scene_history', actions: { undo: 'scene.undo', redo: 'scene.redo' }, destructive: true,
    description: 'Undo or redo one editor scene history operation. Changes the active scene.', shape: {} },
  { name: 'node_query', command: 'node.query',
    description: 'Find scene nodes by UUID, hierarchy path, or name. Omit all selectors to query nodes; use at most one selector.',
    shape: { uuid: optionalString('Node UUID.'), path: optionalString('Scene hierarchy path.'), name: optionalString('Node name.') },
    validate(args, context) {
      if (['uuid', 'path', 'name'].filter((key) => args[key] !== undefined).length > 1) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use at most one of uuid, path, or name.' });
      }
    } },
  { name: 'node_edit', actions: { create: 'node.create', remove: 'node.remove', reparent: 'node.reparent', duplicate: 'node.duplicate' }, destructive: true,
    description: 'Create, remove, reparent, or duplicate a scene node. Existing-node actions require uuid; reparent also requires parent.',
    shape: { uuid: optionalString('Existing node UUID.'), parent: optionalString('Parent node UUID.'), name: optionalString('New node name.'),
      components: z.array(string('Component class ID.')).optional(), position: vector.optional().describe('Local position.'),
      keepWorldTransform: z.boolean().optional().describe('Keep the world transform when reparenting.') },
    validate(args, context) {
      if (args.action !== 'create') requireField(args, ['uuid'], context);
      if (args.action === 'reparent') requireField(args, ['parent'], context);
    } },
  { name: 'component_edit', actions: { catalog: 'component.catalog', list: 'component.list', add: 'component.add', remove: 'component.remove' }, destructive: true,
    description: 'Catalog registered component classes, or list/add/remove components on a node. uuid is required except for catalog. add requires a class ID or registered class name; remove accepts an exact instance UUID.',
    shape: { uuid: optionalString('Owning node UUID; required except for catalog.'), component: optionalString('Registered class ID/name, or catalog search text.'), componentUuid: optionalString('Specific component instance UUID.') },
    validate(args, context) {
      if (args.action !== 'catalog') requireField(args, ['uuid'], context);
      if (args.action === 'add') requireField(args, ['component'], context);
      if (args.action === 'remove') requireEither(args, ['componentUuid', 'component'], context);
    } },
  { name: 'property_set', command: 'property.set', destructive: true,
    description: 'Set a serialized node or component property using a JSON value. componentUuid selects an instance on the specified node.',
    shape: { uuid: string('Owning node UUID.'), path: string('Serialized property path.'), value: json.describe('Required JSON property value, including null.'),
      componentUuid: optionalString('Component instance UUID; omit to edit the node.') },
    validate(args, context) { requireField(args, ['value'], context); } },
  { name: 'asset_query', command: 'asset.query',
    description: 'Search assets or read asset info, metadata, UUID, URL, or filesystem path. Non-search actions require asset.',
    shape: { action: z.enum(['search', 'info', 'meta', 'uuid', 'url', 'path']), asset: optionalString('Asset UUID or db:// URL.'),
      pattern: optionalString('Asset search glob.'), type: optionalString('Asset type filter.'),
      limit: z.number().int().positive().optional().describe('Maximum search results.'), offset: z.number().int().nonnegative().optional().describe('Search result offset.') },
    validate(args, context) { if (args.action !== 'search') requireField(args, ['asset'], context); } },
  { name: 'asset_edit', actions: { create: 'asset.create', save: 'asset.save', import: 'asset.import', move: 'asset.move', copy: 'asset.copy', delete: 'asset.delete', meta: 'asset.meta' }, destructive: true,
    description: 'Create, save, import, move, copy, or delete project assets. create needs url; save needs asset/content; import needs source; move/copy need asset/url; delete needs asset.',
    shape: { asset: optionalString('Source or existing asset UUID/db:// URL.'), url: optionalString('Destination db:// URL.'),
      content: z.string().optional().describe('Text asset content; an empty string is allowed.'), source: optionalString('Filesystem source to import.'),
      overwrite: z.boolean().optional().describe('Explicitly allow overwriting a destination.'), userData: object.optional().describe('Importer userData fields to merge for meta; preserves UUID and importer identity.') },
    validate(args, context) {
      requireField(args, { create: ['url'], save: ['asset', 'content'], import: ['source'], move: ['asset', 'url'], copy: ['asset', 'url'], delete: ['asset'], meta:['asset','userData'] }[args.action], context);
    } },
  { name: 'prefab_manage', actions: { create: 'prefab.create', instantiate: 'prefab.instantiate' },
    description: 'Create a prefab asset from a node (uuid and url), or instantiate a prefab asset (asset or url) under an optional parent.',
    shape: { uuid: optionalString('Source scene node UUID for create.'), url: optionalString('Prefab db:// URL.'), asset: optionalString('Prefab asset UUID or db:// URL.'),
      parent: optionalString('Parent node UUID for instantiate.'), name: optionalString('Instance node name.') },
    validate(args, context) {
      if (args.action === 'create') requireField(args, ['uuid', 'url'], context);
      else requireEither(args, ['asset', 'url'], context);
    } },
  { name: 'ui_build', command: 'ui.build',
    description: 'Create a UI subtree under an optional parent. Each recursive description has name, optional typed components/properties, node properties, and children.',
    shape: { parent: optionalString('Parent scene node UUID.'), tree: z.array(treeNode).min(1).describe('Node descriptions to create in order.') } },
  { name: 'editor_preview', actions: { info: 'preview.info', open: 'preview.open', refresh: 'preview.refresh' }, destructive: true,
    description: 'Read preview information, open the editor preview, or refresh the running preview.', shape: {} },
  { name: 'editor_logs', command: 'editor.logs',
    description: 'Read native editor logs when available, otherwise bridge operation logs. Recognized formats support level, result limit and millisecond timestamp filters; unknown native formats reject filters.',
    shape: { level: z.enum(['all', 'info', 'warn', 'error']).optional(), limit: z.number().int().positive().optional(),
      since: z.union([z.number().finite().nonnegative(), string('Millisecond timestamp as a number or numeric string.')]).optional() } },
  { name: 'project_build', actions: { config: 'build.config', start: 'build.start', status: 'build.status', cancel: 'build.cancel' }, destructive: true,
    description: 'Read build configuration, start a build with options, inspect build status, or cancel a build by taskId. Starting a build writes output files.',
    shape: { options: object.optional().describe('Editor build options for start.'), taskId: optionalString('Build task ID; required for cancel.') },
    validate(args, context) { if (args.action === 'cancel') requireField(args, ['taskId'], context); } },
];
const byName = new Map(definitions.map((definition) => [definition.name, definition]));
const knownCommands = new Set(COMMANDS);

function schemaFor(definition, commands) {
  let shape = definition.shape;
  if (definition.actions) {
    const actions = Object.keys(definition.actions).filter((action) => commands.has(definition.actions[action]));
    if (actions.length === 0) return undefined;
    shape = { action: z.enum(actions).describe('Editor operation; only actions supported by the current session are advertised.'), ...shape };
  } else if (!commands.has(definition.command)) return undefined;
  return z.object(shape).strict();
}

function annotationsFor(definition, commands) {
  const exposed = definition.actions ? Object.values(definition.actions).filter((command) => commands.has(command)) : [definition.command];
  const readOnly = exposed.every(isReadOnlyCommand);
  return { readOnlyHint: readOnly, destructiveHint: !readOnly && Boolean(definition.destructive),
    idempotentHint: readOnly, openWorldHint: false };
}

export function toolError(error) {
  const normalized = error instanceof BridgeError ? error : new BridgeError('INTERNAL_ERROR', 'The MCP tool failed unexpectedly.');
  const payload = { error: { code: normalized.code, message: normalized.message,
    ...(normalized.details === undefined ? {} : { details: normalized.details }) } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

/** Returns a real SDK McpServer. bridge implements health() and call(command,args,{signal}). */
export async function createMcpServer({ bridge } = {}) {
  if (!bridge || typeof bridge.health !== 'function' || typeof bridge.call !== 'function') {
    throw new BridgeError('INVALID_ARGUMENT', 'createMcpServer requires a bridge with health() and call().');
  }
  const server = new McpServer({ name: 'cocos-creator-mcp', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
  let signature;
  const registered = new Map();
  // Initialize McpServer's tool routes before replacing them with the public
  // low-level hooks below. The temporary registration is never visible on a
  // connected transport, including when the initial capability set is empty.
  server.registerTool('editor_info', { inputSchema: z.object({}).strict() },
    async (args, extra) => execute('editor_info', args, extra)).remove();

  async function refresh(signal) {
    const health = await bridge.health({ signal });
    if (!health || health.ok !== true || !Array.isArray(health.capabilities?.commands)
      || !health.capabilities.commands.every((command) => typeof command === 'string' && command.length > 0)) {
      throw new BridgeError('INVALID_HEALTH', 'The editor bridge did not return a valid command capability list.');
    }
    const commands = new Set(health.capabilities.commands.filter((command) => knownCommands.has(command)));
    const nextSignature = JSON.stringify([...commands].sort());
    const tools = definitions.flatMap((definition) => {
      const schema = schemaFor(definition, commands);
      return schema ? [{ definition, schema, annotations: annotationsFor(definition, commands) }] : [];
    });
    if (signature !== nextSignature) {
      for (const tool of registered.values()) tool.remove();
      registered.clear();
      for (const { definition, schema, annotations } of tools) {
        registered.set(definition.name, server.registerTool(definition.name,
          { description: definition.description, inputSchema: schema, annotations },
          async (args, extra) => execute(definition.name, args, extra)));
      }
      signature = nextSignature;
    }
    return { commands, tools };
  }

  async function execute(name, args, extra = {}) {
    try {
      const definition = byName.get(name);
      if (!definition) throw new BridgeError('UNKNOWN_TOOL', 'Unknown MCP tool.', { tool: name });
      // Validate against the complete allowlist first, so unsupported actions and
      // malformed input are distinguished and neither can reach the bridge RPC.
      let schema = schemaFor(definition, knownCommands);
      if (definition.validate) schema = schema.superRefine(definition.validate);
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new BridgeError('INVALID_ARGUMENT', 'Invalid tool arguments.', {
          issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
        });
      }
      const input = parsed.data;
      const command = definition.actions ? definition.actions[input.action] : definition.command;
      const { commands } = await refresh(extra.signal);
      if (!commands.has(command)) throw new BridgeError('UNSUPPORTED_COMMAND', 'This editor session does not support the requested command.', { command });
      const forwarded = { ...input };
      if (definition.actions) delete forwarded.action;
      const result = await bridge.call(command, forwarded, { signal: extra.signal });
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], structuredContent: { result: result ?? null } };
    } catch (error) { return toolError(error); }
  }

  await refresh();
  // Use the SDK's documented low-level hook to keep tool failures structured,
  // including validation/unknown-tool errors, before the default handler wraps
  // them as unstructured text. Listing also refreshes after editor restarts.
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.task) return toolError(new BridgeError('INVALID_ARGUMENT', 'MCP task-augmented calls are not supported.'));
    return execute(request.params.name, request.params.arguments, extra);
  });
  server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    try {
      const { tools } = await refresh(extra.signal);
      return { tools: tools.map(({ definition, schema, annotations }) => ({ name: definition.name,
        description: definition.description,
        // This is the same converter used by McpServer 1.32.1 for Zod 3 schemas.
        inputSchema: toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' }), annotations })) };
    } catch (error) {
      const result = toolError(error);
      throw new McpError(ErrorCode.InternalError, result.content[0].text, result.structuredContent);
    }
  });
  return server;
}
