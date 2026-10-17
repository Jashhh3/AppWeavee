import { describe, expect, it } from 'vitest';
import { normalizeApplicationSpec, parseProviderSpec } from '../src/application-spec.js';

describe('application specification normalization', () => {
  it('normalizes the stable schema and reports no diagnostics', () => {
    const result = normalizeApplicationSpec({ schema: { entities: { Product: { fields: { price: 'number' } } }, relationships: [], roles: ['admin'], api: {}, frontend: {} } });
    expect(result.diagnostics).toEqual([]);
    expect(result.schema.entities.Product.fields.price).toBe('number');
  });

  it('returns structured diagnostics for invalid provider output', () => {
    const result = parseProviderSpec('{"schema":{"entities":{"Product":{"fields":{"price":"money"}}}}}');
    expect(result.diagnostics[0]).toMatchObject({ path: 'schema.entities.Product.fields.price', code: 'invalid_union' });
  });
  it('accepts common bare schemas and form field descriptors', () => {
    const result = parseProviderSpec('```json\n{"entities":[{"name":"RegistrationResponse","fields":[{"name":"location","type":"enum","required":true,"options":["USA","Other"]}]}],"pages":[{"id":"registration","type":"form","route":"/"}],"roles":["admin"]}\n```');
    expect(result.diagnostics).toEqual([]);
    expect(result.schema.entities.RegistrationResponse.fields.location).toMatchObject({ type: 'enum', required: true });
    expect(result.schema.pages[0].route).toBe('/');
  });

});
