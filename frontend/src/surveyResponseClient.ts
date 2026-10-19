export type SurveyAnswers = Record<string, unknown>;
export type SurveyResponsePayload = { surveyId?: string; answers: SurveyAnswers; consent: true };
export type SurveyResponse = SurveyResponsePayload & { id: string; projectId: string; createdAt: string };
export type SurveyResponseClientConfig = { projectId: string; /** Absolute URL or template containing {projectId}. */ endpoint?: string; fetch?: typeof globalThis.fetch };
export class SurveyResponseError extends Error {
  code?: string; requestId?: string; status?: number;
  constructor(message: string, details: { code?: string; requestId?: string; status?: number } = {}) { super(message); this.name = 'SurveyResponseError'; Object.assign(this, details); }
}
const apiOrigin = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000').replace(/\/$/, '');
const configuredEndpoint = import.meta.env.VITE_SURVEY_RESPONSE_URL as string | undefined;
export function surveyResponseEndpoint(projectId: string, endpoint = configuredEndpoint): string {
  if (!projectId.trim()) throw new SurveyResponseError('A project ID is required to submit a survey response.', { code: 'INVALID_PROJECT_ID' });
  if (endpoint) return endpoint.replace('{projectId}', encodeURIComponent(projectId));
  return `${apiOrigin}/api/v1/projects/${encodeURIComponent(projectId)}/survey-responses`;
}
export async function submitSurveyResponse(config: SurveyResponseClientConfig, payload: SurveyResponsePayload): Promise<SurveyResponse> {
  if (!payload || typeof payload.answers !== 'object' || payload.answers === null || Array.isArray(payload.answers)) throw new SurveyResponseError('Survey answers must be an object.', { code: 'INVALID_ANSWERS' });
  if (payload.consent !== true) throw new SurveyResponseError('Consent is required before submitting a survey response.', { code: 'CONSENT_REQUIRED' });
  const response = await (config.fetch ?? globalThis.fetch)(surveyResponseEndpoint(config.projectId, config.endpoint), { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const detail = body?.error ?? body; throw new SurveyResponseError(detail?.message ?? 'Survey response submission failed.', { code: detail?.code, requestId: detail?.requestId ?? body?.requestId, status: response.status }); }
  return body as SurveyResponse;
}
