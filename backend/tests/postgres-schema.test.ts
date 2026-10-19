import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL persistence schema', () => {
  it('contains durable core records and a migration-safe state document', async () => {
    const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
    for (const table of ['appweave_state', 'users', 'sessions_tokens', 'projects', 'project_settings', 'provider_configs', 'survey_responses', 'audits', 'builds', 'deployments', 'versions']) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
    expect(sql).toContain('state jsonb NOT NULL');
    expect(sql).toContain('answers jsonb NOT NULL');
  });
});
