import {
  ContractValidationError,
  createM1ProtocolRegistry,
  type BoundaryContext,
  type GatewayForward,
  type RunCreated,
  type SyscallAck,
  type SyscallRejected,
} from '@multiagentos/contracts';
import { InProcessFabric, SCHEMA_IDS, createInteractionGatewayPort } from '@multiagentos/fabric';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from './index.js';

const context: BoundaryContext = {
  tenantId: 'local',
  projectId: 'local',
  correlationId: 'cor_123456',
};

const registerRequest = {
  requestId: 'req_reg123',
  workflowRunId: 'wfr_123456',
  agentRunId: 'agr_123456',
  agentRef: { kind: 'AGENT' as const, id: 'planner', version: 'v0.1.0', digest: 'a'.repeat(64) },
};

const cancelRequest = { requestId: 'req_cancel1', workflowRunId: 'wfr_123456' };

const ack = (requestId: string): SyscallAck => ({ requestId, outcome: 'ACCEPTED' });

const rejected = (requestId: string, reasonCode: string): SyscallRejected =>
  reasonCode === 'RUN_BLOCKED'
    ? {
        requestId,
        outcome: 'REJECTED',
        issuer: 'GATEWAY',
        reasonCode: 'RUN_BLOCKED',
        closeReason: 'CANCELLED',
      }
    : {
        requestId,
        outcome: 'REJECTED',
        issuer: 'GATEWAY',
        reasonCode: reasonCode as 'INVALID_REQUEST',
      };

interface Harness {
  readonly fabric: InProcessFabric;
  readonly gateway: ReturnType<typeof createGateway>;
}

const running: Harness[] = [];

async function harness(
  respond: (forward: GatewayForward) => SyscallAck | SyscallRejected | RunCreated = (forward) =>
    ack('requestId' in forward.request ? forward.request.requestId : 'req_123456'),
): Promise<Harness> {
  const fabric = new InProcessFabric(createM1ProtocolRegistry());
  await fabric.start();
  fabric.client('kernel-core').register(SCHEMA_IDS.gatewayForward, (envelope) => {
    const forward = envelope.payload as GatewayForward;
    return Promise.resolve(respond(forward));
  });
  const gateway = createGateway({ fabric: fabric.client('gateway') });
  await gateway.start();
  const harness: Harness = { fabric, gateway };
  running.push(harness);
  return harness;
}

function stderrLines(spy: { readonly mock: { readonly calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === 'string')
    .join('')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(async ({ fabric, gateway }) => {
      await gateway.stop();
      await fabric.stop();
    }),
  );
});

describe('Gateway request boundary', () => {
  it('rejects a malformed body with a valid requestId and never forwards it', async () => {
    const { fabric } = await harness();
    const port = createInteractionGatewayPort(fabric.client('user-interaction'));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        port.createRun({ requestId: 'req_123456', goal: '', repositoryPath: '/repo' }, context),
      ).resolves.toEqual({
        requestId: 'req_123456',
        outcome: 'REJECTED',
        issuer: 'GATEWAY',
        reasonCode: 'INVALID_REQUEST',
      });
      const lines = stderrLines(write);
      expect(lines.some((line) => line.includes('"reasonCode":"INVALID_REQUEST"'))).toBe(true);
      await expect(
        port.createRun({ requestId: 'bad', goal: '', repositoryPath: '/repo' }, context),
      ).rejects.toThrow(ContractValidationError);
    } finally {
      write.mockRestore();
    }
  });

  it('logs and rejects a request from the wrong caller', async () => {
    const { fabric } = await harness();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        fabric
          .client('user-interaction')
          .request(SCHEMA_IDS.registerAgentRun, registerRequest, context),
      ).resolves.toEqual(rejected('req_reg123', 'CALLER_FORBIDDEN'));
      const lines = stderrLines(write);
      expect(lines.some((line) => line.includes('"reasonCode":"CALLER_FORBIDDEN"'))).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it('logs and rejects a request for an unknown run', async () => {
    const { fabric } = await harness();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        fabric.client('user-interaction').request(SCHEMA_IDS.cancelRun, cancelRequest, context),
      ).resolves.toEqual(rejected('req_cancel1', 'RUN_NOT_FOUND'));
      const lines = stderrLines(write);
      expect(lines.some((line) => line.includes('"reasonCode":"RUN_NOT_FOUND"'))).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it('blocks new work after the admission projection and never lets it return to RUNNING', async () => {
    let runId = '';
    const { fabric } = await harness((forward) => {
      if (forward.requestType === 'createRun') {
        runId = forward.workflowRunId;
        return {
          requestId: forward.request.requestId,
          outcome: 'ACCEPTED',
          workflowRunId: forward.workflowRunId,
        };
      }
      return ack('requestId' in forward.request ? forward.request.requestId : 'req_123456');
    });
    const port = createInteractionGatewayPort(fabric.client('user-interaction'));
    await port.createRun(
      { requestId: 'req_create1', goal: 'analyze', repositoryPath: '/repo' },
      context,
    );
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await fabric
        .client('kernel-core')
        .send(
          'gateway.admission',
          SCHEMA_IDS.admissionProjection,
          { workflowRunId: runId, runState: 'CONVERGING', closeReason: 'CANCELLED' },
          context,
        );
      await expect(
        fabric
          .client('workflow')
          .request(
            SCHEMA_IDS.registerAgentRun,
            { ...registerRequest, workflowRunId: runId },
            context,
          ),
      ).resolves.toEqual(rejected('req_reg123', 'RUN_BLOCKED'));
      const lines = stderrLines(write);
      expect(lines.some((line) => line.includes('"reasonCode":"RUN_BLOCKED"'))).toBe(true);
      expect(lines.some((line) => line.includes('"closeReason":"CANCELLED"'))).toBe(true);

      await fabric
        .client('kernel-core')
        .send(
          'gateway.admission',
          SCHEMA_IDS.admissionProjection,
          { workflowRunId: runId, runState: 'RUNNING' },
          context,
        );
      await expect(
        fabric
          .client('workflow')
          .request(
            SCHEMA_IDS.registerAgentRun,
            { ...registerRequest, workflowRunId: runId },
            context,
          ),
      ).resolves.toEqual(rejected('req_reg123', 'RUN_BLOCKED'));
    } finally {
      write.mockRestore();
    }
  });

  it('removes a generated admission when createRun is rejected', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let generatedRunId = '';
    const { fabric } = await harness((forward) => {
      if (forward.requestType !== 'createRun') throw new Error('unexpected request');
      generatedRunId = forward.workflowRunId;
      return {
        requestId: forward.request.requestId,
        outcome: 'REJECTED',
        issuer: 'CORE',
        reasonCode: 'REPOSITORY_INVALID',
      };
    });
    const port = createInteractionGatewayPort(fabric.client('user-interaction'));
    await expect(
      port.createRun(
        { requestId: 'req_create1', goal: 'analyze', repositoryPath: '/repo' },
        context,
      ),
    ).resolves.toMatchObject({ reasonCode: 'REPOSITORY_INVALID' });

    await expect(
      fabric
        .client('user-interaction')
        .request(
          SCHEMA_IDS.cancelRun,
          { requestId: 'req_cancel2', workflowRunId: generatedRunId },
          context,
        ),
    ).resolves.toMatchObject({ reasonCode: 'RUN_NOT_FOUND' });
  });

  it('uses the original workflowRunId on a createRun replay and drops the new admission', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let createCalls = 0;
    let firstGeneratedRunId = '';
    let secondGeneratedRunId = '';
    const { fabric } = await harness((forward) => {
      if (forward.requestType !== 'createRun') throw new Error('unexpected request');
      createCalls += 1;
      if (createCalls === 1) firstGeneratedRunId = forward.workflowRunId;
      if (createCalls === 2) secondGeneratedRunId = forward.workflowRunId;
      return {
        requestId: forward.request.requestId,
        outcome: 'ACCEPTED',
        workflowRunId: createCalls === 1 ? forward.workflowRunId : firstGeneratedRunId,
      };
    });
    const port = createInteractionGatewayPort(fabric.client('user-interaction'));
    const request = { requestId: 'req_create1', goal: 'analyze', repositoryPath: '/repo' };
    const first = await port.createRun(request, context);
    const second = await port.createRun(request, context);

    expect(second).toEqual(first);
    expect(secondGeneratedRunId).not.toBe('');
    await expect(
      fabric
        .client('user-interaction')
        .request(
          SCHEMA_IDS.cancelRun,
          { requestId: 'req_cancel3', workflowRunId: secondGeneratedRunId },
          context,
        ),
    ).resolves.toMatchObject({ reasonCode: 'RUN_NOT_FOUND' });
  });
});
