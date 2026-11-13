import type { Playbook, SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { playbookRefusal, playbookUnfinished, renderPlaybook } from './playbook.js';

const playbook: Playbook = {
  summary: 'explore, build, check',
  params: [{ name: 'check', description: 'the check', required: true }],
  phases: [
    {
      name: 'explore',
      instructions: 'look',
      tasks: { agent: 'explorer', min: 1, max: 2 },
      optional: true,
    },
    { name: 'build', instructions: 'build', tasks: { agent: 'worker', min: 1, max: 1 }, repeat: 2 },
    { name: 'review', instructions: 'review', tasks: { agent: 'explorer', min: 1, max: 1 } },
    { name: 'report', instructions: 'report' },
  ],
  example: 'an example',
};
const submission = {
  template: { id: 'demo', version: 'v0.1.0' },
  playbook,
  params: { check: 'make test' },
};
const root = 'msc_root';
let seq = 0;
let calls = 0;

/** The log after the root's calls, each a list of the Agents of its tasks, and which ended. */
function logOf(made: readonly (readonly string[])[], ended = true): SessionLogRecord[] {
  seq = 0;
  const records: unknown[] = [
    {
      seq: (seq += 1),
      type: 'GRAPH_EXTENDED',
      source: 'SPAWN',
      nodes: [{ nodeId: 'nod_root', name: 'root', kind: 'AGENT', mission: { id: root } }],
      edges: [],
    },
  ];
  for (const agents of made) {
    calls += 1;
    const toolCallId = `call_${String(calls)}`;
    const nodes = agents.map((agent, index) => ({
      nodeId: `nod_${toolCallId}_${String(index)}`,
      name: `${agent}${String(index)}`,
      kind: 'AGENT',
      agentRef: { id: agent },
      mission: { id: `msc_${toolCallId}_${String(index)}`, parentId: root },
    }));
    records.push({
      seq: (seq += 1),
      type: 'GRAPH_EXTENDED',
      source: 'SPAWN',
      nodes,
      edges: nodes.map((node) => ({
        from: 'nod_root',
        to: node.nodeId,
        kind: 'DELEGATE',
        call: { toolCallId },
      })),
    });
    if (ended)
      for (const node of nodes)
        records.push({
          seq: (seq += 1),
          type: 'MISSION_ENDED',
          missionId: node.mission.id,
          status: 'SUCCEEDED',
        });
  }
  return records as SessionLogRecord[];
}
const tasks = (...agents: string[]) => agents.map((agent) => ({ agent }));

describe('the playbook of a subMission (Orchestration 3.9)', () => {
  it('lets the phases come in order, passes over an optional one, and repeats within its bound', () => {
    expect(
      playbookRefusal(logOf([]), root, submission, tasks('explorer', 'explorer')),
    ).toBeUndefined();
    // The optional phase passed over: the build may be the first call.
    expect(playbookRefusal(logOf([]), root, submission, tasks('worker'))).toBeUndefined();
    expect(playbookRefusal(logOf([['worker']]), root, submission, tasks('worker'))).toBeUndefined();
    expect(
      playbookRefusal(logOf([['worker'], ['worker']]), root, submission, tasks('worker')),
    ).toContain('does not follow your playbook');
    expect(
      playbookRefusal(logOf([['worker'], ['worker']]), root, submission, tasks('explorer')),
    ).toBeUndefined();
  });

  it('refuses tasks out of order, of two Agents at once, in a wrong number, or before the earlier ended', () => {
    const refused = playbookRefusal(
      logOf([]),
      root,
      submission,
      tasks('explorer', 'explorer', 'explorer'),
    );
    expect(refused).toContain('explore: 1-2 explorer task(s)');
    expect(playbookRefusal(logOf([]), root, submission, tasks('worker', 'explorer'))).toContain(
      'one Agent only',
    );
    expect(
      playbookRefusal(logOf([['worker']], false), root, submission, tasks('explorer')),
    ).toContain('have not all ended');
    expect(
      playbookRefusal(logOf([['worker'], ['explorer']]), root, submission, tasks('explorer')),
    ).toContain('every phase of your playbook that has tasks has run');
  });

  it('is done only when every phase that is not optional has run', () => {
    expect(playbookUnfinished(logOf([['worker']]), root, submission)).toEqual(['review']);
    expect(playbookUnfinished(logOf([['worker'], ['explorer']]), root, submission)).toEqual([]);
  });

  it('is read by its root in words, with its parameters and its example', () => {
    const text = renderPlaybook(submission);
    expect(text).toContain('template demo (explore, build, check)');
    expect(text).toContain('- check: make test');
    expect(text).toContain(
      '2. build (one run_subagents call of 1 worker task(s); it may run up to 2 times in all)',
    );
    expect(text).toContain('An example of a good plan with this playbook:\nan example');
  });
});
