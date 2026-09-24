import { describe, expect, it } from 'vitest';
import { BuiltInCatalog } from './index.js';

describe('FR-ATP-001 FR-ATP-003 built-in catalog', () => {
  const context = { correlationId: 'cor_123456', tenantId: 'local', projectId: 'fixture' };
  it('resolves stable immutable definition versions', async () => {
    const catalog = new BuiltInCatalog();
    const query = {
      kind: 'AGENT' as const,
      definitionId: 'repository-analysis-agent',
      requiredCapabilities: ['single-task', 'read-only-analysis'],
    };
    const first = await catalog.resolve(query, context);
    const second = await catalog.resolve(query, context);
    expect(first).toEqual(second);
    expect(first.ok && first.value.digest).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('does not fake unsupported publication or missing definitions', async () => {
    const catalog = new BuiltInCatalog();
    const result = await catalog.resolve(
      { kind: 'MODEL', definitionId: 'missing', requiredCapabilities: [] },
      context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_CAPABILITY' } });
    expect(catalog.capabilities()).toContainEqual(
      expect.objectContaining({ capability: 'catalog.publish', status: 'UNSUPPORTED' }),
    );
  });
});
