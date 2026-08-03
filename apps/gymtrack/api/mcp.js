// apps/gymtrack/api/mcp.js
//
// Vercel serverless handler for POST /api/mcp — the GymTrack Model Context
// Protocol server.
//
// Auth: OAuth 2.1 Bearer access tokens minted by /api/oauth/token. We do NOT
// accept the legacy gymtrack_agent_api_keys here; MCP is OAuth-only by spec.
// (Legacy keys continue to work on /api/agent/* per AC5.)
//
// Protocol: JSON-RPC 2.0 over HTTP. Each request is one JSON-RPC message;
// the body MUST be a JSON object with `jsonrpc: "2.0"`. Notifications
// (requests without an `id`) get a 204 No Content with empty body.
//
// Supported methods:
//   - initialize       — handshake; returns serverInfo + capabilities.
//   - notifications/initialized — no-op; returns 204.
//   - ping             — liveness probe; returns empty result.
//   - tools/list       — returns the three tool definitions.
//   - tools/call       — dispatches a tool; scope-checks first.
//
// Error mapping:
//   - Parse errors      → JSON-RPC -32700.
//   - Invalid request   → -32600 (bad envelope).
//   - Method not found  → -32601.
//   - Invalid params    → -32602.
//   - Internal error    → -32603 (catch-all for unhandled throws).
//   - Tool-level errors → 200 OK with `{ isError: true, content: [...] }`.
//   - Auth failure      → HTTP 401 with WWW-Authenticate (no JSON-RPC envelope).

import {
  adminClient,
  badRequest,
  rejectIfWrongMethod,
  requireOAuthScope,
  resolveOAuthIdentity,
  unauthorized
} from '../server/agentAuth.js';
import {
  findTool,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MCP_TOOLS,
  planWorkoutTool,
  readHistoryTool,
  readExerciseProgressionTool
} from '../server/mcpTools.js';

const JSONRPC_VERSION = '2.0';

/**
 * Parse a JSON-RPC request body. Vercel serverless may or may not pre-parse
 * the body depending on content-type. We accept either a parsed object or
 * a JSON string and return `{ ok, request, error }`.
 */
export function parseJsonRpcBody(rawBody) {
  let body = rawBody;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return { ok: false, error: 'Parse error: invalid JSON.' };
    }
  }
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid Request: body must be a JSON object.' };
  }
  if (body.jsonrpc !== JSONRPC_VERSION) {
    return { ok: false, error: 'Invalid Request: jsonrpc must be "2.0".' };
  }
  if (typeof body.method !== 'string' || body.method.length === 0) {
    return { ok: false, error: 'Invalid Request: method is required.' };
  }
  return { ok: true, request: body };
}

/**
 * Build a JSON-RPC success response envelope.
 */
export function jsonRpcOk(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, result };
}

/**
 * Build a JSON-RPC error response envelope. `id` may be null when the
 * original request had a malformed id; spec allows null in that case.
 */
export function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, error: err };
}

export default async function handler(req, res) {
  if (rejectIfWrongMethod(req, res, ['POST'])) return;

  // Auth happens before JSON parsing so a missing/invalid token never
  // leaks whether the body parses. Per JSON-RPC over HTTP best practice,
  // auth failures are HTTP errors, not JSON-RPC error envelopes.
  let identity;
  try {
    identity = await resolveOAuthIdentity(req);
  } catch (err) {
    return res
      .status(500)
      .json({ error: 'server_error', message: err?.message ?? 'Auth lookup failed.' });
  }
  if (!identity) {
    return unauthorized(res, 'invalid_token', 'gymtrack-mcp');
  }

  const parsed = parseJsonRpcBody(req.body);
  if (!parsed.ok) {
    return res.status(400).json(jsonRpcError(null, -32700, parsed.error));
  }

  const request = parsed.request;

  // Notifications (no id field) — respond 204 and do not emit a JSON-RPC
  // envelope. Per JSON-RPC 2.0 §4.1, a notification has no response.
  if (!('id' in request)) {
    if (request.method === 'notifications/initialized') {
      // The MCP client signals handshake completion. We don't need to do
      // anything — capabilities were already announced in initialize.
      res.status(204).end();
      return;
    }
    // Unknown notification: silently drop. Returning 204 is correct; the
    // client never expects a response.
    res.status(204).end();
    return;
  }

  try {
    const response = await dispatchMethod(request.method, request.params ?? {}, identity, request.id);
    if (response === null) {
      // Shouldn't happen — dispatchMethod always returns an envelope for
      // a request with an id. Defensive: emit an internal error.
      return res.status(500).json(jsonRpcError(request.id, -32603, 'Internal error: no response.'));
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json(response);
  } catch (err) {
    res.status(500).json(
      jsonRpcError(request.id, -32603, 'Internal error.', { detail: err?.message ?? String(err) })
    );
  }
}

/**
 * Dispatch a JSON-RPC method by name. Returns the response envelope
 * (`jsonRpcOk` / `jsonRpcError`) or null for notifications.
 *
 * `identity` is the OAuth identity resolved upstream; we need its scopes
 * to gate tool calls.
 */
async function dispatchMethod(method, params, identity, requestId) {
  if (method === 'initialize') {
    // MCP §"Session lifecycle": the server returns its protocol version,
    // server info, and capabilities. Tools capability advertises the
    // `listChanged: false` shape — we do not push tool updates today.
    return jsonRpcOk(requestId, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: MCP_SERVER_INFO,
      capabilities: {
        tools: { listChanged: false }
      }
    });
  }

  if (method === 'ping') {
    return jsonRpcOk(requestId, {});
  }

  if (method === 'tools/list') {
    // Strip the internal `requiredScopes` field — it is not part of the
    // MCP tool schema. Clients use the inputSchema for argument
    // validation; scopes are a server-side enforcement concern only.
    const tools = MCP_TOOLS.map(({ requiredScopes, ...rest }) => rest);
    return jsonRpcOk(requestId, { tools });
  }

  if (method === 'tools/call') {
    return await dispatchToolCall(params, identity, requestId);
  }

  return jsonRpcError(requestId, -32601, `Method not found: ${method}`);
}

/**
 * Dispatch a `tools/call` request. Enforces scope checks before invoking
 * the tool. Tool-level errors come back as 200 OK with `isError: true` so
 * the client can surface them to the LLM; protocol errors come back as
 * JSON-RPC error envelopes with the appropriate code.
 */
async function dispatchToolCall(params, identity, requestId) {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    return jsonRpcError(requestId, -32602, 'Invalid params: tools/call params must be an object.');
  }
  const { name, arguments: args } = params;
  if (typeof name !== 'string' || name.length === 0) {
    return jsonRpcError(requestId, -32602, 'Invalid params: name is required.');
  }

  const tool = findTool(name);
  if (!tool) {
    return jsonRpcError(requestId, -32602, `Invalid params: unknown tool "${name}".`);
  }

  const scopeErr = requireOAuthScope(identity, tool.requiredScopes);
  if (scopeErr) {
    // Per RFC 6750 §3.1, insufficient_scope → HTTP 403 + WWW-Authenticate
    // listing the required scope. JSON-RPC delivery happens through the
    // 200 OK envelope, but the underlying HTTP semantics still apply.
    return jsonRpcOk(requestId, {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(scopeErr) }]
    });
  }

  const toolArgs = (args == null || typeof args !== 'object') ? {} : args;
  const toolContext = { userId: identity.user_id, clientId: identity.client_id };

  let result;
  try {
    if (name === 'plan_workout') {
      result = await planWorkoutTool({ ...toolContext, args: toolArgs });
    } else if (name === 'read_history') {
      result = await readHistoryTool({ ...toolContext, args: toolArgs });
    } else if (name === 'read_exercise_progression') {
      result = await readExerciseProgressionTool({ ...toolContext, args: toolArgs });
    } else {
      return jsonRpcError(requestId, -32602, `Invalid params: unknown tool "${name}".`);
    }
  } catch (err) {
    // Wrap unexpected throws as JSON-RPC internal error rather than
    // letting them crash the serverless function and leak a stack.
    return jsonRpcError(requestId, -32603, 'Internal error.', { detail: err?.message ?? String(err) });
  }

  return jsonRpcOk(requestId, result);
}