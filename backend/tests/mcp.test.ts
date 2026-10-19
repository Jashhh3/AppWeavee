import { describe, expect, it } from 'vitest';
import { dispatchMcp } from '../src/mcp.js';

const health = async ({ userId }: { userId: string }) => ({ status: 'ok', userId });

describe('MCP JSON-RPC connector', () => {
  it('returns the MCP initialization and tool-list shapes', async () => {
    const init = await dispatchMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { userId: 'u1' }, health);
    expect(init).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } });
    const list = await dispatchMcp({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }, { userId: 'u1' }, health);
    expect(list).toMatchObject({ result: { tools: [{ name: 'appweave_health', inputSchema: { type: 'object' } }] } });
  });

  it('dispatches an authenticated tool call and reports protocol errors safely', async () => {
    await expect(dispatchMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'appweave_health' } }, { userId: 'user-1' }, health)).resolves.toMatchObject({ result: { isError: false, structuredContent: { userId: 'user-1' } } });
    await expect(dispatchMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing' } }, { userId: 'user-1' }, health)).resolves.toMatchObject({ error: { code: -32602 } });
    await expect(dispatchMcp({ jsonrpc: '2.0', id: 4, method: 'unknown' }, { userId: 'user-1' }, health)).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it('accepts JSON-RPC notifications without producing a response body', async () => {
    await expect(dispatchMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, { userId: 'user-1' }, health)).resolves.toBeUndefined();
  });
});
