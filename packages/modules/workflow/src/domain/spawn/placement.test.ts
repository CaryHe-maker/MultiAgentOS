import type { GraphNodeRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { placementOf } from './placement.js';

const agent = { label: 'worker', effort: 'high' as const, writeRoots: ['.'] };
const node = (spawn?: GraphNodeRecord['spawn']): GraphNodeRecord => ({
  nodeId: 'nod_a',
  path: 'p',
  name: 'fix-api',
  kind: 'AGENT',
  trigger: 'all_success',
  iteration: 1,
  ...(spawn === undefined ? {} : { spawn }),
});

describe('placementOf', () => {
  it('takes everything from the Agent for a top-level AgentRun', () => {
    expect(placementOf(node(), agent)).toEqual({
      effort: 'high',
      label: 'worker',
      writeRoots: ['.'],
    });
  });

  it('takes what the task asked for, and names the parent, for a SubAgent', () => {
    const spawn = {
      parentAgentRunId: 'agr_main',
      delegationId: 'dlg_1',
      callToolCallId: 'call_1',
      writeScope: ['api'],
      acceptance: [],
      inputs: [],
      tokens: 1000,
    };
    expect(placementOf(node({ ...spawn, effort: 'low' }), agent)).toEqual({
      effort: 'low',
      label: 'worker fix-api',
      writeRoots: ['api'],
      link: { parentAgentRunId: 'agr_main', delegationId: 'dlg_1', taskName: 'fix-api' },
    });
    expect(placementOf(node(spawn), agent).effort).toBe('high');
  });
});
