import type {
  BoundaryContext,
  ContextPack,
  ContextPort,
  ContextRequest,
  KernelUnitPort,
  UnitIntent,
  UnitResult,
} from '@multiagentos/contracts';

export class FakeContextPort implements ContextPort {
  public constructor(private readonly response: ContextPack) {}
  buildContext(request: ContextRequest, context: BoundaryContext): Promise<ContextPack> {
    void request;
    void context;
    return Promise.resolve(this.response);
  }
}

export class RecordingKernelUnitPort implements KernelUnitPort {
  readonly intents: UnitIntent[] = [];
  public constructor(private readonly responder: (intent: UnitIntent) => UnitResult) {}
  execute(intent: UnitIntent, context: BoundaryContext): Promise<UnitResult> {
    void context;
    this.intents.push(intent);
    return Promise.resolve(this.responder(intent));
  }
}
export * from './eval-fixtures/eval-task-schema.js';
export {
  checkTaskRules,
  checkTaskSetRules,
  isExcludedByContext,
  type FixtureIssue,
  type FixtureIssueSeverity,
  type LoadedEvalTask,
} from './eval-fixtures/eval-task-rules.js';
export {
  DEFAULT_EVAL_FIXTURES_DIRECTORY,
  loadEvalFixtures,
  type EvalFixtureSet,
} from './eval-fixtures/load-eval-fixtures.js';
export { type LoadedWebSnapshot } from './eval-fixtures/web-snapshot-rules.js';
export {
  GitCliRepositoryReader,
  MAX_EVIDENCE_FILE_BYTES,
  checkRepositoryEvidence,
  countLines,
  type GitCliRepositoryReaderOptions,
  type RepositoryReader,
} from './eval-fixtures/check-repository-evidence.js';
