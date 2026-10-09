export * from './fixtures/canned.js';
export { FakeCatalogPort } from './fakes/fake-catalog-port.js';
export { createFakeExecutorRegistry } from './fakes/fake-executors.js';
export {
  createFakeGateway,
  createFakeKernelCore,
  createFakeSupervisor,
  type FakeKernelOptions,
} from './fakes/fake-kernel.js';
export { createFakeTerminal } from './fakes/fake-terminal.js';
export {
  createFakeUserInteraction,
  type FakeUserInteractionModule,
  type FakeUserInteractionOptions,
} from './fakes/fake-user-interaction.js';
export { createFakeWorkflow, type FakeWorkflowModule } from './fakes/fake-workflow.js';
export {
  describeCatalogPortContract,
  type CatalogPortContractFixture,
} from './harnesses/catalog-port-contract.js';
export {
  describeExecutorContract,
  type ExecutorContractFixture,
} from './harnesses/executor-contract.js';
