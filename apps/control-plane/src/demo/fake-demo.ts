/**
 * FAKE DEMO, not the product. It runs the real wiring (Fabric, ModuleHost, ArtifactStore,
 * Persistence, the composition root) with every Module and the ExecutorSet replaced by the
 * fakes of `@multiagentos/testing`. Nothing reads the repository and no model is called: the
 * "report" is canned. Run it with `pnpm run demo:fake`.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeTerminal } from '@multiagentos/cli';
import {
  createFakeExecutorRegistry,
  createFakeGateway,
  createFakeKernelCore,
  createFakeSupervisor,
  createFakeUserInteraction,
  createFakeWorkflow,
  type FakeUserInteractionModule,
} from '@multiagentos/testing';
import { composeSystem } from '../bootstrap/compose-system.js';
import { defaultSystemConfig } from '../config/system-config.js';

const terminal = createNodeTerminal();
const dataDir = await mkdtemp(join(tmpdir(), 'multiagentos-fake-demo-'));
let interaction: FakeUserInteractionModule | undefined;

const system = await composeSystem({
  config: { ...defaultSystemConfig(), dataDir },
  terminal,
  credentials: { apiKeyFor: () => undefined },
  parts: {
    createGateway: createFakeGateway(),
    createKernelCore: createFakeKernelCore({ authorization: 'ASK' }),
    createSupervisor: createFakeSupervisor(),
    createWorkflow: createFakeWorkflow(),
    createUserInteraction: (deps) => (interaction = createFakeUserInteraction()(deps)),
    createExecutorRegistry: () => createFakeExecutorRegistry(),
  },
});

terminal.write('FAKE DEMO: canned replies only, no repository is read and no model is called.\n');
await system.start();
const exitCode = await system.userInteraction.analyze({
  goal: process.argv[2] ?? 'Explain the README.',
  repositoryPath: process.cwd(),
  details: false,
});
await system.whenStopped();
terminal.write(`events: ${interaction?.events.map((event) => event.type).join(' -> ') ?? ''}\n`);
terminal.write(`report: ${interaction?.reportText ?? '(none)'}\n`);
terminal.write(`data directory: ${dataDir}\nexit code: ${exitCode}\n`);
process.exitCode = exitCode;
