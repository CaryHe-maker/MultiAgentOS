import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import {
  createM1ProtocolRegistry,
  type BudgetConfig,
  type CatalogPort,
  type PinnedDefinitionSet,
  type ProviderCredentials,
  type SystemConfig,
} from '@multiagentos/contracts';
import { createFakeTerminal } from '@multiagentos/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { composeSystem, type SystemParts } from '../bootstrap/compose-system.js';
import { assertStartupConfig } from './startup-config.js';
import { estimateFixedInputs } from './startup-context.js';
import { ConfigError, defaultSystemConfig } from './system-config.js';

let catalog: CatalogPort;
const registry = createM1ProtocolRegistry();
const credentials: ProviderCredentials = { apiKeyFor: () => 'offline-test-placeholder' };
beforeAll(async () => {
  catalog = await DefinitionCatalog.load(new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY));
});

function withPinned(transform: (pinned: PinnedDefinitionSet) => PinnedDefinitionSet): CatalogPort {
  return {
    getDefinition: catalog.getDefinition.bind(catalog),
    capabilities: () => catalog.capabilities(),
    pinAgent: async (request, context) => {
      const result = await catalog.pinAgent(request, context);
      return result.ok ? { ok: true, value: transform(result.value) } : result;
    },
  };
}

function withBudget(budget: Partial<BudgetConfig>): SystemConfig {
  const config = defaultSystemConfig();
  return {
    ...config,
    kernel: { ...config.kernel, budget: { ...config.kernel.budget, ...budget } },
  };
}

const check = (config = defaultSystemConfig(), source = catalog, keys = credentials) =>
  assertStartupConfig(config, source, registry, keys);

async function viewer(): Promise<PinnedDefinitionSet> {
  const result = await catalog.pinAgent(
    { id: 'code-viewer', version: 'v0.1.0' },
    { correlationId: 'cor_startup', tenantId: 'local', projectId: 'local' },
  );
  if (!result.ok) throw new Error('test Agent missing');
  return result.value;
}

function viewerConfig(budget: Partial<BudgetConfig> = {}): SystemConfig {
  const config = withBudget(budget);
  return {
    ...config,
    workflow: { ...config.workflow, entryAgentRef: { id: 'code-viewer', version: 'v0.1.0' } },
  };
}

describe('startup configuration', () => {
  it('checks both real Agents and reads credentials once without individual definition lookups', async () => {
    const pinAgent = vi.fn(catalog.pinAgent.bind(catalog));
    const getDefinition = vi.fn(() => {
      throw new Error('startup must use pinAgent, not getDefinition');
    });
    const apiKeyFor = vi.fn(() => 'offline-test-placeholder');
    await check(
      defaultSystemConfig(),
      { ...catalog, pinAgent, getDefinition, capabilities: () => [] },
      { apiKeyFor },
    );
    expect(pinAgent.mock.calls.map(([request]) => request.id)).toEqual(['planner', 'code-viewer']);
    expect(getDefinition).not.toHaveBeenCalled();
    expect(apiKeyFor).toHaveBeenCalledExactlyOnceWith('deepseek');
    expect(pinAgent.mock.calls[0]?.[1]).not.toHaveProperty('workflowRunId');
  });

  it('accepts exactly finalReserve + wrapUpMargin, rejects one less and tokenLimit=1', async () => {
    const budget = defaultSystemConfig().kernel.budget;
    const minimum =
      budget.finalInputBudget +
      budget.finalMaxOutputTokens +
      budget.perCallInputLimit +
      budget.maxOutputTokens;
    await expect(check(withBudget({ tokenLimit: minimum }))).resolves.toBeUndefined();
    for (const tokenLimit of [minimum - 1, 1])
      await expect(check(withBudget({ tokenLimit }))).rejects.toThrow(ConfigError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe or non-positive budget %s',
    async (tokenLimit) => {
      await expect(check(withBudget({ tokenLimit }))).rejects.toThrow('positive safe integer');
    },
  );

  it.each([
    'tokenLimit',
    'perCallInputLimit',
    'finalInputBudget',
    'maxOutputTokens',
    'finalMaxOutputTokens',
    'orientBudget',
    'searchBudget',
  ] as const)('checks numeric validity of %s', async (field) => {
    await expect(check(withBudget({ [field]: Number.MAX_SAFE_INTEGER + 1 }))).rejects.toThrow(
      field,
    );
  });

  it.each([
    { finalInputBudget: Number.MAX_SAFE_INTEGER },
    { perCallInputLimit: Number.MAX_SAFE_INTEGER },
    { finalInputBudget: 5_000_000_000_000_000, perCallInputLimit: 5_000_000_000_000_000 },
  ])('rejects overflowing derived sums: %j', async (budget) => {
    await expect(check(withBudget(budget))).rejects.toThrow('safe integer range');
  });

  it.each(['maxOutputTokens', 'finalMaxOutputTokens'] as const)(
    'allows the model output boundary for %s but not one token more',
    async (field) => {
      const source = withPinned((pinned) => ({
        ...pinned,
        model: { ...pinned.model, limits: { ...pinned.model.limits, maxOutputTokens: 8192 } },
      }));
      await expect(check(withBudget({ [field]: 8192 }), source)).resolves.toBeUndefined();
      await expect(check(withBudget({ [field]: 8193 }), source)).rejects.toThrow(field);
    },
  );

  it.each(['ordinary', 'final'] as const)(
    'checks the %s model window independently, allowing equality',
    async (mode) => {
      const config = withBudget(mode === 'final' ? { finalInputBudget: 90_000 } : {});
      const budget = config.kernel.budget;
      const window =
        mode === 'final'
          ? budget.finalInputBudget + budget.finalMaxOutputTokens
          : budget.perCallInputLimit + budget.maxOutputTokens;
      const source = (contextWindowTokens: number) =>
        withPinned((pinned) => ({
          ...pinned,
          model: { ...pinned.model, limits: { ...pinned.model.limits, contextWindowTokens } },
        }));
      await expect(check(config, source(window))).resolves.toBeUndefined();
      await expect(check(config, source(window - 1))).rejects.toThrow(mode + ' input + output');
    },
  );

  it.each(['planner', 'code-viewer'])('rejects a provider mismatch on %s', async (id) => {
    const source = withPinned((pinned) =>
      pinned.agent.id === id
        ? { ...pinned, model: { ...pinned.model, provider: 'other-provider' } }
        : pinned,
    );
    await expect(check(defaultSystemConfig(), source)).rejects.toThrow('Agent ' + id);
  });

  it.each([undefined, '', ' \t\n '])('rejects missing or blank credentials (%j)', async (key) => {
    await expect(check(defaultSystemConfig(), catalog, { apiKeyFor: () => key })).rejects.toThrow(
      'API key is missing for provider deepseek',
    );
  });

  it.each([
    { id: 'missing-agent', version: 'v0.1.0' },
    { id: 'planner', version: 'v99.0.0' },
  ])('rejects an unavailable entry %j', async (entryAgentRef) => {
    const config = defaultSystemConfig();
    await expect(
      check({ ...config, workflow: { ...config.workflow, entryAgentRef } }),
    ).rejects.toThrow(ConfigError);
  });

  it('rejects an unavailable handoff target without copying Catalog diagnostics', async () => {
    const source: CatalogPort = {
      ...withPinned((pinned) => pinned),
      pinAgent: (request, context) =>
        request.id === 'code-viewer'
          ? Promise.resolve({
              ok: false,
              error: {
                code: 'CATALOG_DEFINITION_UNAVAILABLE',
                category: 'VALIDATION',
                message: 'private-catalog-diagnostic',
                retryable: false,
                correlationId: context.correlationId,
              },
            })
          : catalog.pinAgent(request, context),
    };
    const error = await check(defaultSystemConfig(), source).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('code-viewer');
    expect((error as Error).message).toContain('CATALOG_DEFINITION_UNAVAILABLE');
    expect((error as Error).message).not.toContain('private-catalog-diagnostic');
  });

  it('rejects a handoff digest that differs from the pinned target', async () => {
    const source = withPinned((pinned) =>
      pinned.agent.id === 'code-viewer'
        ? { ...pinned, agent: { ...pinned.agent, digest: '0'.repeat(64) } }
        : pinned,
    );
    await expect(check(defaultSystemConfig(), source)).rejects.toThrow('digest mismatch');
  });

  it('rejects a Catalog response for a different requested identity', async () => {
    const source = withPinned((pinned) => ({
      ...pinned,
      agent: { ...pinned.agent, version: 'v99.0.0' },
    }));
    await expect(check(defaultSystemConfig(), source)).rejects.toThrow('different Agent');
  });

  it.each(['missing', 'different'] as const)('rejects a %s handoff reference', async (mode) => {
    const source = withPinned((pinned) => {
      if (pinned.handoffTargetRef === undefined) return pinned;
      if (mode === 'different')
        return { ...pinned, handoffTargetRef: { ...pinned.handoffTargetRef, id: 'other-agent' } };
      const { handoffTargetRef: omitted, ...rest } = pinned;
      void omitted;
      return rest;
    });
    await expect(check(defaultSystemConfig(), source)).rejects.toThrow('inconsistent handoff');
  });

  it('bounds repeated Catalog references and still checks the digest on a visited edge', async () => {
    // Production Catalog rejects handoff cycles. This deliberately faulty adapter exercises
    // traversal defence without changing Catalog rules or any shared fake.
    let root: PinnedDefinitionSet | undefined;
    const source = withPinned((pinned) => {
      if (pinned.agent.id === 'planner') {
        root = pinned;
        return pinned;
      }
      if (root === undefined) throw new Error('missing test root');
      return {
        ...pinned,
        agent: {
          ...pinned.agent,
          actions: {
            ...pinned.agent.actions,
            handoff: {
              toolRef: pinned.agent.actions.finish.toolRef,
              targetAgentRef: { id: root.agent.id, version: root.agent.version },
            },
          },
        },
        handoffTargetRef: {
          kind: 'AGENT',
          id: root.agent.id,
          version: root.agent.version,
          digest: '0'.repeat(64),
        },
      };
    });
    const pinAgent = vi.fn(source.pinAgent.bind(source));
    await expect(check(defaultSystemConfig(), { ...source, pinAgent })).rejects.toThrow(
      'digest mismatch',
    );
    expect(pinAgent).toHaveBeenCalledTimes(2);
  });

  it('propagates unexpected adapter errors instead of misclassifying them as configuration', async () => {
    const failure = new Error('adapter failed');
    const source: CatalogPort = {
      ...withPinned((pinned) => pinned),
      pinAgent: () => Promise.reject(failure),
    };
    await expect(check(defaultSystemConfig(), source)).rejects.toBe(failure);
    await expect(
      check(defaultSystemConfig(), catalog, {
        apiKeyFor: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it('requires strictly more than the final fixed input', async () => {
    const fixed = estimateFixedInputs(await viewer(), registry);
    await expect(check(viewerConfig({ finalInputBudget: fixed.final }))).rejects.toThrow(
      'finalInputBudget',
    );
    await expect(
      check(viewerConfig({ finalInputBudget: fixed.final + 1 })),
    ).resolves.toBeUndefined();
  });

  it('requires strictly more than ordinary fixed input even when there is no FILE_READ', async () => {
    const source = withPinned((pinned) => ({
      ...pinned,
      units: pinned.units.filter((unit) => unit.executionKind !== 'FILE_READ'),
    }));
    const fixed = estimateFixedInputs(await viewer(), registry);
    await expect(check(viewerConfig({ perCallInputLimit: fixed.normal }), source)).rejects.toThrow(
      'perCallInputLimit',
    );
    await expect(
      check(viewerConfig({ perCallInputLimit: fixed.normal + 1 }), source),
    ).resolves.toBeUndefined();
  });

  it('requires room for a full FILE_READ only on Agents that have it', async () => {
    const fixed = estimateFixedInputs(await viewer(), registry);
    const minimum =
      fixed.normal + defaultSystemConfig().kernel.executionLimits.FILE_READ.maxOutputBytes;
    await expect(check(viewerConfig({ perCallInputLimit: minimum }))).rejects.toThrow(
      'FILE_READ.maxOutputBytes',
    );
    await expect(check(viewerConfig({ perCallInputLimit: minimum + 1 }))).resolves.toBeUndefined();
    const withoutRead = withPinned((pinned) => ({
      ...pinned,
      units: pinned.units.filter((unit) => unit.executionKind !== 'FILE_READ'),
    }));
    await expect(
      check(viewerConfig({ perCallInputLimit: minimum }), withoutRead),
    ).resolves.toBeUndefined();
  });

  it('rejects an overflowing fixed-input plus file-output sum', async () => {
    const base = viewerConfig();
    const config = {
      ...base,
      kernel: {
        ...base.kernel,
        executionLimits: {
          ...base.kernel.executionLimits,
          FILE_READ: {
            ...base.kernel.executionLimits.FILE_READ,
            maxOutputBytes: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    };
    await expect(check(config)).rejects.toThrow('safe integer range');
  });

  it('rejects an oversized prompt on the handoff target', async () => {
    const source = withPinned((pinned) =>
      pinned.agent.id === 'code-viewer'
        ? { ...pinned, prompt: { ...pinned.prompt, template: 'x'.repeat(80_000) } }
        : pinned,
    );
    await expect(check(defaultSystemConfig(), source)).rejects.toThrow('Agent code-viewer');
  });
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('startup validation in composeSystem', () => {
  it.each(['budget', 'credentials', 'target provider', 'tool contract', 'fixed input'] as const)(
    'rejects invalid %s before any factory or filesystem initialization',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'startup-config-'));
      roots.push(root);
      const config = {
        ...withBudget(kind === 'budget' ? { tokenLimit: 1 } : {}),
        dataDir: join(root, 'data'),
      };
      const source = withPinned((pinned) => {
        if (pinned.agent.id !== 'code-viewer') return pinned;
        if (kind === 'target provider')
          return { ...pinned, model: { ...pinned.model, provider: 'other' } };
        if (kind === 'tool contract')
          return {
            ...pinned,
            tools: pinned.tools.map((tool) => ({
              ...tool,
              parametersContract: { ...tool.parametersContract, version: 'v999' },
            })),
          };
        if (kind === 'fixed input')
          return { ...pinned, prompt: { ...pinned.prompt, template: 'x'.repeat(80_000) } };
        return pinned;
      });
      const factory = () => {
        throw new Error('factory must not be reached');
      };
      const parts: SystemParts = {
        createKernelCore: vi.fn(factory),
        createGateway: vi.fn(factory),
        createSupervisor: vi.fn(factory),
        createWorkflow: vi.fn(factory),
        createUserInteraction: vi.fn(factory),
        createExecutorRegistry: vi.fn(factory),
      };
      await expect(
        composeSystem({
          config,
          catalog: source,
          parts,
          terminal: createFakeTerminal(),
          credentials: kind === 'credentials' ? { apiKeyFor: () => undefined } : credentials,
        }),
      ).rejects.toThrow(ConfigError);
      for (const build of Object.values(parts)) expect(build).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    },
  );
});
