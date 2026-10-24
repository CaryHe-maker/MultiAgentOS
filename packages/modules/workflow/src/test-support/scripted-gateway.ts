import type {
  BoundaryContext,
  CloseRunRequest,
  EndAgentRunRequest,
  RegisterAgentRunRequest,
  SubmitUnitRequest,
  SyscallAck,
  SyscallRejected,
  WorkflowGatewayPort,
  WorkflowInboxEvent,
  WorkflowInboxPort,
} from '@multiagentos/contracts';

export type GatewayCall =
  | { readonly kind: 'REGISTER'; readonly request: RegisterAgentRunRequest }
  | { readonly kind: 'SUBMIT'; readonly request: SubmitUnitRequest }
  | { readonly kind: 'END'; readonly request: EndAgentRunRequest }
  | { readonly kind: 'CLOSE'; readonly request: CloseRunRequest };

type Script = (
  call: GatewayCall,
  context: BoundaryContext,
) => Promise<SyscallAck | SyscallRejected>;

/** Scripts may deliver events before Ack to exercise both UnitReport arrival orders. */
export class ScriptedGateway implements WorkflowGatewayPort {
  readonly calls: GatewayCall[] = [];
  readonly contexts: BoundaryContext[] = [];
  readonly scripts: Script[] = [];
  handler: Script | undefined;
  inbox: WorkflowInboxPort | undefined;

  deliver(event: WorkflowInboxEvent): Promise<void> {
    if (this.inbox === undefined) return Promise.reject(new Error('Test Inbox is not connected'));
    return this.inbox.deliver(event);
  }

  private invoke(
    call: GatewayCall,
    context: BoundaryContext,
  ): Promise<SyscallAck | SyscallRejected> {
    this.calls.push(structuredClone(call));
    this.contexts.push(structuredClone(context));
    const script = this.scripts.shift() ?? this.handler;
    return script === undefined
      ? Promise.resolve({
          outcome: 'ACCEPTED',
          requestId: call.request.requestId,
        })
      : script(call, context);
  }

  registerAgentRun(request: RegisterAgentRunRequest, context: BoundaryContext) {
    return this.invoke({ kind: 'REGISTER', request }, context);
  }

  submitUnit(request: SubmitUnitRequest, context: BoundaryContext) {
    return this.invoke({ kind: 'SUBMIT', request }, context);
  }

  endAgentRun(request: EndAgentRunRequest, context: BoundaryContext) {
    return this.invoke({ kind: 'END', request }, context);
  }

  closeRun(request: CloseRunRequest, context: BoundaryContext) {
    return this.invoke({ kind: 'CLOSE', request }, context);
  }
}
