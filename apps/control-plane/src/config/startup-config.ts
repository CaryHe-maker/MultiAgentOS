import {
  newId,
  type BoundaryContext,
  type CatalogPort,
  type DefinitionRef,
  type KernelConfig,
  type PinnedDefinitionRef,
  type PinnedDefinitionSet,
  type ProtocolRegistry,
  type ProviderCredentials,
  type SystemConfig,
} from '@multiagentos/contracts';
import { estimateFixedInputs } from './startup-context.js';
import { ConfigError } from './system-config.js';

/**
 * Checks an already Schema-validated configuration after Catalog loading and before factories
 * run (Monitor 4, AgentToolPool 5). Makes no provider requests and changes no definitions.
 * Expected configuration failures are ConfigError; unexpected adapter failures propagate.
 */
export async function assertStartupConfig(
  config: SystemConfig,
  catalog: CatalogPort,
  registry: ProtocolRegistry,
  credentials: ProviderCredentials,
): Promise<void> {
  const bounds = assertBudget(config.kernel);
  const context: BoundaryContext = Object.freeze({
    correlationId: newId('cor'),
    tenantId: 'local',
    projectId: 'local',
  });
  const visited = new Map<string, string>();
  const checkedProviders = new Set<string>();
  let next: DefinitionRef | PinnedDefinitionRef | undefined = config.workflow.entryAgentRef;
  while (next !== undefined) {
    const label = next.id + '@' + next.version;
    const previousDigest = visited.get(label);
    if (previousDigest !== undefined) {
      assertDigest(next, previousDigest, label);
      break;
    }

    const result = await catalog.pinAgent({ id: next.id, version: next.version }, context);
    if (!result.ok) throw new ConfigError('cannot pin Agent ' + label + ': ' + result.error.code);
    const pinned = result.value;
    if (pinned.agent.id !== next.id || pinned.agent.version !== next.version)
      throw new ConfigError('catalog returned a different Agent for ' + label);
    assertDigest(next, pinned.agent.digest, label);
    visited.set(label, pinned.agent.digest);

    assertModel(config.kernel, pinned, bounds);
    assertInputs(config.kernel, pinned, registry);

    const provider = pinned.model.provider;
    if (!checkedProviders.has(provider)) {
      // Read only for presence; the value never enters diagnostics, state or returned data.
      if ((credentials.apiKeyFor(provider)?.trim().length ?? 0) === 0)
        throw new ConfigError('API key is missing for provider ' + provider);
      checkedProviders.add(provider);
    }
    next = handoffTarget(pinned);
  }
}

interface CallBounds {
  readonly normal: number;
  readonly final: number;
}

function assertBudget(config: KernelConfig): CallBounds {
  for (const [field, value] of Object.entries(config.budget))
    assertPositiveSafeInteger(value, 'kernel.budget.' + field);
  assertPositiveSafeInteger(
    config.executionLimits.FILE_READ.maxOutputBytes,
    'kernel.executionLimits.FILE_READ.maxOutputBytes',
  );
  const finalReserve = safeSum(
    config.budget.finalInputBudget,
    config.budget.finalMaxOutputTokens,
    'finalReserve',
  );
  const wrapUpMargin = safeSum(
    config.budget.perCallInputLimit,
    config.budget.maxOutputTokens,
    'wrapUpMargin',
  );
  const minimum = safeSum(finalReserve, wrapUpMargin, 'finalReserve + wrapUpMargin');
  if (config.budget.tokenLimit < minimum)
    throw new ConfigError('kernel.budget.tokenLimit must be at least ' + minimum);
  return { normal: wrapUpMargin, final: finalReserve };
}

function assertModel(config: KernelConfig, pinned: PinnedDefinitionSet, bounds: CallBounds): void {
  const label = pinned.agent.id + '@' + pinned.agent.version;
  const { limits, provider } = pinned.model;
  if (provider !== config.provider)
    throw new ConfigError('Agent ' + label + ' model provider does not match kernel.provider');
  assertPositiveSafeInteger(limits.maxOutputTokens, 'Agent ' + label + ' model maxOutputTokens');
  assertPositiveSafeInteger(
    limits.contextWindowTokens,
    'Agent ' + label + ' model contextWindowTokens',
  );
  for (const field of ['maxOutputTokens', 'finalMaxOutputTokens'] as const) {
    if (config.budget[field] > limits.maxOutputTokens)
      throw new ConfigError('Agent ' + label + ': ' + field + ' exceeds model maxOutputTokens');
  }
  if (bounds.normal > limits.contextWindowTokens)
    throw new ConfigError(
      'Agent ' + label + ' ordinary input + output exceed model context window',
    );
  if (bounds.final > limits.contextWindowTokens)
    throw new ConfigError('Agent ' + label + ' final input + output exceed model context window');
}

function assertInputs(
  config: KernelConfig,
  pinned: PinnedDefinitionSet,
  registry: ProtocolRegistry,
): void {
  const label = pinned.agent.id + '@' + pinned.agent.version;
  const fixed = estimateFixedInputs(pinned, registry);
  if (fixed.normal >= config.budget.perCallInputLimit)
    throw new ConfigError(
      'Agent ' + label + ': perCallInputLimit must exceed fixed input ' + fixed.normal,
    );
  if (fixed.final >= config.budget.finalInputBudget)
    throw new ConfigError(
      'Agent ' + label + ': finalInputBudget must exceed fixed input ' + fixed.final,
    );
  if (pinned.units.some((unit) => unit.executionKind === 'FILE_READ')) {
    const required = safeSum(
      fixed.normal,
      config.executionLimits.FILE_READ.maxOutputBytes,
      'fixed input + FILE_READ.maxOutputBytes',
    );
    if (required >= config.budget.perCallInputLimit)
      throw new ConfigError(
        'Agent ' +
          label +
          ': perCallInputLimit must exceed fixed input + FILE_READ.maxOutputBytes ' +
          required,
      );
  }
}

function handoffTarget(pinned: PinnedDefinitionSet): PinnedDefinitionRef | undefined {
  const declared = pinned.agent.actions.handoff;
  const target = pinned.handoffTargetRef;
  if (
    (declared === undefined) !== (target === undefined) ||
    (declared !== undefined &&
      target !== undefined &&
      (target.kind !== 'AGENT' ||
        target.id !== declared.targetAgentRef.id ||
        target.version !== declared.targetAgentRef.version))
  )
    throw new ConfigError('Agent ' + pinned.agent.id + ' has an inconsistent handoff target');
  return target;
}

function assertDigest(
  ref: DefinitionRef | PinnedDefinitionRef,
  digest: string,
  label: string,
): void {
  if ('digest' in ref && ref.digest !== digest)
    throw new ConfigError('handoff target digest mismatch for ' + label);
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ConfigError(field + ' must be a positive safe integer');
}

function safeSum(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new ConfigError(label + ' exceeds safe integer range');
  return sum;
}
