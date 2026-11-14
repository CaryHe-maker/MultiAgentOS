import type { DetachedExit, DetachedProcess, JobEndedFact } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { JobTable } from './job-table.js';

/** A detached command driven by the test: what it prints and how it ends. */
function fakeProcess() {
  let output: ((chunk: Buffer) => void) | undefined;
  let exit: ((exit: DetachedExit) => void) | undefined;
  let stops = 0;
  const process: DetachedProcess = {
    onOutput: (listener) => {
      output = listener;
    },
    onExit: (listener) => {
      exit = listener;
    },
    stop: () => {
      stops += 1;
    },
  };
  return {
    process,
    print: (text: string) => output?.(Buffer.from(text, 'utf8')),
    end: (over: Partial<DetachedExit> = {}) =>
      exit?.({ exitCode: 0, signal: null, stopped: false, unconfirmed: false, ...over }),
    stops: () => stops,
  };
}

const owner = (jobKey: string, workflowRunId = 'wfr_a') => ({
  jobKey,
  sessionId: 'ses_a',
  workflowRunId,
});

function table(options: { keepBytes?: number; jobMaxMs?: number } = {}) {
  const facts: JobEndedFact[] = [];
  const timers: (() => void)[] = [];
  let now = 1000;
  const jobs = new JobTable({
    report: (fact) => {
      facts.push(fact);
      return Promise.resolve();
    },
    jobMaxMs: options.jobMaxMs ?? 60_000,
    ...(options.keepBytes === undefined ? {} : { keepBytes: options.keepBytes }),
    now: () => now,
    schedule: (_ms, run) => {
      timers.push(run);
      return () => undefined;
    },
  });
  return {
    jobs,
    facts,
    fireTimers: () => {
      for (const timer of timers) timer();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the job table of the Supervisor (Orchestration 6.1, 6.2)', () => {
  it('reads what a job printed from an offset, and where the next read starts', () => {
    const { jobs } = table();
    const job = fakeProcess();
    jobs.adopt(owner('exe_one'), job.process, '');
    job.print('hello ');
    job.print('world');
    const first = jobs.control({ workflowRunId: 'wfr_a', jobKey: 'exe_one', action: 'READ' });
    expect(first).toMatchObject({ found: true, text: 'hello world', offset: 0, nextOffset: 11 });
    job.print('!');
    expect(
      jobs.control({ workflowRunId: 'wfr_a', jobKey: 'exe_one', action: 'READ', offset: 11 }),
    ).toMatchObject({ text: '!', nextOffset: 12, totalBytes: 12 });
    expect(
      jobs.control({
        workflowRunId: 'wfr_a',
        jobKey: 'exe_one',
        action: 'READ',
        offset: 0,
        maxBytes: 5,
      }),
    ).toMatchObject({ text: 'hello', nextOffset: 5 });
  });

  it('keeps only the end of a long output and says how much a read skipped', () => {
    const { jobs } = table({ keepBytes: 10 });
    const job = fakeProcess();
    jobs.adopt(owner('exe_long'), job.process, '');
    job.print('0123456789');
    job.print('abcdef');
    const read = jobs.control({ workflowRunId: 'wfr_a', jobKey: 'exe_long', action: 'READ' });
    expect(read).toMatchObject({ text: '6789abcdef', offset: 6, skipped: 6, totalBytes: 16 });
  });

  it('answers not found for a job of another run, and stops a job on request', () => {
    const { jobs } = table();
    const job = fakeProcess();
    jobs.adopt(owner('exe_mine'), job.process, '');
    expect(jobs.control({ workflowRunId: 'wfr_b', jobKey: 'exe_mine', action: 'STOP' })).toEqual({
      found: false,
    });
    expect(job.stops()).toBe(0);
    jobs.control({ workflowRunId: 'wfr_a', jobKey: 'exe_mine', action: 'STOP' });
    expect(job.stops()).toBe(1);
  });

  it('reports the end of a job with how long it ran and the end of its output', () => {
    const { jobs, facts, advance } = table();
    const job = fakeProcess();
    jobs.adopt(owner('exe_end'), job.process, '');
    job.print('x'.repeat(3000));
    job.print('LAST');
    advance(4200);
    job.end({ exitCode: 1 });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      jobKey: 'exe_end',
      exit: { exitCode: 1, stopped: false, timedOut: false },
      durationMs: 4200,
      totalBytes: 3004,
    });
    expect(facts[0]?.tail.endsWith('LAST')).toBe(true);
    expect(Buffer.byteLength(facts[0]?.tail ?? '')).toBe(2048);
    // It stays readable after it ended, with how it ended.
    expect(
      jobs.control({ workflowRunId: 'wfr_a', jobKey: 'exe_end', action: 'READ', offset: 3000 }),
    ).toMatchObject({ text: 'LAST', exit: { exitCode: 1 } });
    expect(jobs.running()).toBe(0);
  });

  it('stops a job at its longest time and marks it timed out', () => {
    const { jobs, facts, fireTimers } = table({ jobMaxMs: 10 });
    const job = fakeProcess();
    jobs.adopt(owner('exe_slow'), job.process, '');
    fireTimers();
    expect(job.stops()).toBe(1);
    job.end({ exitCode: null, signal: 'SIGTERM', stopped: true });
    expect(facts[0]?.exit).toMatchObject({ stopped: true, timedOut: true });
  });

  it('stops every job of a run when the run ends (Orchestration 6.3)', () => {
    const { jobs } = table();
    const one = fakeProcess();
    const two = fakeProcess();
    const other = fakeProcess();
    jobs.adopt(owner('exe_1'), one.process, '');
    jobs.adopt(owner('exe_2'), two.process, '');
    jobs.adopt(owner('exe_3', 'wfr_b'), other.process, '');
    jobs.stopRun('wfr_a');
    expect([one.stops(), two.stops(), other.stops()]).toEqual([1, 1, 0]);
    expect(jobs.running()).toBe(3);
  });
});
