import { describe, expect, it } from 'vitest';
import { shapeOf } from './orchestration-shape.js';

let seq = 0;
const at = <T extends Record<string, unknown>>(record: T) => ({ seq: (seq += 1), ...record });

/** main starts a fix-verify subMission and a worker; the sub-root runs the check, then a fixer. */
function log(options: { readonly subRootWrites: boolean; readonly checkFirst: boolean }) {
  seq = 0;
  const call = (run: string, tool: string, id: string) =>
    at({ type: 'MODEL_TURN', agentRunId: run, toolCalls: [{ toolName: tool, toolCallId: id }] });
  const unit = (id: string, changed?: string[]) => [
    at({
      type: 'UNIT_SUBMITTED',
      requestId: `req_${id}`,
      inputSource: { kind: 'TOOL_CALL', toolCallId: id },
    }),
    at({
      type: 'UNIT_COMPLETED',
      requestId: `req_${id}`,
      status: 'OK',
      ...(changed === undefined ? {} : { changedFiles: changed }),
    }),
  ];
  return [
    at({
      type: 'AGENT_RUN_REGISTERED',
      agentRunId: 'run_main',
      agentRef: { id: 'main' },
      missionId: 'm_root',
    }),
    call('run_main', 'read_file', 'c1'),
    ...unit('c1'),
    call('run_main', 'sub_mission', 'c2'),
    call('run_main', 'run_subagents', 'c3'),
    at({
      type: 'GRAPH_EXTENDED',
      source: 'SPAWN',
      nodes: [
        {
          name: 'fix',
          agentRef: { id: 'lead' },
          mission: { id: 'm_fix', parentId: 'm_root' },
          spawn: {
            submission: {
              template: { id: 'fix-verify' },
              params: { check: 'make test', maxRounds: '1' },
            },
          },
        },
        {
          name: 'feature',
          agentRef: { id: 'worker' },
          mission: { id: 'm_feature', parentId: 'm_root' },
        },
      ],
    }),
    at({
      type: 'AGENT_RUN_REGISTERED',
      agentRunId: 'run_fix',
      agentRef: { id: 'lead' },
      missionId: 'm_fix',
      parentAgentRunId: 'run_main',
    }),
    ...(options.checkFirst ? [call('run_fix', 'run_command', 'c4'), ...unit('c4')] : []),
    ...(options.subRootWrites
      ? [call('run_fix', 'run_command', 'c5'), ...unit('c5', ['src/a.py'])]
      : []),
    at({ type: 'FEEDBACK', agentRunId: 'run_fix', code: 'PLAYBOOK' }),
    at({
      type: 'GRAPH_EXTENDED',
      source: 'SPAWN',
      nodes: [
        {
          name: 'fixer',
          agentRef: { id: 'worker' },
          mission: { id: 'm_fixer', parentId: 'm_fix' },
        },
      ],
    }),
    at({ type: 'MISSION_ENDED', missionId: 'm_fixer', status: 'SUCCEEDED' }),
    call('run_fix', 'run_command', 'c6'),
    ...unit('c6'),
    at({ type: 'MISSION_ENDED', missionId: 'm_fix', status: 'SUCCEEDED' }),
    at({ type: 'MISSION_ENDED', missionId: 'm_feature', status: 'SUCCEEDED' }),
    call('run_main', 'write_file', 'c7'),
    ...unit('c7', ['README.md']),
  ];
}

describe('the shape of a mission run', () => {
  it('counts what root started and did, and a subMission that kept to its playbook', () => {
    const shape = shapeOf(log({ subRootWrites: false, checkFirst: true }));
    expect(shape.rootMissionId).toBe('m_root');
    expect(shape.subMissionCalls).toBe(1);
    expect(shape.runSubagentsCalls).toBe(1);
    expect(shape.tasksByAgent).toEqual({ lead: 1, worker: 2 });
    expect(shape.rootWrites).toBe(1);
    expect(shape.depth).toBe(2);
    expect(
      shape.tasks.map((task) => [task.name, task.agent, task.parent, task.template, task.inside]),
    ).toEqual([
      ['root', 'main', undefined, undefined, undefined],
      ['fix', 'lead', 'root', 'fix-verify', undefined],
      ['feature', 'worker', 'root', undefined, undefined],
      ['fixer', 'worker', 'fix', undefined, 'fix-verify'],
    ]);
    expect(shape.tasks[0]).toEqual(
      expect.objectContaining({
        segments: 1,
        modelRequests: 4,
        tools: { read_file: 1, sub_mission: 1, run_subagents: 1, write_file: 1 },
        changedFiles: 1,
      }),
    );
    expect(shape.tasks[1]).toEqual(
      expect.objectContaining({
        status: 'SUCCEEDED',
        tools: { run_command: 2 },
        feedback: { PLAYBOOK: 1 },
      }),
    );
    expect(shape.subMissions).toEqual([
      expect.objectContaining({
        template: 'fix-verify',
        status: 'SUCCEEDED',
        children: [{ agent: 'worker', status: 'SUCCEEDED' }],
        sentBack: { PLAYBOOK: 1 },
        ownWrites: 0,
        ownCommands: 2,
        violations: [],
      }),
    ]);
  });

  it('finds a sub-root that changed files through a command and skipped the first check', () => {
    const [sub] = shapeOf(log({ subRootWrites: true, checkFirst: false })).subMissions;
    expect(sub?.ownChangedFiles).toEqual(['src/a.py']);
    expect(sub?.violations).toEqual(['changed files itself (1 calls)']);
    const [skipped] = shapeOf(log({ subRootWrites: false, checkFirst: false })).subMissions;
    expect(skipped?.violations).toEqual(['did not run the check before the first fix']);
  });
});
