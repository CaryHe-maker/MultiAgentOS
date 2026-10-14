import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserInteraction } from '@multiagentos/user-interaction';
import type { TerminalPort } from '@multiagentos/user-interaction';
import {
  createFakeExecutorRegistry,
  createFakeGateway,
  createFakeKernelCore,
  createFakeSupervisor,
  createFakeWorkflow,
} from '@multiagentos/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSystemConfig } from '../config/system-config.js';
import { composeSystem } from './compose-system.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Product interaction to composition root fault closure', () => {
  it.each(['CANCEL', 'SHUTDOWN', 'TIMEOUT_SHUTDOWN'] as const)(
    'closes every module when %s is unexpectedly rejected',
    async (operation) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-interaction-'));
      roots.push(dataDir);
      let interrupt: () => void = () => {};
      let cancelCalls = 0;
      let shutdownCalls = 0;
      const terminal: TerminalPort = {
        write: () => {},
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => {};
        },
        askYesNo: (_question, signal) => {
          if (operation === 'CANCEL') {
            queueMicrotask(interrupt);
            return new Promise((resolve) => {
              signal.addEventListener('abort', () => resolve(undefined), { once: true });
            });
          }
          return Promise.resolve('YES');
        },
      };
      const system = await composeSystem({
        config: { ...defaultSystemConfig(), dataDir },
        terminal,
        credentials: { apiKeyFor: () => undefined },
        log: () => {},
        parts: {
          createKernelCore: createFakeKernelCore({
            authorization: 'ASK',
            ...(operation === 'TIMEOUT_SHUTDOWN'
              ? {
                  unitScript: () => ({ end: 'RUN_TIMEOUT' as const }),
                }
              : {}),
          }),
          createGateway: createFakeGateway(),
          createWorkflow: createFakeWorkflow(),
          createSupervisor: createFakeSupervisor(),
          createExecutorRegistry: () => createFakeExecutorRegistry(),
          createUserInteraction: (deps) =>
            createUserInteraction({
              ...deps,
              gateway: {
                ...deps.gateway,
                cancelRun: (request) => {
                  cancelCalls++;
                  return Promise.resolve({
                    requestId: request.requestId,
                    outcome: 'REJECTED',
                    issuer: 'CORE',
                    reasonCode: 'RUN_NOT_FOUND',
                  });
                },
                shutdown: (request, context) => {
                  shutdownCalls++;
                  return operation !== 'CANCEL'
                    ? Promise.resolve({
                        requestId: request.requestId,
                        outcome: 'REJECTED',
                        issuer: 'GATEWAY',
                        reasonCode: 'CALLER_FORBIDDEN',
                      })
                    : deps.gateway.shutdown(request, context);
                },
              },
            }),
        },
      });
      await system.start();
      const code = await system.run((interaction) =>
        interaction.analyze({
          goal: '分析仓库',
          repositoryPath: tmpdir(),
          details: false,
        }),
      );
      expect(code).toBe(operation === 'TIMEOUT_SHUTDOWN' ? 2 : 70);
      const report = await system.shutdown();
      expect(report.faults.length).toBeGreaterThan(0);
      expect(new Set(report.modules.map((entry) => entry.state))).toEqual(new Set(['STOPPED']));
      expect(cancelCalls).toBe(operation === 'CANCEL' ? 1 : 0);
      expect(shutdownCalls).toBe(operation !== 'CANCEL' ? 1 : 0);
    },
  );
});
