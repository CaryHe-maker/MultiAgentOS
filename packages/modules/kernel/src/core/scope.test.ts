import type { PinnedDefinitionSet, UnitDefinition } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import type { Lease } from './authorization.js';
import type { AgentRunRecord } from './run-state.js';
import { deriveExecutionScope } from './scope.js';

const lease: Lease = {
  capability: 'repo.read',
  repositoryRoot: '/repo',
  exclusions: ['**/.env*', '**/secrets/**'],
  provider: 'deepseek',
  issuedAt: '2026-10-19T00:00:00.000Z',
};

function unit(
  executionKind: UnitDefinition['executionKind'],
  protectedCapabilities: UnitDefinition['protectedCapabilities'] = [],
): UnitDefinition {
  return {
    schemaVersion: 'v0',
    kind: 'UNIT',
    id: 'unit',
    version: 'v0.1.0',
    digest: 'd'.repeat(64),
    description: 'unit',
    executionKind,
    protectedCapabilities,
    inputContract: { kind: 'contract', id: 'executor.FileReadInput', version: 'v0' },
    outputContract: { kind: 'contract', id: 'executor.FileReadOutput', version: 'v0' },
    toolRefs: [],
    effect: 'READ_ONLY',
    isIdempotent: true,
    failurePolicy: {},
  };
}

function agentRun(settings: {
  thinking: 'DISABLED' | 'ENABLED';
  thinkingEffort?: string;
}): AgentRunRecord {
  const pinned = {
    agent: { modelSettings: settings },
    model: {
      provider: 'deepseek',
      apiModelId: 'deepseek-chat',
      apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://api.deepseek.com',
    },
  } as unknown as PinnedDefinitionSet;
  return {
    agentRunId: 'agr_123456',
    agentRef: {
      kind: 'AGENT',
      id: 'planner',
      version: 'v0.1.0',
      digest: 'a'.repeat(64),
    },
    pinned,
    state: 'ACTIVE',
    registeredAt: '2026-10-19T00:00:00.000Z',
    rounds: 0,
  };
}

describe('deriveExecutionScope', () => {
  it('derives a REPOSITORY scope only from the Lease-derived values', () => {
    expect(
      deriveExecutionScope(
        unit('FILE_READ', ['repo.read']),
        agentRun({ thinking: 'DISABLED' }),
        lease,
      ),
    ).toEqual({
      kind: 'REPOSITORY',
      repositoryRoot: '/repo',
      exclusions: ['**/.env*', '**/secrets/**'],
    });
  });

  it('requires a Lease for a protected Unit', () => {
    expect(() =>
      deriveExecutionScope(
        unit('FILE_READ', ['repo.read']),
        agentRun({ thinking: 'DISABLED' }),
        undefined,
      ),
    ).toThrow('A protected Unit needs a valid Lease');
  });

  it('derives the fixed model settings for MODEL', () => {
    expect(
      deriveExecutionScope(unit('MODEL'), agentRun({ thinking: 'DISABLED' }), undefined),
    ).toEqual({
      kind: 'MODEL',
      provider: 'deepseek',
      apiModelId: 'deepseek-chat',
      apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://api.deepseek.com',
      thinking: 'DISABLED',
    });
    expect(
      deriveExecutionScope(
        unit('MODEL'),
        agentRun({ thinking: 'ENABLED', thinkingEffort: 'high' }),
        undefined,
      ),
    ).toMatchObject({ thinking: 'ENABLED', thinkingEffort: 'high' });
  });

  it('derives NONE for non-repository, non-model Units', () => {
    expect(
      deriveExecutionScope(unit('CONTEXT_ASSEMBLE'), agentRun({ thinking: 'DISABLED' }), undefined),
    ).toEqual({
      kind: 'NONE',
    });
  });
});
