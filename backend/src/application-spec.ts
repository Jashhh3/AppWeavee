import { z } from 'zod';
import type { ApplicationSchema } from './types.js';
const fieldType = z.enum(['string', 'number', 'boolean', 'date', 'enum', 'multi_select']);
const field = z.union([fieldType, z.object({ type: fieldType, required: z.boolean().default(false), options: z.array(z.string()).optional(), description: z.string().max(1000).optional() }).strict()]);
const entity = z.object({ fields: z.record(field), permissions: z.record(z.array(z.enum(['read', 'create', 'update', 'delete']))).optional(), description: z.string().max(2000).optional() }).strict();
const page = z.object({ id: z.string().min(1).max(120), type: z.string().min(1).max(80), route: z.string().min(1).max(200), entity: z.string().optional(), components: z.array(z.string()).default([]) }).strict();
export const applicationSchema = z.object({ entities: z.record(entity).default({}), relationships: z.array(z.record(z.unknown())).default([]), roles: z.array(z.string().trim().min(1)).default(['admin']), permissions: z.record(z.array(z.string())).default({}), api: z.record(z.unknown()).default({}), frontend: z.record(z.unknown()).default({}), pages: z.array(page).default([]), features: z.array(z.string()).default([]) }).strict();
export const applicationSpecEnvelope = z.object({ schema: applicationSchema }).strict();
export type ValidationDiagnostic = { path: string; message: string; code: string };
export type NormalizedSpec = { schema: ApplicationSchema; diagnostics: ValidationDiagnostic[] };
export function normalizeApplicationSpec(input: unknown): NormalizedSpec { const parsed = applicationSpecEnvelope.safeParse(input); if (parsed.success) return { schema: parsed.data.schema as ApplicationSchema, diagnostics: [] }; return { schema: {} as ApplicationSchema, diagnostics: parsed.error.issues.map(issue => ({ path: issue.path.join('.') || '$', message: issue.message, code: issue.code })) }; }
function normalizeCommonShape(value: any): any {
  if (!value || typeof value !== 'object') return value;
  const candidate = value.schema && typeof value.schema === 'object' ? value : { schema: value };
  const schema = candidate.schema;
  if (schema.entities && Array.isArray(schema.entities)) { schema.entities = Object.fromEntries(schema.entities.map((entity: any, index: number) => { const { name, id, ...rest } = entity; return [name || id || `Entity${index + 1}`, rest]; })); }
  if (schema.entities && typeof schema.entities === 'object') for (const entity of Object.values(schema.entities) as any[]) {
    if (entity && Array.isArray(entity.fields)) entity.fields = Object.fromEntries(entity.fields.map((field: any, index: number) => { const { name, id, ...rest } = field; return [name || id || `field${index + 1}`, field.type ? rest : 'string']; }));
  }
  return candidate;
}
export function parseProviderSpec(output: string): NormalizedSpec { let cleaned = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(); const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}'); if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1); try { return normalizeApplicationSpec(normalizeCommonShape(JSON.parse(cleaned))); } catch (error) { return { schema: {} as ApplicationSchema, diagnostics: [{ path: '$', message: error instanceof Error ? error.message : 'Invalid JSON', code: 'invalid_json' }] }; } }
