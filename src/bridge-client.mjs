import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_TIMEOUT = 15_000;
export const MAX_TIMEOUT = 2_147_483_647;

// This allowlist is independent of discovery: a compromised/stale capability
// document must not turn the bridge into an arbitrary editor command proxy.
export const COMMANDS = Object.freeze([
  'editor.info', 'scene.query', 'scene.open', 'scene.save', 'scene.create',
  'scene.undo', 'scene.redo', 'node.query', 'node.create', 'node.remove',
  'node.reparent', 'node.duplicate', 'component.list', 'component.catalog', 'component.add',
  'component.remove', 'property.set', 'asset.query', 'asset.create',
  'asset.save', 'asset.import', 'asset.move', 'asset.copy', 'asset.delete', 'asset.meta',
  'prefab.create', 'prefab.instantiate', 'ui.build', 'preview.info',
  'preview.open', 'preview.refresh', 'editor.logs', 'build.config',
  'build.start', 'build.status', 'build.cancel',
]);
const knownCommands = new Set(COMMANDS);
const readOnlyCommands = new Set([
  'editor.info', 'scene.query', 'node.query', 'component.list', 'component.catalog', 'asset.query',
  'preview.info', 'editor.logs', 'build.config', 'build.status',
]);
export const isReadOnlyCommand = (command) => readOnlyCommands.has(command);

export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const normalizedPath = (value) => process.platform === 'win32'
  ? path.normalize(value).toLowerCase() : path.normalize(value);

function validProject(project) {
  return record(project) && text(project.path) && path.isAbsolute(project.path)
    && text(project.uuid) && text(project.name);
}

function validDiscovery(session) {
  return record(session) && session.protocolVersion === 1 && session.host === '127.0.0.1'
    && Number.isInteger(session.port) && session.port >= 1 && session.port <= 65535
    && text(session.token) && !/[\r\n]/u.test(session.token) && text(session.sessionId)
    && text(session.editorVersion) && validProject(session.project)
    && Number.isSafeInteger(session.pid) && session.pid > 0;
}

function sameDiscovery(left, right) {
  return validDiscovery(right) && left.protocolVersion === right.protocolVersion
    && left.host === right.host && left.port === right.port && left.token === right.token
    && left.sessionId === right.sessionId && left.pid === right.pid
    && left.editorVersion === right.editorVersion && left.project.uuid === right.project.uuid
    && left.project.name === right.project.name
    && normalizedPath(left.project.path) === normalizedPath(right.project.path);
}

/** One fresh discovery + authenticated health check precedes every RPC. No RPC is retried. */
export class BridgeClient {
  constructor({ project, projectPath = project, timeout = DEFAULT_TIMEOUT, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!text(projectPath) || !path.isAbsolute(projectPath)) {
      throw new BridgeError('INVALID_ARGUMENT', 'project must be an absolute project directory.');
    }
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) {
      throw new BridgeError('INVALID_ARGUMENT', `timeout must be an integer from 1 to ${MAX_TIMEOUT} milliseconds.`);
    }
    if (typeof fetchImpl !== 'function') throw new BridgeError('INVALID_ARGUMENT', 'A fetch implementation is required.');
    this.project = path.resolve(projectPath);
    this.sessionFile = path.join(this.project, 'temp', 'cocos-creator-mcp', 'session.json');
    this.timeout = timeout;
    this.fetch = fetchImpl;
  }

  async #operation(signal, command, run) {
    const controller = new AbortController();
    const context = { signal: controller.signal, command, stage: 'discovery', dispatched: false,
      deadline: Date.now() + this.timeout };
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeout);
    try {
      controller.signal.throwIfAborted();
      return await run(context);
    } catch (error) {
      const outcome = context.dispatched && !isReadOnlyCommand(command) ? 'unknown' : 'not_applied';
      if (controller.signal.aborted) {
        throw new BridgeError(timedOut ? 'TIMEOUT' : 'CANCELLED',
          `${timedOut ? 'Bridge request timed out' : 'Bridge request cancelled'}${outcome === 'unknown' ? '; outcome unknown. Do not automatically retry this write.' : '.'}`,
          { stage: context.stage, ...(command && { command }), outcome, retryable: false });
      }
      if (error instanceof BridgeError) {
        if (outcome === 'unknown' && context.stage === 'rpc' && error.details?.outcome === undefined) {
          error.details = { ...error.details, outcome, retryable: false };
        }
        throw error;
      }
      throw new BridgeError('BRIDGE_UNAVAILABLE',
        `Cannot contact the editor bridge${outcome === 'unknown' ? '; outcome unknown. Do not automatically retry this write.' : '.'}`,
        { stage: context.stage, ...(command && { command }), outcome, retryable: false });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async #readDiscovery(context) {
    context.stage = 'discovery';
    let raw;
    try {
      raw = await readFile(this.sessionFile, { encoding: 'utf8', signal: context.signal });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new BridgeError(error.code === 'ENOENT' ? 'DISCOVERY_NOT_FOUND' : 'DISCOVERY_UNREADABLE',
        'Cannot read the project bridge session file.', { sessionFile: this.sessionFile });
    }
    let session;
    try { session = JSON.parse(raw); } catch {
      throw new BridgeError('INVALID_DISCOVERY', 'The project bridge session file is not valid JSON.');
    }
    if (!validDiscovery(session)) throw new BridgeError('INVALID_DISCOVERY', 'The project bridge session file has an invalid identity or endpoint.');
    return session;
  }

  async #sameProject(actual) {
    try {
      const [expectedPath, actualPath] = await Promise.all([realpath(this.project), realpath(actual)]);
      return normalizedPath(expectedPath) === normalizedPath(actualPath);
    } catch {
      return false;
    }
  }

  async #json(session, endpoint, context, body) {
    context.signal.throwIfAborted();
    const response = await this.fetch(`http://127.0.0.1:${session.port}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${session.token}`, accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body }),
      redirect: 'error', signal: context.signal,
    });
    let json;
    try { json = await response.json(); } catch (error) {
      if (context.signal.aborted) throw error;
      if (response.ok) throw new BridgeError('INVALID_RESPONSE', 'The editor bridge returned an invalid JSON response.', { stage: context.stage, status: response.status });
    }
    if (!response.ok) {
      // Session/capability rejections can use HTTP 409/403 with a correlated RPC
      // error envelope. Preserve that code instead of hiding it as an HTTP error.
      if (context.stage === 'rpc' && record(json) && json.id === context.requestId && json.ok === false
        && record(json.error) && text(json.error.code) && text(json.error.message)) return json;
      throw new BridgeError(response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'BRIDGE_HTTP_ERROR',
        'The editor bridge rejected the HTTP request.', { stage: context.stage, status: response.status });
    }
    return json;
  }

  async #discoverAndCheck(context) {
    const session = await this.#readDiscovery(context);
    if (!await this.#sameProject(session.project.path)) {
      throw new BridgeError('PROJECT_MISMATCH', 'Discovery belongs to a different or inaccessible project.');
    }
    context.stage = 'health';
    const health = await this.#json(session, '/health', context);
    if (!record(health) || health.ok !== true || health.protocolVersion !== 1
      || !text(health.sessionId) || !text(health.editorVersion) || !validProject(health.project)
      || !record(health.capabilities) || !Array.isArray(health.capabilities.commands)
      || !health.capabilities.commands.every(text)) {
      throw new BridgeError('INVALID_HEALTH', 'The editor bridge did not confirm a valid health identity and command list.');
    }
    if (health.sessionId !== session.sessionId || health.editorVersion !== session.editorVersion) {
      throw new BridgeError('SESSION_MISMATCH', 'The editor bridge session no longer matches discovery. Read discovery again on the next call.');
    }
    if (health.project.uuid !== session.project.uuid || health.project.name !== session.project.name
      || !await this.#sameProject(health.project.path)) {
      throw new BridgeError('PROJECT_MISMATCH', 'The editor bridge health belongs to a different project.');
    }
    // An editor restart during health must not send a write using stale credentials.
    const latest = await this.#readDiscovery(context);
    if (!sameDiscovery(session, latest)) {
      throw new BridgeError('SESSION_CHANGED', 'The editor bridge session changed during health verification. Call again to reconnect.');
    }
    return { session, health };
  }

  async health({ signal } = {}) {
    return this.#operation(signal, undefined, async (context) => (await this.#discoverAndCheck(context)).health);
  }

  async getHealth(options) { return this.health(options); }

  async call(command, args = {}, { signal } = {}) {
    if (!knownCommands.has(command)) throw new BridgeError('UNKNOWN_COMMAND', 'Unknown editor bridge command.', { command });
    if (!record(args)) throw new BridgeError('INVALID_ARGUMENT', 'RPC args must be an object.');
    // Serialize before dispatch so a bad payload can never have an uncertain outcome.
    let serializedArgs;
    try {
      serializedArgs = JSON.stringify(args);
      if (!record(JSON.parse(serializedArgs))) throw new Error('args must remain an object');
    } catch {
      throw new BridgeError('INVALID_ARGUMENT', 'RPC args must be JSON serializable.');
    }
    return this.#operation(signal, command, async (context) => {
      const { session, health } = await this.#discoverAndCheck(context);
      if (!health.capabilities.commands.includes(command)) {
        throw new BridgeError('UNSUPPORTED_COMMAND', 'This editor session does not support the requested command.', { command });
      }
      const id = randomUUID();
      context.requestId = id;
      const body = JSON.stringify({ id, sessionId: session.sessionId, command, args: JSON.parse(serializedArgs), deadline: context.deadline });
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
        throw new BridgeError('PAYLOAD_TOO_LARGE', 'RPC payload exceeds 2 MiB.', { outcome: 'not_applied', retryable: false });
      }
      context.stage = 'rpc';
      context.signal.throwIfAborted();
      context.dispatched = true;
      const response = await this.#json(session, '/rpc', context, body);
      if (!record(response) || response.id !== id || typeof response.ok !== 'boolean'
        || (response.ok && !Object.hasOwn(response, 'result'))
        || (!response.ok && (!record(response.error) || !text(response.error.code) || !text(response.error.message)))) {
        throw new BridgeError('INVALID_RESPONSE', 'The editor bridge returned an invalid or mismatched RPC envelope.');
      }
      if (!response.ok) {
        context.dispatched = false; // The adapter supplied an authoritative error envelope.
        if (!isReadOnlyCommand(command) && /TIMEOUT|TIMED_OUT/iu.test(response.error.code)
          && response.error.details?.outcome === undefined) {
          const details = record(response.error.details) ? response.error.details
            : response.error.details === undefined ? {} : { adapterDetails: response.error.details };
          throw new BridgeError(response.error.code, `${response.error.message} Write outcome unknown. Do not automatically retry.`,
            { ...details, outcome: 'unknown', retryable: false });
        }
        throw new BridgeError(response.error.code, response.error.message, response.error.details);
      }
      return response.result;
    });
  }
}
