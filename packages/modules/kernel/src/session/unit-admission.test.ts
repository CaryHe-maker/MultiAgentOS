import type { ExecutionKind, SubmitUnitRequest } from '@multiagentos/contracts';
import { testUnitDefinition } from '@multiagentos/contracts/test-support';
import { describe, expect, it } from 'vitest';
import { closeRun, initialRunControl, openInitialTurn, type RunControl } from './run-control.js';
import { admitUnit, type AdmissionContext } from './unit-admission.js';

const unitOf = (kind: ExecutionKind) => testUnitDefinition(kind);
const fileRead = unitOf('FILE_READ');

type Unit = ReturnType<typeof unitOf>;
const requestFor = (unit: Unit): Pick<SubmitUnitRequest, 'unitRef' | 'input'> => ({
  unitRef: { kind: 'UNIT', id: unit.id, version: unit.version, digest: unit.digest },
  input: {},
});
const request = requestFor(fileRead);
/** An ACTIVE AgentRun pinned with exactly this Unit. */
const pinned = (unit: Unit) => ({ state: 'ACTIVE', units: [unit], maxToolUnits: 10 }) as const;

function openTurn(): RunControl {
  const opened = openInitialTurn(initialRunControl(), 'trn_1');
  if (!opened.accepted) throw new Error('no Turn');
  return opened.control;
}

const context = (over: Partial<AdmissionContext> = {}): AdmissionContext => ({
  control: openTurn(),
  agentRun: { state: 'ACTIVE', units: [fileRead], maxToolUnits: 10 },
  inputIsValid: () => true,
  ...over,
});

const refusal = (over: Partial<AdmissionContext>, unit: Unit = fileRead) => {
  const result = admitUnit(requestFor(unit), context(over));
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
    const command = unitOf('COMMAND');
    expect(refusal({ agentRun: pinned(command), inputIsValid: () => false }, command)).toBe(
      'UNSUPPORTED_CAPABILITY',
    );
  });

  it('needs the Lease only because the definition declares repo.read', () => {
    const declared = testUnitDefinition('MODEL', { protectedCapabilities: ['repo.read'] });
    const undeclared = testUnitDefinition('FILE_READ', { protectedCapabilities: [] });
    const needs = (unit: Unit) => {
      const result = admitUnit(requestFor(unit), context({ agentRun: pinned(unit) }));
      return result.accepted && result.needsRepoRead;
    };
    expect(needs(declared)).toBe(true);
    expect(needs(undeclared)).toBe(false);
  });

  it('refuses input outside the contract', () => {
    expect(refusal({ inputIsValid: () => false })).toBe('INVALID_INPUT');
  });

  it.each(['CONTEXT_ASSEMBLE', 'MODEL', 'MESSAGE_PUBLISH', 'REPORT_PUBLISH'] as const)(
    'leaves %s outside the tool quota',
    (kind) => {
      const unit = unitOf(kind);
      expect(admitUnit(requestFor(unit), context({ agentRun: pinned(unit) }))).toMatchObject({
        accepted: true,
        needsRepoRead: false,
        countsAsTool: false,
      });
    },
  );
});
