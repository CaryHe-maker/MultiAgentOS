import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
  InMemoryDefinitionSource,
  buildCatalogIndex,
} from '@multiagentos/agent-tool-pool';
import type { BoundaryContext, Definition, DefinitionLookup } from '@multiagentos/contracts';
import { FakeCatalogPort } from '../fakes/fake-catalog-port.js';
import { describeCatalogPortContract } from './catalog-port-contract.js';

/** The entry agent of the shipped catalog; it declares a handoff, so pinning covers it. */
const SHIPPED_AGENT = { id: 'planner', version: 'v0.1.0' } as const;

/** The shipped catalog is the shared fixture for both implementations. */
const snapshot = await new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY).load();

/** Plain JSON copies, so the fake never shares objects with the real loader. */
function shippedDefinitions(): Definition[] {
  const result = buildCatalogIndex(snapshot);
  if (!result.ok) throw new Error('shipped catalog is invalid');
  return JSON.parse(JSON.stringify([...result.index.definitions.values()])) as Definition[];
}

function statusDocument(revoked: readonly DefinitionLookup[]) {
  return {
    origin: 'status.yaml',
    content: {
      schemaVersion: 'v0',
      entries: revoked.map((lookup) => ({ ...lookup, status: 'REVOKED', reason: 'contract test' })),
    },
  };
}

describeCatalogPortContract('DefinitionCatalog', {
  agent: SHIPPED_AGENT,
  create: async (revoked = []) =>
    await DefinitionCatalog.load(
      new InMemoryDefinitionSource(snapshot.documents, statusDocument(revoked)),
    ),
});

describeCatalogPortContract('FakeCatalogPort', {
  agent: SHIPPED_AGENT,
  create: (revoked = []) => Promise.resolve(new FakeCatalogPort(shippedDefinitions(), revoked)),
});

describe('FakeCatalogPort parity', () => {
  it('pins exactly what the real catalog pins', async () => {
    const context: BoundaryContext = {
      correlationId: 'cor_parity',
      tenantId: 'local',
      projectId: 'contract',
    };
    const real = await DefinitionCatalog.load(new InMemoryDefinitionSource(snapshot.documents));
    const fake = new FakeCatalogPort(shippedDefinitions());
    expect(await fake.pinAgent(SHIPPED_AGENT, context)).toEqual(
      await real.pinAgent(SHIPPED_AGENT, context),
    );
  });
});
