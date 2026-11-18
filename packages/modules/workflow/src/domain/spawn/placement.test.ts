import type { GraphNodeRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { placementOf } from './placement.js';

const agent = { label: 'worker', effort: 'high' as const, writeRoots: ['.'] };
const spawn = {
  writeScope: ['api'],
  inputs: [],
  tokens: 1000,
};
const node = (task?: GraphNodeRecord['spawn']): GraphNodeRecord => ({
  nodeId: 'nod_a',
  path: 'p',
  name: 'fix-api',
  kind: 'AGENT',
  trigger: 'all_success',
  ...(task === undefined ? {} : { spawn: task }),
});
const dispatch = { parentAgentRunId: 'agr_main', delegationId: 'dlg_1' };

describe('placementOf', () => {
  it('takes everything from the Agent for a top-level AgentRun', () => {
    expect(placementOf(node(), agent)).toEqual({
      effort: 'high',
      label: 'worker',
      writeRoots: ['.'],
    });
  });

  it('takes what the task asked for, and names the parent, for a SubAgent', () => {
    expect(placementOf(node({ ...spawn, effort: 'low' }), agent, dispatch)).toEqual({
      effort: 'low',
      label: 'worker fix-api',
      writeRoots: ['api'],
      link: { parentAgentRunId: 'agr_main', delegationId: 'dlg_1', taskName: 'fix-api' },
    });
    expect(placementOf(node(spawn), agent, dispatch).effort).toBe('high');
  });

  it('calls a task that inherits by the Agent its phase names, not by its caller (D35)', () => {
    const inherits = { missionId: 'msc_root', agentRunId: 'agr_root', as: 'worker' };
    const lead = { ...agent, label: 'lead' };
    expect(placementOf(node({ ...spawn, inherits }), lead, dispatch).label).toBe('worker fix-api');
  });
});
