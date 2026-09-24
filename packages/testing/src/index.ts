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
