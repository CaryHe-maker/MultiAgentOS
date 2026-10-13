import { MEDIA_TYPES, validate, RunSummarySchema, type RunSummary } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { finalizeRunEvents } from './finalize-run.js';

const summary: RunSummary = {
  workflowRunId: 'wfr_123456',
  closeReason: 'CANCELLED',
  startedAt: '2026-10-10T00:00:00.000Z',
  closedAt: '2026-10-10T00:00:01.000Z',
  durationMs: 1_000,
  agentRuns: [],
  units: { submitted: 0, ok: 0, rejected: 0, failed: 0, notDelivered: 0 },
  model: { requests: 0, finalCallUsed: false },
  tokens: {
    limit: 100_000,
    used: 0,
    unknown: 0,
    inputTokens: 0,
    outputTokens: 0,
    finalBudgetState: 'NORMAL',
  },
  unknownEffects: [],
};
const sha = 'a'.repeat(64);
const ref = { artifactId: `art_${sha}`, sha256: sha, size: 1, mediaType: MEDIA_TYPES.runSummary };

describe('terminal event construction', () => {
  it('delivers matching events when the summary is written', async () => {
    expect(validate(RunSummarySchema, summary).ok).toBe(true);
    const result = await finalizeRunEvents(summary, () => Promise.resolve(ref));
    expect(result.workflow).toMatchObject({
      type: 'RunClosed',
      closeReason: 'CANCELLED',
      runSummaryRef: ref,
    });
    expect(result.interaction).toMatchObject({
      type: 'RunFinished',
      closeReason: 'CANCELLED',
      runSummaryRef: ref,
    });
    expect(result.publishError).toBeUndefined();
  });

  it('reports a failed summary write without a fake reference or losing a violation', async () => {
    const violation: RunSummary = {
      ...summary,
      closeReason: 'VIOLATION',
      failure: { code: 'PATH_ESCAPE', category: 'INTEGRITY', source: 'KERNEL' },
    };
    const failure = new Error('disk is full');
    const result = await finalizeRunEvents(violation, () => Promise.reject(failure));
    expect(result.publishError).toBe(failure);
    expect(result.workflow).toMatchObject({
      type: 'RunClosed',
      closeReason: 'VIOLATION',
      finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
    });
    expect(result.interaction).toMatchObject({
      type: 'RunFinished',
      closeReason: 'VIOLATION',
      finalizationError: 'RUN_SUMMARY_WRITE_FAILED',
    });
    expect('runSummaryRef' in result.workflow).toBe(false);
  });
});
