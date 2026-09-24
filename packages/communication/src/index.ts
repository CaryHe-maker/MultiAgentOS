import type {
  CapabilityDescriptor,
  MessageHandler,
  MessageRouterPort,
} from '@multiagentos/contracts';

export class InMemoryMessageRouter implements MessageRouterPort {
  readonly #handlers = new Map<string, MessageHandler<unknown, unknown>>();
  register<TRequest, TResponse>(
    schemaName: string,
    handler: MessageHandler<TRequest, TResponse>,
  ): void {
    if (this.#handlers.has(schemaName))
      throw new Error(`Handler already registered: ${schemaName}`);
    this.#handlers.set(schemaName, handler as MessageHandler<unknown, unknown>);
  }
  async request<TRequest, TResponse>(schemaName: string, request: TRequest): Promise<TResponse> {
    const handler = this.#handlers.get(schemaName);
    if (!handler) throw new Error(`NO_HANDLER: ${schemaName}`);
    return (await handler(request)) as TResponse;
  }
  capabilities(): readonly CapabilityDescriptor[] {
    return Object.freeze([
      {
        capability: 'communication.in-process.request-response',
        status: 'SUPPORTED',
        schemaNames: ['platform.communication.Boundary'],
      },
      {
        capability: 'communication.reliable-delivery',
        status: 'UNSUPPORTED',
        schemaNames: ['platform.communication.Boundary'],
        reason: 'M2+',
      },
      {
        capability: 'communication.consumer-offsets',
        status: 'UNSUPPORTED',
        schemaNames: ['platform.communication.Boundary'],
        reason: 'M2+',
      },
    ]);
  }
}
