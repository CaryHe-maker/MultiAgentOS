import {
  ContractValidationError,
  createM1ProtocolRegistry,
  type BoundaryContext,
  type GatewayForward,
} from '@multiagentos/contracts';
import { InProcessFabric, SCHEMA_IDS, createInteractionGatewayPort } from '@multiagentos/fabric';
import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './index.js';

const context: BoundaryContext = {
  tenantId: 'local',
  projectId: 'local',
  correlationId: 'cor_123456',
};

describe('Gateway request boundary', () => {
  it('rejects a malformed body with a valid requestId and never forwards it', async () => {
    const fabric = new InProcessFabric(createM1ProtocolRegistry());
    await fabric.start();
    const forward = vi.fn<(request: GatewayForward) => void>();
    fabric.client('kernel-core').register(SCHEMA_IDS.gatewayForward, (envelope) => {
      forward(envelope.payload as GatewayForward);
      return Promise.resolve({ requestId: 'req_123456', outcome: 'ACCEPTED' });
    });
    const gateway = createGateway({ fabric: fabric.client('gateway') });
    await gateway.start();
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
      expect(forward).not.toHaveBeenCalled();
      await expect(
        port.createRun({ requestId: 'bad', goal: '', repositoryPath: '/repo' }, context),
      ).rejects.toThrow(ContractValidationError);
    } finally {
      write.mockRestore();
    }
    await gateway.stop();
    await fabric.stop();
  });
});
