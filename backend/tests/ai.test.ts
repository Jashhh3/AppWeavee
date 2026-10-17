import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_PROVIDER_TIMEOUT_MS, HttpAIProvider, resolveAIProviderTimeoutMs } from '../src/ai.js';
import type { AIProviderConfig } from '../src/types.js';

const config: AIProviderConfig = { id: 'id', projectId: 'project', provider: 'openai', baseUrl: 'https://provider.example/v1', model: 'model', keyConfigured: true, keyCiphertext: 'cipher', updatedAt: new Date().toISOString() };
const provider = (fetcher: typeof fetch) => new HttpAIProvider('openai', config, 'secret-key', fetcher);

describe('AI provider error mapping', () => {
  it.each([[404, 'PROVIDER_MODEL_NOT_FOUND', 404], [401, 'PROVIDER_UNAUTHORIZED', 401], [429, 'PROVIDER_RATE_LIMITED', 429]] as const)('maps HTTP %s safely', async (status, code, statusCode) => {
    await expect(provider(async () => new Response(JSON.stringify({ error: { message: 'token=should-not-leak' } }), { status, headers: status === 429 ? { 'retry-after': '30' } : undefined }) as Response).generate('prompt')).rejects.toMatchObject({ code, statusCode });
    await expect(provider(async () => new Response(JSON.stringify({ error: { message: 'token=should-not-leak' } }), { status }) as Response).generate('prompt')).rejects.not.toThrow('should-not-leak');
  });


  it('uses a configured timeout without waiting for it', async () => {
    let signal: AbortSignal | undefined;
    const configured = new HttpAIProvider('openai', config, 'secret-key', async (_url, options) => {
      signal = options?.signal as AbortSignal;
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }, 37);
    await expect(configured.generate('prompt')).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', statusCode: 504 });
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });

  it('maps aborts to a timeout without exposing credentials', async () => {
    const error = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(provider(async () => { throw error; }).generate('prompt')).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', statusCode: 504 });
  });
});


describe('OpenAI-compatible response normalization', () => {
  it('reads content arrays and reasoning fallbacks', async () => {
    const arrayProvider = provider(async () => new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '{\"ok\":true}' }] } }] }), { status: 200 }) as Response);
    await expect(arrayProvider.generate('prompt')).resolves.toMatchObject({ output: '{"ok":true}' });
    const reasoningProvider = provider(async () => new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning: '{\"repaired\":true}' } }] }), { status: 200 }) as Response);
    await expect(reasoningProvider.generate('prompt')).resolves.toMatchObject({ output: '{"repaired":true}' });
  });
});
