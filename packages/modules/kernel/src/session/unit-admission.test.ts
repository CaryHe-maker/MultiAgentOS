import type {
  ExecutionKindV1,
  SubmitUnitRequestV1,
  UnitDefinitionV1,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { closeRun, initialRunControl, openInitialTurn, type RunControl } from './run-control.js';
import { admitUnit, type AdmissionContext } from './unit-admission.js';

const digest = 'd'.repeat(64);

function unitOf(executionKind: ExecutionKindV1, capabilities: readonly string[] = []) {
  return {
    id: 'file-read',
    version: 'v1.0.0',
    digest,
    executionKind,
    protectedCapabilities: capabilities,
  } as unknown as UnitDefinitionV1;
}

const request = {
  unitRef: { kind: 'UNIT', id: 'file-read', version: 'v1.0.0', digest },
  input: {},
} as unknown as SubmitUnitRequestV1;

function openTurn(): RunControl {
  const opened = openInitialTurn(initialRunControl(), 'trn_1');
  if (!opened.accepted) throw new Error('no Turn');
  return opened.control;
}

const context = (over: Partial<AdmissionContext> = {}): AdmissionContext => ({
  control: openTurn(),
  agentRun: { state: 'ACTIVE', units: [unitOf('FILE_READ', ['repo.read'])], maxToolUnits: 10 },
  inputIsValid: () => true,
  ...over,
});

const refusal = (over: Partial<AdmissionContext>) => {
  const result = admitUnit(request, context(over));
  return result.accepted ? 'ACCEPTED' : result.reasonCode;
};

describe('admitUnit', () => {
  it('admits a repository Unit that needs the Lease and counts as a tool', () => {
    expect(admitUnit(request, context())).toMatchObject({
      accepted: true,
      needsRepoRead: true,
      countsAsTool: true,
    });
  });

  it('checks the run before the AgentRun', () => {
    expect(refusal({ control: initialRunControl(), agentRun: undefined })).toBe('NO_OPEN_TURN');
    expect(refusal({ control: closeRun(openTurn()) })).toBe('RUN_BLOCKED');
  });

  it('refuses an unknown or ended AgentRun', () => {
    expect(refusal({ agentRun: undefined })).toBe('AGENT_RUN_NOT_FOUND');
    expect(refusal({ agentRun: { state: 'ENDED', units: [], maxToolUnits: 1 } })).toBe(
      'AGENT_RUN_ENDED',
    );
  });

  it('refuses a Unit the Agent was not pinned with', () => {
    expect(refusal({ agentRun: { state: 'ACTIVE', units: [], maxToolUnits: 1 } })).toBe(
      'FORBIDDEN',
    );
  });

  it('refuses kinds this stage cannot run, before reading the input', () => {
    expect(
      refusal({
        agentRun: { state: 'ACTIVE', units: [unitOf('COMMAND')], maxToolUnits: 1 },
        inputIsValid: () => false,
      }),
    ).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('refuses input outside the contract', () => {
    expect(refusal({ inputIsValid: () => false })).toBe('INVALID_INPUT');
  });

  it.each(['CONTEXT_ASSEMBLE', 'MODEL', 'MESSAGE_PUBLISH', 'REPORT_PUBLISH'] as const)(
    'leaves %s outside the tool quota',
    (kind) => {
      const agentRun = { state: 'ACTIVE', units: [unitOf(kind)], maxToolUnits: 1 } as const;
      expect(admitUnit(request, context({ agentRun }))).toMatchObject({
        accepted: true,
        needsRepoRead: false,
        countsAsTool: false,
      });
    },
  );
});
