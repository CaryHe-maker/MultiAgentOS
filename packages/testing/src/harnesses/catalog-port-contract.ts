import { describe, expect, it } from 'vitest';
import {
  CATALOG_ERROR_CODES,
  PinnedDefinitionSetSchema,
  validate,
  type AgentPinRequest,
  type BoundaryContext,
  type CatalogPort,
  type DefinitionLookup,
} from '@multiagentos/contracts';

export interface CatalogPortContractFixture {
  /** Agent that exists in the catalog and whose closure is fully ACTIVE. */
  readonly agent: AgentPinRequest;
  /** Builds the implementation under test, optionally with some versions REVOKED. */
  readonly create: (revoked?: readonly DefinitionLookup[]) => Promise<CatalogPort>;
}

const context: BoundaryContext = {
  correlationId: 'cor_contract',
  tenantId: 'local',
  projectId: 'contract',
};

/**
 * Behaviour every CatalogPort must share (real catalog and fakes alike). Consumers such as
 * Workflow and Kernel rely only on what is asserted here.
 */
export function describeCatalogPortContract(
  name: string,
  fixture: CatalogPortContractFixture,
): void {
  describe(`CatalogPort contract: ${name}`, () => {
    const pin = async (revoked?: readonly DefinitionLookup[]) => {
      const result = await (await fixture.create(revoked)).pinAgent(fixture.agent, context);
      if (!result.ok) throw new Error(`pin failed: ${result.error.code}`);
      return result.value;
    };

    it('pins a closed, sorted, JSON-safe and frozen definition set', async () => {
      const pinned = await pin();
      expect(pinned.agent).toMatchObject(fixture.agent);
      const keys = pinned.refs.map((ref) => `${ref.kind}:${ref.id}@${ref.version}`);
      for (const ref of pinned.agent.unitRefs)
        expect(keys).toContain(`UNIT:${ref.id}@${ref.version}`);
      for (const unit of pinned.units)
        for (const ref of unit.toolRefs) expect(keys).toContain(`TOOL:${ref.id}@${ref.version}`);
      expect(keys).toContain(`MODEL:${pinned.model.id}@${pinned.model.version}`);
      expect(keys).toContain(`PROMPT:${pinned.prompt.id}@${pinned.prompt.version}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(pinned.refs.map((ref) => ref.kind)).toEqual(
        [...pinned.refs.map((ref) => ref.kind)].sort(
          (left, right) =>
            ['AGENT', 'MODEL', 'PROMPT', 'UNIT', 'TOOL'].indexOf(left) -
            ['AGENT', 'MODEL', 'PROMPT', 'UNIT', 'TOOL'].indexOf(right),
        ),
      );
      const roundTripped: unknown = JSON.parse(JSON.stringify(pinned));
      expect(validate(PinnedDefinitionSetSchema, roundTripped)).toEqual({
        ok: true,
        value: pinned,
      });
      expect(Object.isFrozen(pinned)).toBe(true);
      expect(Object.isFrozen(pinned.model.pricing)).toBe(true);
      expect(() => {
        (pinned.refs as unknown as unknown[]).push('mutation');
      }).toThrow(TypeError);
    });

    it('returns equal sets for repeated pins', async () => {
      expect(await pin()).toEqual(await pin());
    });

    it('looks up every pinned member by exact version', async () => {
      const pinned = await pin();
      const catalog = await fixture.create();
      for (const ref of pinned.refs) {
        const result = await catalog.getDefinition(
          { kind: ref.kind, id: ref.id, version: ref.version },
          context,
        );
        expect(result.ok && result.value.digest).toBe(ref.digest);
      }
    });

    it('returns structured, non-retryable errors', async () => {
      const catalog = await fixture.create();
      const cases: readonly [DefinitionLookup, string][] = [
        [{ kind: 'AGENT', id: 'no-such-agent', version: 'v1.0.0' }, 'definitionNotFound'],
        [{ kind: 'AGENT', id: fixture.agent.id, version: 'v99.0.0' }, 'versionNotFound'],
        [{ kind: 'AGENT', id: fixture.agent.id, version: 'latest' }, 'lookupInvalid'],
      ];
      for (const [lookup, code] of cases) {
        const result = await catalog.getDefinition(lookup, context);
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: CATALOG_ERROR_CODES[code as keyof typeof CATALOG_ERROR_CODES],
            retryable: false,
            correlationId: context.correlationId,
          },
        });
      }
    });

    it('refuses to pin when a member is revoked', async () => {
      const pinned = await pin();
      const tool = pinned.refs.find((ref) => ref.kind === 'TOOL') ?? pinned.refs[1];
      if (tool === undefined) throw new Error('fixture agent has no members');
      const catalog = await fixture.create([
        { kind: tool.kind, id: tool.id, version: tool.version },
      ]);
      expect(await catalog.pinAgent(fixture.agent, context)).toMatchObject({
        ok: false,
        error: { code: CATALOG_ERROR_CODES.definitionUnavailable, category: 'POLICY' },
      });
    });

    it('declares run pinning as supported', async () => {
      const capabilities = (await fixture.create()).capabilities();
      expect(capabilities).toContainEqual(
        expect.objectContaining({ capability: 'catalog.run-pinning', status: 'SUPPORTED' }),
      );
    });
  });
}
