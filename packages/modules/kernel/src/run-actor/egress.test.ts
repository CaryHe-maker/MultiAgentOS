import type {
  AdmissionProjection,
  ExecutionRequest,
  InteractionInboxEvent,
  SupervisorPort,
  WorkflowInboxEvent,
  WorkflowInboxPort,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import type { CoreEvent } from '../core/index.js';
import { RunEgress } from './egress.js';

const ref = {
  artifactId: `art_${'a'.repeat(64)}`,
  sha256: 'a'.repeat(64),
  size: 1,
  mediaType: 'application/vnd.multiagentos.analysis-report+json',
};

const request = {
  workflowRunId: 'wfr_123456',
  unitAttemptId: 'una_123456',
  executionId: 'exe_123456',
  runEpoch: 1,
} as ExecutionRequest;

const cancel = { workflowRunId: 'wfr_123456', runEpoch: 2 };
const admission: AdmissionProjection = {
  workflowRunId: 'wfr_123456',
  runState: 'CONVERGING',
  closeReason: 'COMPLETED',
};

function runStart(): CoreEvent {
  return { type: 'RunStart', goal: 'analyze' };
}

function runClosed(): CoreEvent {
  return {
    type: 'RunClosed',
    closeReason: 'COMPLETED',
    reportRef: ref,
    unknownEffects: [],
    runSummaryRef: ref,
  };
}

function runFinished(): CoreEvent {
  return {
    type: 'RunFinished',
    closeReason: 'COMPLETED',
    reportRef: ref,
    unknownEffects: [],
    runSummaryRef: ref,
  };
}

describe('RunEgress', () => {
  it('queues events and sends them in target order only after flush', async () => {
    const supervisorCalls: string[] = [];
    const admissions: AdmissionProjection[] = [];
    const workflow: WorkflowInboxEvent[] = [];
    const interaction: InteractionInboxEvent[] = [];
    let eventSequence = 0;
    const supervisor: SupervisorPort = {
      execute: (value) => {
        supervisorCalls.push(`execute:${value.executionId}`);
        return Promise.resolve();
      },
      cancelRun: (value) => {
        supervisorCalls.push(`cancel:${value.workflowRunId}`);
        return Promise.resolve();
      },
      shutdown: () => Promise.resolve(),
    };
    const workflowInbox: WorkflowInboxPort = {
      deliver: (event) => {
        workflow.push(event);
        return Promise.resolve();
      },
    };
    const egress = new RunEgress({
      workflowRunId: 'wfr_123456',
      supervisor,
      gatewayAdmission: (projection) => {
        admissions.push(projection);
        return Promise.resolve();
      },
      workflowInbox,
      interactionInbox: {
        deliver: (event) => {
          interaction.push(event);
          return Promise.resolve();
        },
      },
      now: () => new Date('2026-10-21T00:00:01.000Z'),
      newEventId: () => `evt_${String((eventSequence += 1)).padStart(6, '0')}`,
    });

    egress.emit(runStart());
    egress.dispatch(request);
    await egress.cancelRun(cancel);
    egress.admission(admission);
    egress.emit(runClosed());
    egress.emit(runFinished());

    expect(supervisorCalls).toEqual([]);
    expect(admissions).toEqual([]);
    expect(workflow).toEqual([]);
    expect(interaction).toEqual([]);

    egress.flush();
    await egress.drain();

    expect(supervisorCalls).toEqual(['execute:exe_123456', 'cancel:wfr_123456']);
    expect(admissions).toEqual([admission]);
    expect(workflow.map((event) => event.event.type)).toEqual(['RunStart', 'RunClosed']);
    expect(interaction.map((event) => event.event.type)).toEqual(['RunFinished']);
    expect(workflow.map((event) => event.seq)).toEqual([1, 2]);
    expect(interaction[0]?.seq).toBe(1);
    expect(new Set([...workflow, ...interaction].map((event) => event.eventId)).size).toBe(3);
    expect(workflow[0]?.occurredAt).toBe('2026-10-21T00:00:01.000Z');
  });

  it('reports a send failure without throwing from the sender observer', async () => {
    const failures: string[] = [];
    const egress = new RunEgress({
      workflowRunId: 'wfr_123456',
      supervisor: {
        execute: () => Promise.reject(new Error('not running')),
        cancelRun: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      gatewayAdmission: () => Promise.resolve(),
      workflowInbox: { deliver: () => Promise.resolve() },
      interactionInbox: { deliver: () => Promise.resolve() },
      onFailure: (failure) => failures.push(failure.target),
    });

    egress.dispatch(request);
    await egress.drain();

    expect(failures).toEqual(['supervisor']);
  });
});
