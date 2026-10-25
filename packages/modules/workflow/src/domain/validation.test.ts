import {
  StepRecordSchema,
  canonicalJson,
  createM1ProtocolRegistry,
  newId,
  validate,
} from '@multiagentos/contracts';
import type { ModelToolCall } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { repositoryDefinitions } from '../test-support/definitions.js';
import { validateToolCalls } from './validation.js';
import type { SuccessfulToolCall, ValidationContext } from './validation.js';

const definitions = repositoryDefinitions();
const registry = createM1ProtocolRegistry();
const call = (
  toolName: string,
  args: ModelToolCall['arguments'],
  toolCallId = 'call-1',
): ModelToolCall =>
  args === null
    ? { toolName, toolCallId, arguments: null, argumentsError: 'INVALID_JSON' }
    : { toolName, toolCallId, arguments: args };
const context = (extra: Partial<ValidationContext> = {}): ValidationContext => ({
  definitions,
  budgetState: 'NORMAL',
  round: 1,
  successfulCalls: [],
  elidedRequestIds: [],
  registry,
  ...extra,
});
const previous: SuccessfulToolCall = {
  unitRef: { kind: 'UNIT', id: 'file-read', version: 'v1.0.0', digest: 'a'.repeat(64) },
  argumentsCanonical: canonicalJson({ path: 'src/index.ts', startLine: 2, endLine: 5 }),
  requestId: newId('req'),
};

describe('UNIT tool Validation', () => {
  it('accepts legal calls and maps each tool to its owning Unit', () => {
    const result = validateToolCalls(
      [
        call('read_file', { path: 'src/index.ts' }),
        call('search_repository', { query: 'loop' }, 'call-2'),
      ],
      context(),
    );
    expect(result.accepted.map(({ unit }) => unit.id)).toEqual(['file-read', 'repository-search']);
    expect(result.accepted[0]?.input).toEqual({ path: 'src/index.ts' });
    expect(result.feedback).toEqual([]);
  });

  it('checks the limit before arguments or budget and counts only known UNIT calls', () => {
    const result = validateToolCalls(
      [
        call('unknown', {}),
        call('read_file', { path: 'file' }, 'call-2'),
        call('read_file', null, 'call-3'),
      ],
      context({ definitions: repositoryDefinitions(1), budgetState: 'EXHAUSTED' }),
    );
    expect(result.feedback.map(({ code }) => code)).toEqual([
      'UNKNOWN_TOOL',
      'NOT_EXECUTED',
      'TOO_MANY_TOOL_CALLS',
    ]);
    expect(result.accepted).toEqual([]);
  });

  it('a zero UNIT limit rejects every UNIT call without validating its arguments', () => {
    const result = validateToolCalls(
      [call('read_file', null)],
      context({
        definitions: repositoryDefinitions(0),
      }),
    );
    expect(result.feedback[0]?.code).toBe('TOO_MANY_TOOL_CALLS');
  });

  it.each(['unknown', 'finish_analysis'])('rejects %s as an unknown UNIT tool', (name) => {
    const result = validateToolCalls([call(name, {})], context({ budgetState: 'EXHAUSTED' }));
    expect(result.feedback[0]?.code).toBe('UNKNOWN_TOOL');
  });

  it.each([null, {}, { path: 'file', extra: true }, { path: 'file', startLine: 5, endLine: 2 }])(
    'rejects invalid arguments before checking budget: %j',
    (args) => {
      const result = validateToolCalls(
        [call('read_file', args)],
        context({ budgetState: 'EXHAUSTED' }),
      );
      expect(result.feedback[0]?.code).toBe('INVALID_ARGUMENTS');
    },
  );

  it('checks EXHAUSTED before duplicates but permits tools during WRAP_UP', () => {
    const calls = [call('read_file', { path: 'src/index.ts', startLine: 2, endLine: 5 })];
    expect(
      validateToolCalls(calls, context({ budgetState: 'EXHAUSTED', successfulCalls: [previous] }))
        .feedback[0]?.code,
    ).toBe('NOT_EXECUTED');
    expect(validateToolCalls(calls, context({ budgetState: 'WRAP_UP' })).accepted).toHaveLength(1);
  });

  it('ignores object key order when detecting successful calls', () => {
    const result = validateToolCalls(
      [call('read_file', { endLine: 5, path: 'src/index.ts', startLine: 2 })],
      context({ successfulCalls: [previous] }),
    );
    expect(result.accepted).toEqual([]);
    expect(result.feedback[0]?.code).toBe('DUPLICATE_CALL');
  });

  it('permits repetition after the earlier result is elided', () => {
    const result = validateToolCalls(
      [call('read_file', { path: 'src/index.ts', startLine: 2, endLine: 5 })],
      context({ successfulCalls: [previous], elidedRequestIds: [previous.requestId] }),
    );
    expect(result.accepted).toHaveLength(1);
  });

  it('does not add defaults or compare calls with a different Unit identity', () => {
    const search: SuccessfulToolCall = {
      ...previous,
      unitRef: { ...previous.unitRef, id: 'repository-search' },
      argumentsCanonical: canonicalJson({ query: 'loop' }),
    };
    expect(
      validateToolCalls(
        [call('search_repository', { query: 'loop', mode: 'AUTO' })],
        context({ successfulCalls: [search] }),
      ).accepted,
    ).toHaveLength(1);
    expect(
      validateToolCalls(
        [call('search_repository', { query: 'loop' })],
        context({
          successfulCalls: [{ ...search, unitRef: { ...search.unitRef, digest: 'b'.repeat(64) } }],
        }),
      ).accepted,
    ).toHaveLength(1);
  });

  it('executes only the first of identical calls in the same reply', () => {
    const result = validateToolCalls(
      [
        call('read_file', { path: 'file' }),
        call('read_file', { path: 'file' }, 'call-2'),
        call('read_file', { path: 'other' }, 'call-3'),
      ],
      context(),
    );
    expect(result.accepted.map((tool) => tool.call.toolCallId)).toEqual(['call-1', 'call-3']);
    expect(result.feedback).toMatchObject([{ code: 'DUPLICATE_CALL', toolCallId: 'call-2' }]);
    expect(result.feedback[0]?.message).toContain('same reply');
  });

  it('names the failing argument paths without echoing the argument values', () => {
    const result = validateToolCalls(
      [call('read_file', { path: 'secret-value', startLine: 0 })],
      context(),
    );
    const message = result.feedback[0]?.message ?? '';
    expect(result.feedback).toMatchObject([{ code: 'INVALID_ARGUMENTS' }]);
    expect(message).toContain('/startLine');
    expect(message).not.toContain('secret-value');
    expect(message.length).toBeLessThanOrEqual(1000);
  });

  it('produces Schema-valid feedback with the round and toolCallId for every rejected call', () => {
    const result = validateToolCalls([call('unknown', {})], context({ round: 2 }));
    expect(result.feedback[0]).toMatchObject({ round: 2, toolCallId: 'call-1' });
    for (const feedback of result.feedback)
      expect(validate(StepRecordSchema, feedback).ok).toBe(true);
  });
});
