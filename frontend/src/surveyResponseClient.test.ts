import { describe, expect, it, vi } from 'vitest';
import { submitSurveyResponse, surveyResponseEndpoint } from './surveyResponseClient';
describe('survey response client', () => {
  it('resolves the configurable endpoint without exposing secrets', () => { expect(surveyResponseEndpoint('project/one', 'https://responses.example/{projectId}')).toBe('https://responses.example/project%2Fone'); });
  it('submits the response and returns the server receipt', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'r1', projectId: 'p1', answers: { age: 32 }, consent: true, createdAt: 'now' }), { status: 201 }));
    const result = await submitSurveyResponse({ projectId: 'p1', endpoint: 'https://responses.example/{projectId}', fetch }, { surveyId: 'nethasethu', answers: { age: 32 }, consent: true });
    expect(result.id).toBe('r1'); expect(fetch).toHaveBeenCalledWith('https://responses.example/p1', expect.objectContaining({ method: 'POST', credentials: 'include' }));
  });
  it('returns a structured error for an unsuccessful submission', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Try again later', requestId: 'req-1' } }), { status: 429 }));
    await expect(submitSurveyResponse({ projectId: 'p1', endpoint: 'https://responses.example', fetch }, { answers: {}, consent: true })).rejects.toMatchObject({ name: 'SurveyResponseError', code: 'RATE_LIMITED', requestId: 'req-1', status: 429 });
  });
});
