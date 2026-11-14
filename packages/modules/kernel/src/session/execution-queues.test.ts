import { describe, expect, it } from 'vitest';
import {
  AttemptQueues,
  type ConcurrencyClass,
  type QueueEntry,
  type QueueLimits,
} from './execution-queues.js';

const limits: QueueLimits = { maxAttempts: 6, maxExec: 1, maxWeb: 10, serial: false };
let counter = 0;
const entry = (agentRunId: string, cls: ConcurrencyClass): QueueEntry => {
  counter += 1;
  return { seq: counter, agentRunId, cls, state: 'QUEUED' };
};
const ids = (entries: readonly QueueEntry[]) => entries.map((each) => each.seq);

describe('the queue of one AgentRun', () => {
  it('starts neighbouring READs together (P1)', () => {
    const queues = new AttemptQueues();
    const reads = [entry('a', 'READ'), entry('a', 'READ'), entry('a', 'READ'), entry('a', 'READ')];
    for (const each of reads) queues.add(each);
    expect(ids(queues.startable(limits))).toEqual(ids(reads));
  });

  it('holds a barrier back until everything before it has ended, and what follows until it has', () => {
    const queues = new AttemptQueues();
    const [read1, read2, write, read3] = [
      entry('a', 'READ'),
      entry('a', 'READ'),
      entry('a', 'WRITE'),
      entry('a', 'READ'),
    ] as const;
    for (const each of [read1, read2, write, read3]) queues.add(each);
    expect(queues.startable(limits)).toEqual([read1, read2]);
    queues.release(read1);
    expect(queues.startable(limits)).toEqual([]);
    queues.release(read2);
    expect(queues.startable(limits)).toEqual([write]);
    expect(queues.startable(limits)).toEqual([]);
    queues.release(write);
    expect(queues.startable(limits)).toEqual([read3]);
  });

  it('treats EXEC and MODEL as barriers too', () => {
    const queues = new AttemptQueues();
    const [exec, read] = [entry('a', 'EXEC'), entry('a', 'READ')] as const;
    queues.add(exec);
    queues.add(read);
    expect(queues.startable(limits)).toEqual([exec]);
    const second = new AttemptQueues();
    const [model, next] = [entry('a', 'MODEL'), entry('a', 'READ')] as const;
    second.add(model);
    second.add(next);
    expect(second.startable(limits)).toEqual([model]);
  });
});

describe('queues side by side', () => {
  it('runs different AgentRuns together (P2)', () => {
    const queues = new AttemptQueues();
    const [a, b] = [entry('a', 'WRITE'), entry('b', 'WRITE')] as const;
    queues.add(a);
    queues.add(b);
    expect(queues.startable(limits)).toEqual([a, b]);
  });

  it('lets only one EXEC run at a time over all AgentRuns, and the others go on', () => {
    const queues = new AttemptQueues();
    const [execA, execB, readB] = [
      entry('a', 'EXEC'),
      entry('b', 'EXEC'),
      entry('c', 'READ'),
    ] as const;
    for (const each of [execA, execB, readB]) queues.add(each);
    expect(queues.startable(limits)).toEqual([execA, readB]);
    queues.release(execA);
    expect(queues.startable(limits)).toEqual([execB]);
  });

  it('caps the attempts that execute at once, oldest first', () => {
    const queues = new AttemptQueues();
    const all = Array.from({ length: 5 }, (_, index) => entry(`agr_${String(index)}`, 'READ'));
    for (const each of all) queues.add(each);
    const first = queues.startable({ ...limits, maxAttempts: 2 });
    expect(first).toEqual(all.slice(0, 2));
    queues.release(all[0] as QueueEntry);
    expect(queues.startable({ ...limits, maxAttempts: 2 })).toEqual([all[2]]);
  });

  it('runs one attempt at a time and every Unit as a barrier when serial', () => {
    const queues = new AttemptQueues();
    const all = [entry('a', 'READ'), entry('a', 'READ'), entry('b', 'READ')];
    for (const each of all) queues.add(each);
    const serial = { ...limits, serial: true };
    expect(queues.startable(serial)).toEqual([all[0]]);
    expect(queues.startable(serial)).toEqual([]);
    queues.release(all[0] as QueueEntry);
    expect(queues.startable(serial)).toEqual([all[1]]);
  });
});

describe('waiting for a call slot', () => {
  it('stops counting, keeps its place at the head, and resumes when the limits allow', () => {
    const queues = new AttemptQueues();
    const [model, after] = [entry('a', 'MODEL'), entry('a', 'READ')] as const;
    const other = entry('b', 'MODEL');
    for (const each of [model, after, other]) queues.add(each);
    const tight = { ...limits, maxAttempts: 1 };
    expect(queues.startable(tight)).toEqual([model]);
    queues.park(model);
    // It no longer counts, so another AgentRun can use the room; its own queue is still held back.
    expect(queues.startable(tight)).toEqual([other]);
    expect(queues.waiting()).toEqual([model]);
    expect(queues.resume(model, tight)).toBe(false);
    queues.release(other);
    expect(queues.resume(model, tight)).toBe(true);
    expect(queues.startable(tight)).toEqual([]);
    queues.release(model);
    expect(queues.startable(tight)).toEqual([after]);
  });

  it('gives the waiting ones back oldest first', () => {
    const queues = new AttemptQueues();
    const [b, a] = [entry('b', 'MODEL'), entry('a', 'MODEL')] as const;
    queues.add(b);
    queues.add(a);
    queues.startable(limits);
    queues.park(a);
    queues.park(b);
    expect(queues.waiting()).toEqual([b, a]);
  });
});

describe('converging', () => {
  it('takes out what has not started and leaves what runs', () => {
    const queues = new AttemptQueues();
    const [running, queued, other] = [
      entry('a', 'WRITE'),
      entry('a', 'READ'),
      entry('b', 'READ'),
    ] as const;
    for (const each of [running, queued]) queues.add(each);
    queues.startable(limits);
    queues.add(other);
    expect(queues.drainQueued()).toEqual([queued, other]);
    expect(queues.running()).toEqual([running]);
    expect(queues.size()).toBe(1);
  });
});

describe('the web, which has a pool of its own', () => {
  it('starts neighbouring web attempts of one AgentRun together: the web is no barrier', () => {
    const queues = new AttemptQueues();
    const web = [entry('a', 'WEB'), entry('a', 'WEB'), entry('a', 'WEB')];
    for (const each of web) queues.add(each);
    expect(ids(queues.startable(limits))).toEqual(ids(web));
  });

  it('takes no place of the six attempts, and the six take none of the web', () => {
    const queues = new AttemptQueues();
    const models = Array.from({ length: 6 }, (_, index) => entry(`m${String(index)}`, 'MODEL'));
    const web = Array.from({ length: 10 }, (_, index) => entry(`w${String(index)}`, 'WEB'));
    const seventh = entry('m6', 'MODEL');
    for (const each of [...models, ...web, seventh]) queues.add(each);
    const started = queues.startable(limits);
    // Six models and ten web calls run; the seventh model waits for one of the six.
    expect(started).toHaveLength(16);
    expect(started).not.toContain(seventh);
    queues.release(models[0] as QueueEntry);
    expect(queues.startable(limits)).toEqual([seventh]);
  });

  it('lets ten web attempts run and keeps the eleventh waiting, whatever the attempts do', () => {
    const queues = new AttemptQueues();
    const web = Array.from({ length: 11 }, (_, index) => entry(`w${String(index)}`, 'WEB'));
    for (const each of web) queues.add(each);
    const started = queues.startable(limits);
    expect(started).toHaveLength(10);
    expect(started).not.toContain(web[10]);
    queues.release(web[3] as QueueEntry);
    expect(queues.startable(limits)).toEqual([web[10]]);
  });

  it('is held behind a barrier of its own AgentRun, like a read', () => {
    const queues = new AttemptQueues();
    const [model, web] = [entry('a', 'MODEL'), entry('a', 'WEB')] as const;
    queues.add(model);
    queues.add(web);
    expect(queues.startable(limits)).toEqual([model]);
    queues.release(model);
    expect(queues.startable(limits)).toEqual([web]);
  });

  it('counts with the rest when one attempt at a time is asked for', () => {
    const queues = new AttemptQueues();
    const [web, read] = [entry('a', 'WEB'), entry('b', 'READ')] as const;
    queues.add(web);
    queues.add(read);
    expect(queues.startable({ ...limits, serial: true })).toEqual([web]);
    queues.release(web);
    expect(queues.startable({ ...limits, serial: true })).toEqual([read]);
  });
});

describe('the barrier of a checkpoint (Orchestration 7.3)', () => {
  const mutatingAllowed = (held: boolean) => (each: QueueEntry) =>
    !held || (each.cls !== 'WRITE' && each.cls !== 'EXEC');

  it('keeps writes and commands queued while held, and lets reads of every AgentRun go on', () => {
    const queues = new AttemptQueues();
    const [write, readAfter, otherRead, otherExec] = [
      entry('a', 'WRITE'),
      entry('a', 'READ'),
      entry('b', 'READ'),
      entry('c', 'EXEC'),
    ] as const;
    for (const each of [write, readAfter, otherRead, otherExec]) queues.add(each);
    // The write is held, and what stands behind it in its queue waits with it.
    expect(queues.startable(limits, mutatingAllowed(true))).toEqual([otherRead]);
    expect(queues.waitingQueued().map((each) => each.seq)).toEqual(
      [write, readAfter, otherExec].map((each) => each.seq),
    );
    // Released, the held work starts in the order it was made: the write, and the command of
    // another AgentRun beside it.
    expect(queues.startable(limits, mutatingAllowed(false))).toEqual([write, otherExec]);
  });
});

describe('commands side by side, by what they may write (M2Design 7.1, 2026-11-14)', () => {
  const four: QueueLimits = { ...limits, maxExec: 4 };
  const exec = (agentRunId: string, roots?: readonly string[]): QueueEntry => ({
    ...entry(agentRunId, 'EXEC'),
    ...(roots === undefined ? {} : { roots }),
  });

  it('runs commands whose roots do not meet together, up to the limit', () => {
    const queues = new AttemptQueues();
    const commands = [
      exec('a', ['/repo/services/api']),
      exec('b', ['/repo/services/web']),
      exec('c', ['/repo/docs']),
      exec('d', ['/repo/tests']),
      exec('e', ['/repo/tools']),
    ];
    for (const each of commands) queues.add(each);
    expect(ids(queues.startable(four))).toEqual(ids(commands.slice(0, 4)));
    queues.release(commands[0] as QueueEntry);
    expect(ids(queues.startable(four))).toEqual(ids(commands.slice(4)));
  });

  it('holds a command back while another may write the same files, nested roots included', () => {
    const queues = new AttemptQueues();
    const outer = exec('a', ['/repo/services']);
    const inner = exec('b', ['/repo/services/api/']);
    const apart = exec('c', ['/repo/services-old']);
    for (const each of [outer, inner, apart]) queues.add(each);
    expect(queues.startable(four)).toEqual([outer, apart]);
    queues.release(outer);
    expect(queues.startable(four)).toEqual([inner]);
  });

  it('runs a task and the subtask working in what it lent side by side (Orchestration 8.2)', () => {
    // The real case (findex, 2026-11-14): a tester may write tests/ and lent tests/test_query.py
    // to its subtask, which its own commands see read-only; the two tasks' tests ran one after
    // the other for minutes.
    const queues = new AttemptQueues();
    const tester: QueueEntry = {
      ...exec('tester', ['tests']),
      readOnly: ['tests/test_query.py'],
    };
    const writer = exec('writer', ['tests/test_query.py']);
    const other = exec('other', ['tests/support.py']);
    for (const each of [tester, writer, other]) queues.add(each);
    // What the tester may still write (tests/support.py) it shares with `other`, not with `writer`.
    expect(queues.startable(four)).toEqual([tester, writer]);
  });

  it('takes the repository root for every path, less what was lent', () => {
    const queues = new AttemptQueues();
    const root: QueueEntry = { ...exec('root', ['.']), readOnly: ['findex/query.py'] };
    const lent = exec('worker', ['findex/query.py']);
    const notLent = exec('stranger', ['findex/cli.py']);
    for (const each of [root, lent, notLent]) queues.add(each);
    expect(queues.startable(four)).toEqual([root, lent]);
  });

  it('runs a command whose roots are not known alone, as every command ran before', () => {
    const queues = new AttemptQueues();
    const unknown = exec('a');
    const known = exec('b', ['/repo/b']);
    for (const each of [unknown, known]) queues.add(each);
    expect(queues.startable(four)).toEqual([unknown]);
    queues.release(unknown);
    const later = exec('c');
    queues.add(later);
    expect(queues.startable(four)).toEqual([known]);
    queues.release(known);
    expect(queues.startable(four)).toEqual([later]);
  });

  it('keeps one command at a time when the limit is one', () => {
    const queues = new AttemptQueues();
    const commands = [exec('a', ['/repo/a']), exec('b', ['/repo/b'])];
    for (const each of commands) queues.add(each);
    expect(queues.startable(limits)).toEqual([commands[0]]);
  });
});
