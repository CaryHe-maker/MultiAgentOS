import { testUnitDefinition } from '@multiagentos/contracts/test-support';
import type { SchedulerDuties } from '../interfaces/index.js';
import { RunLedgers, minShare, type AgentBudget } from '../monitor/run-ledgers.js';
import type { AttemptSpec, RunAttempts } from '../session/run-attempts.js';
import { RunWork, type PinnedAgent, type RunHost, type RunWorkDeps } from '../session/run-work.js';

export const testAgentBudget: AgentBudget = {
  perCallInputLimit: 100,
  maxOutputTokens: 50,
  finalInputBudget: 40,
  finalMaxOutputTokens: 20,
};

export const testScheduler = (): SchedulerDuties => {
  let next = 0;
  return {
    acquire: () => {
      next += 1;
      return { ok: true, grantId: `grt_${next}` };
    },
    release: () => undefined,
    stopGranting: () => undefined,
    releaseAll: () => 0,
  };
};

export const testPinnedAgent = (overrides: Partial<PinnedAgent> = {}): PinnedAgent => ({
  units: [testUnitDefinition('FILE_READ'), testUnitDefinition('MESSAGE_PUBLISH')],
  maxToolUnits: 10,
  modelScope: { kind: 'NONE' },
  ...overrides,
});

/** A controllable stand-in for Execution: attempts stay open until a test finishes them. */
export class TestExecution {
  readonly started: { readonly spec: AttemptSpec; readonly unitAttemptId: string }[] = [];
  cancels = 0;
  attempts: RunAttempts | undefined;
  #next = 0;

  readonly createAttempt = (spec: AttemptSpec, attempts: RunAttempts): Promise<string> => {
    this.attempts = attempts;
    this.#next += 1;
    const unitAttemptId = `una_exec${String(this.#next).padStart(4, '0')}`;
    attempts.registerAttempt(unitAttemptId, spec.requestId);
    this.started.push({ spec, unitAttemptId });
    return Promise.resolve(unitAttemptId);
  };

  readonly cancelExecutions = (): void => {
    this.cancels += 1;
  };
}

export function testRunWork(host: RunHost, overrides: Partial<RunWorkDeps> = {}): RunWork {
  const execution = new TestExecution();
  return new RunWork({
    host,
    ledgers: new RunLedgers(
      {
        runTokenLimit: minShare(testAgentBudget) * 4,
        turnTokenLimit: minShare(testAgentBudget) * 2,
      },
      testAgentBudget,
    ),
    scheduler: testScheduler(),
    provider: 'deepseek',
    technicalRetryLimit: 1,
    repositoryRoot: '/repository',
    repositoryExclusions: [],
    pinAgent: () => Promise.resolve({ ok: true, agent: testPinnedAgent() }),
    inputIsValid: () => true,
    createAttempt: execution.createAttempt,
    cancelExecutions: execution.cancelExecutions,
    audit: () => undefined,
    now: () => new Date('2026-11-02T00:00:00.000Z'),
    schedule: () => () => undefined,
    ...overrides,
  });
}
