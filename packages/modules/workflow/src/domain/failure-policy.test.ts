import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FAILURE_HANDLINGS,
  RunFailureSchema,
  UNIT_KINDS,
  UNIT_REPORT_CODES,
  newId,
  validate,
} from '@multiagentos/contracts';
import type { FailureHandling, SyscallRejected, UnitDefinition } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { definitions } from '../test-support/definitions.js';
import {
  failureFromCode,
  finalCallReason,
  mostSevereFailure,
  syscallFailureHandling,
  unitFailureHandling,
} from './failure-policy.js';

/** Reads only the two needed YAML fields, rejecting values outside the frozen protocol enums. */
async function shippedUnit(id: string): Promise<UnitDefinition> {
  const text = await readFile(
    join(process.cwd(), 'packages/libraries/agent-tool-pool/definitions/units', id, 'v0.1.0.yaml'),
    'utf8',
  );
  const kindName = /^executionKind: (\w+)$/m.exec(text)?.[1];
  const executionKind = UNIT_KINDS.find((kind) => kind === kindName);
  if (executionKind === undefined) throw new Error(`Unsupported execution kind in fixture: ${id}`);
  const policyText = text.split('failurePolicy:')[1];
  if (policyText === undefined) throw new Error(`Missing failurePolicy in fixture: ${id}`);
  const lines =
    policyText.trim() === '{}'
      ? []
      : policyText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#'));
  const entries = lines.map((line) => {
    const match = /^([A-Z_]+): ([A-Z_]+)$/.exec(line);
    if (match === null) throw new Error(`Unsupported failurePolicy fixture syntax: ${id}`);
    const code = UNIT_REPORT_CODES.find((candidate) => candidate === match[1]);
    const handling = FAILURE_HANDLINGS.find((candidate) => candidate === match[2]);
    if (code === undefined || handling === undefined)
      throw new Error(`Invalid failurePolicy: ${id}`);
    return [code, handling] as const;
  });
  const base = definitions().units[0];
  if (base === undefined) throw new Error('Missing Unit fixture');
  return {
    ...base,
    id,
    executionKind,
    failurePolicy: Object.fromEntries(entries),
  };
}

describe('pinned Unit failurePolicy', () => {
  it.each([
    'repository-orient',
    'repository-search',
    'file-read',
    'context-assemble',
    'model-call',
    'report-publish',
  ])('uses every shipped %s policy entry and defaults to FATAL', async (id) => {
    const unit = await shippedUnit(id);
    for (const code of UNIT_REPORT_CODES)
      expect(unitFailureHandling(unit, code, false), `${id}/${code}`).toBe(
        unit.failurePolicy[code] ?? 'FATAL',
      );
  });

  it('final model-call bypasses policy; other Units retain it', async () => {
    const model = await shippedUnit('model-call');
    const context = await shippedUnit('context-assemble');
    for (const code of UNIT_REPORT_CODES) {
      expect(unitFailureHandling(model, code, true)).toBe('DEGRADED_REPORT');
      expect(unitFailureHandling(context, code, true)).toBe('FATAL');
    }
  });

  it.each([
    ['FATAL', 'FINAL_CALL', 'DEGRADED_REPORT'],
    ['DEGRADED_REPORT', 'RETURN_TO_MODEL', 'FATAL'],
    ['RETURN_TO_MODEL', 'FINAL_CALL', 'DEGRADED_REPORT', 'FATAL'],
  ] as FailureHandling[][])(
    'selects the most severe of %j independently of arrival order',
    (...values) => {
      expect(mostSevereFailure(values)).toBe('FATAL');
      expect(mostSevereFailure([...values].reverse())).toBe('FATAL');
    },
  );

  it('handles empty rounds and distinguishes the nonfatal levels', () => {
    expect(mostSevereFailure([])).toBeUndefined();
    expect(mostSevereFailure(['RETURN_TO_MODEL'])).toBe('RETURN_TO_MODEL');
    expect(mostSevereFailure(['RETURN_TO_MODEL', 'FINAL_CALL'])).toBe('FINAL_CALL');
    expect(mostSevereFailure(['FINAL_CALL', 'DEGRADED_REPORT'])).toBe('DEGRADED_REPORT');
  });

  it('produces a Schema-valid Workflow failure with the original Unit requestId', () => {
    const unitRequestId = newId('req');
    const failure = failureFromCode('USER_DECLINED', unitRequestId);
    expect(failure).toEqual({
      code: 'USER_DECLINED',
      category: 'POLICY',
      source: 'WORKFLOW',
      unitRequestId,
    });
    expect(validate(RunFailureSchema, failure).ok).toBe(true);
    expect(failureFromCode('WORKFLOW_INTERNAL')).toEqual({
      code: 'WORKFLOW_INTERNAL',
      category: 'INTERNAL',
      source: 'WORKFLOW',
    });
  });

  it('waits after RUN_BLOCKED or any rejected closeRun and otherwise closes as FAILED', () => {
    const blocked: SyscallRejected = {
      requestId: newId('req'),
      outcome: 'REJECTED',
      issuer: 'CORE',
      reasonCode: 'RUN_BLOCKED',
      closeReason: 'CANCELLED',
    };
    const forbidden: SyscallRejected = {
      requestId: newId('req'),
      outcome: 'REJECTED',
      issuer: 'CORE',
      reasonCode: 'FORBIDDEN',
    };
    expect(syscallFailureHandling(blocked, false)).toBe('WAIT_FOR_CLOSED');
    expect(syscallFailureHandling(forbidden, false)).toBe('CLOSE_FAILED');
    expect(syscallFailureHandling(forbidden, true)).toBe('WAIT_FOR_CLOSED');
  });

  it('maps the two M1 FINAL_CALL codes without inventing a mapping for other codes', () => {
    expect(finalCallReason('USER_DECLINED')).toBe('USER_DECLINED');
    expect(finalCallReason('BUDGET_WRAP_UP')).toBe('BUDGET_WRAP_UP');
    expect(() => finalCallReason('INTERNAL')).toThrow('no specified wrap-up mapping');
  });
});
