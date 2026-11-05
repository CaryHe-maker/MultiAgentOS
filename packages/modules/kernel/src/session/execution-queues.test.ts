import { describe, expect, it } from 'vitest';
import {
  AttemptQueues,
  type ConcurrencyClass,
  type QueueEntry,
  type QueueLimits,
} from './execution-queues.js';

const limits: QueueLimits = { maxAttempts: 6, maxExec: 1, serial: false };
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
