import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown };

const protocolVersion = '2024-11-05';
const error = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const result = (id: JsonRpcId, value: unknown) => ({ jsonrpc: '2.0', id, result: value });

const tools = [{
  name: 'appweave_health',
  description: 'Return the authenticated AppWeave backend health status.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}];

export type McpContext = { userId: string };
export type McpOptions = {
  authenticate: (request: FastifyRequest) => string;
  health?: (context: McpContext) => unknown | Promise<unknown>;
  path?: string;
};

function validRequest(value: unknown): value is JsonRpcRequest {
  return Boolean(value && typeof value === 'object' && (value as any).jsonrpc === '2.0' && typeof (value as any).method === 'string' && ((value as any).id === undefined || (typeof (value as any).id === 'string' || typeof (value as any).id === 'number' || (value as any).id === null)));
}

export async function dispatchMcp(request: unknown, context: McpContext, health: (context: McpContext) => unknown | Promise<unknown>): Promise<Record<string, unknown> | undefined> {
  if (!validRequest(request)) return error(null, -32600, 'Invalid Request');
  const id = request.id ?? null;
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return undefined;
  if (request.method === 'ping') return result(id, {});
  if (request.method === 'initialize') return result(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'appweave', version: '1.0.0' } });
  if (request.method === 'tools/list') return result(id, { tools });
  if (request.method === 'tools/call') {
    const params = request.params as any;
    if (!params || typeof params.name !== 'string') return error(id, -32602, 'Invalid params');
    if (params.name !== 'appweave_health') return error(id, -32602, `Unknown tool: ${params.name}`);
    const value = await health(context);
    return result(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
  }
  return error(id, -32601, `Method not found: ${request.method}`);
}

export function registerMcpRoutes(app: FastifyInstance, options: McpOptions): void {
  app.post(options.path ?? '/mcp', async (request, reply) => {
    let uid: string;
    try { uid = options.authenticate(request); }
    catch { reply.header('WWW-Authenticate', 'Bearer'); return reply.code(401).send(error(null, -32001, 'Unauthorized')); }
    const response = await dispatchMcp(request.body, { userId: uid }, options.health ?? (context => ({ status: 'ok', userId: context.userId })));
    if (!response) return reply.code(202).send();
    return reply.type('application/json').send(response);
  });
}
