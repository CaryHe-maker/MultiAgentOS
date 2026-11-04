import {
  estimateItemTokens,
  estimatePackTokens,
  type KernelConfig,
  type ModelToolSpec,
  type PinnedDefinitionSet,
  type ProtocolRegistry,
  type ProviderCredentials,
} from '@multiagentos/contracts';
import { minShare } from '@multiagentos/kernel';
import { ConfigError } from './system-config.js';

/** STATUS is rendered from a few counters and the wrap-up line; this bounds it generously. */
const STATUS_MAX_BYTES = 1024;

/**
 * The startup checks of Kernel/Monitor 6, for every Agent the process can register. They make no
 * provider request and change no definition. The fixed part of a call is what the system itself
 * puts in it: the system segment, the tool definitions, the orientation and STATUS. User input
 * and `AGENTS.md` are not bounded here; a call they do not fit ends with CONTEXT_LIMIT at run time.
 */
export function assertStartupChecks(
  config: KernelConfig,
  agents: readonly PinnedDefinitionSet[],
  registry: Pick<ProtocolRegistry, 'jsonSchemaOf'>,
  credentials: ProviderCredentials,
): void {
  const { budget } = config;
  const main = agents.find((set) => set.agent.id === 'main');
  if (main === undefined) throw new ConfigError('the built-in Agent main is missing');
  if (budget.turnTokenLimit < minShare(main.agent.budget))
    throw new ConfigError(`kernel.budget.turnTokenLimit must be at least minShare(main)`);
  if (budget.runTokenLimit < budget.turnTokenLimit)
    throw new ConfigError('kernel.budget.runTokenLimit must be at least turnTokenLimit');

  const providers = new Set<string>();
  for (const set of agents) {
    assertAgent(config, set, registry);
    providers.add(set.model.provider);
  }
  for (const provider of providers)
    // Read only for presence; the value never enters diagnostics, state or returned data.
    if ((credentials.apiKeyFor(provider)?.trim().length ?? 0) === 0)
      throw new ConfigError(`API key is missing for provider ${provider}`);
}

function assertAgent(
  config: KernelConfig,
  set: PinnedDefinitionSet,
  registry: Pick<ProtocolRegistry, 'jsonSchemaOf'>,
): void {
  const { agent, model, prompt, units, tools } = set;
  const label = `Agent ${agent.id}@${agent.version}`;
  const { perCallInputLimit, maxOutputTokens, finalInputBudget, finalMaxOutputTokens } =
    agent.budget;
  if (model.provider !== config.provider)
    throw new ConfigError(`${label}: model provider does not match kernel.provider`);
  for (const value of [perCallInputLimit, maxOutputTokens, finalInputBudget, finalMaxOutputTokens])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ConfigError(`${label}: budget values must be positive safe integers`);
  if (
    !Number.isSafeInteger(
      perCallInputLimit + maxOutputTokens + finalInputBudget + finalMaxOutputTokens,
    )
  )
    throw new ConfigError(`${label}: budget values overflow`);
  if (Math.max(maxOutputTokens, finalMaxOutputTokens) > model.limits.maxOutputTokens)
    throw new ConfigError(`${label}: output budget exceeds the model's maxOutputTokens`);
  if (perCallInputLimit + maxOutputTokens > model.limits.contextWindowTokens)
    throw new ConfigError(`${label}: ordinary input and output exceed the context window`);
  if (finalInputBudget + finalMaxOutputTokens > model.limits.contextWindowTokens)
    throw new ConfigError(`${label}: final input and output exceed the context window`);

  const specOf = (tool: (typeof tools)[number]): ModelToolSpec => ({
    name: tool.modelName,
    description: tool.modelDescription,
    parameters: registry.jsonSchemaOf(tool.parametersContract),
    purpose: tool.purpose,
  });
  const finalTools = agent.actions.end
    .filter((end) => end.allowedInFinal)
    .flatMap((end) =>
      tools.filter((tool) => tool.id === end.toolRef.id && tool.version === end.toolRef.version),
    );
  const orients = units.some(
    (unit) =>
      unit.executionKind === 'REPOSITORY_ORIENT' &&
      agent.startUnitRefs.some((ref) => ref.id === unit.id),
  );
  const fixed = (toolSpecs: readonly ModelToolSpec[]): number =>
    estimatePackTokens({
      items: [
        { role: 'system', content: prompt.template },
        { role: 'system', content: '', toolSpecs },
      ],
    }) +
    estimateItemTokens({ role: 'user', content: '\u0001'.repeat(STATUS_MAX_BYTES) }) +
    (orients ? config.budget.orientBudget : 0);
  const normal = fixed(tools.map(specOf));
  const final = fixed(finalTools.map(specOf));
  if (normal >= perCallInputLimit)
    throw new ConfigError(`${label}: perCallInputLimit must exceed the fixed input ${normal}`);
  if (final >= finalInputBudget)
    throw new ConfigError(`${label}: finalInputBudget must exceed the fixed input ${final}`);

  // An ordinary call is never trimmed, so one preview of each tool must fit beside the fixed part.
  const limits = config.executionLimits;
  for (const unit of units) {
    if (unit.toolRefs.length === 0) continue;
    const limit =
      unit.executionKind === 'REPOSITORY_SEARCH' ||
      unit.executionKind === 'REPOSITORY_LIST' ||
      unit.executionKind === 'FILE_READ'
        ? limits[unit.executionKind]
        : undefined;
    if (limit === undefined) continue;
    const preview = Math.min(limit.previewMaxBytes, limit.maxOutputBytes);
    if (normal + preview >= perCallInputLimit)
      throw new ConfigError(
        `${label}: perCallInputLimit must exceed the fixed input plus one ${unit.id} preview`,
      );
  }
}
