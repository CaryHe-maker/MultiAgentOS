import { createM1ProtocolRegistry, type BoundaryContextV1 } from '@multiagentos/contracts';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalogV1,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import { describe, expect, it } from 'vitest';
import { pinnedAgentOf } from '@multiagentos/kernel';

const context: BoundaryContextV1 = { correlationId: 'cor_test0001', tenantId: 'l', projectId: 'l' };

async function pinned(id: string) {
  const catalog = await DefinitionCatalogV1.load(
    new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
  );
  const set = catalog.pinAgent({ id, version: 'v0.1.0' }, context);
  if (!set.ok) throw new Error(set.error.message);
  return set.value;
}

describe('pinnedAgentOf', () => {
  it('turns the registered effort into the provider request', async () => {
    const set = await pinned('main');
    const registry = createM1ProtocolRegistry();
    expect(pinnedAgentOf(set, 'high', registry)).toMatchObject({
      modelScope: { kind: 'MODEL', thinking: 'ENABLED', thinkingEffort: 'high' },
      maxToolUnits: 200,
    });
    expect(pinnedAgentOf(set, 'none', registry)).toMatchObject({
      modelScope: { thinking: 'DISABLED' },
    });
  });

  it('refuses an effort the Agent does not allow', async () => {
    expect(pinnedAgentOf(await pinned('planner'), 'high', createM1ProtocolRegistry())).toBe(
      'FORBIDDEN',
    );
  });

  it('offers only the end tools allowed in a final call', async () => {
    const agent = pinnedAgentOf(await pinned('planner'), 'none', createM1ProtocolRegistry());
    if (agent === 'FORBIDDEN') throw new Error('forbidden');
    expect(agent.toolSpecs(false).map((spec) => spec.name)).toEqual([
      'finish_analysis',
      'handoff_to_code_viewer',
    ]);
    expect(agent.toolSpecs(true).map((spec) => spec.name)).toEqual(['finish_analysis']);
  });
});
