import type { ExecutionScope, UnitDefinition } from '@multiagentos/contracts';
import type { Lease } from './authorization.js';
import type { AgentRunRecord } from './run-state.js';

/**
 * Derives the scope Core attaches to an attempt (Interaction 4.2, 5.2). Only the derived
 * values leave Core; the Lease itself never does.
 */
export function deriveExecutionScope(
  unit: UnitDefinition,
  agentRun: AgentRunRecord,
  lease: Readonly<Lease> | undefined,
): ExecutionScope {
  if (unit.executionKind === 'MODEL') {
    const { model, agent } = agentRun.pinned;
    const settings = agent.modelSettings;
    if (settings.thinking === 'ENABLED') {
      if (settings.thinkingEffort === undefined)
        throw new Error('An ENABLED thinking setting needs thinkingEffort');
      return {
        kind: 'MODEL',
        provider: model.provider,
        apiModelId: model.apiModelId,
        apiProtocol: model.apiProtocol,
        baseUrl: model.baseUrl,
        thinking: 'ENABLED',
        thinkingEffort: settings.thinkingEffort,
      };
    }
    return {
      kind: 'MODEL',
      provider: model.provider,
      apiModelId: model.apiModelId,
      apiProtocol: model.apiProtocol,
      baseUrl: model.baseUrl,
      thinking: 'DISABLED',
    };
  }
  if (unit.protectedCapabilities.includes('repo.read')) {
    if (lease === undefined) throw new Error('A protected Unit needs a valid Lease');
    return {
      kind: 'REPOSITORY',
      repositoryRoot: lease.repositoryRoot,
      exclusions: [...lease.exclusions],
    };
  }
  return { kind: 'NONE' };
}
