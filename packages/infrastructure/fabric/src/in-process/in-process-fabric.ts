import {
  assertValid,
  newId,
  type BoundaryContext,
  type CapabilityDescriptor,
  type Envelope,
  type FabricAddress,
  type FabricPort,
  type HealthStatus,
  type LifecyclePort,
  type MessageType,
  type Producer,
  type ProtocolRegistry,
} from '@multiagentos/contracts';

/** A message could not be routed. Schema violations throw ContractValidationError instead. */
export class FabricError extends Error {
  public constructor(
    public readonly code: 'NO_HANDLER' | 'NO_SUBSCRIBER' | 'ALREADY_REGISTERED' | 'NOT_RUNNING',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'FabricError';
  }
}

type RequestHandler = (envelope: Envelope<unknown>) => Promise<unknown>;
type MessageHandler = (envelope: Envelope<unknown>) => Promise<void>;

/**
 * Same-process Fabric (docs/M1/Infrastructure/Fabric.md 3). Every communication subject gets
 * its own client, which fixes the Envelope's producer. Each delivery validates the payload
 * against its registered Schema and copies it with `structuredClone`, so object references,
 * functions and class instances cannot cross a subject boundary unnoticed.
 */
export class InProcessFabric implements LifecyclePort {
  readonly manifest = { moduleId: 'fabric', version: '0.1.0', dependencies: [] } as const;
  readonly #registry: ProtocolRegistry;
  readonly #now: () => Date;
  readonly #handlers = new Map<string, RequestHandler>();
  readonly #subscribers = new Map<FabricAddress, MessageHandler>();
  #running = false;

  public constructor(registry: ProtocolRegistry, now: () => Date = () => new Date()) {
    this.#registry = registry;
    this.#now = now;
  }

  start(): Promise<void> {
    this.#running = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.#running = false;
    return Promise.resolve();
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({
      status: this.#running ? 'UP' : 'DOWN',
      checkedAt: this.#now().toISOString(),
      details: [],
    });
  }

  /** The composition root calls this once per subject and hands the client to that subject. */
  client(producer: Producer): FabricPort {
    return {
      register: (schemaId, handler) => {
        this.#registry.get(schemaId);
        if (this.#handlers.has(schemaId)) throw new FabricError('ALREADY_REGISTERED', schemaId);
        this.#handlers.set(schemaId, handler as RequestHandler);
      },
      request: async <TRequest, TResponse>(
        schemaId: string,
        payload: TRequest,
        context: BoundaryContext,
      ) => {
        const envelope = this.#envelope(producer, 'command', schemaId, payload, context);
        const handler = this.#handlers.get(schemaId);
        if (handler === undefined) throw new FabricError('NO_HANDLER', schemaId);
        return structuredClone(await handler(envelope)) as TResponse;
      },
      send: async (address, schemaId, payload, context) => {
        const envelope = this.#envelope(producer, 'event', schemaId, payload, context);
        const subscriber = this.#subscribers.get(address);
        if (subscriber === undefined) throw new FabricError('NO_SUBSCRIBER', address);
        await subscriber(envelope);
      },
      subscribe: (address, handler) => {
        if (this.#subscribers.has(address)) throw new FabricError('ALREADY_REGISTERED', address);
        this.#subscribers.set(address, handler as MessageHandler);
      },
      capabilities: () => FABRIC_CAPABILITIES,
    };
  }

  #envelope(
    producer: Producer,
    messageType: MessageType,
    schemaId: string,
    payload: unknown,
    context: BoundaryContext,
  ): Envelope<unknown> {
    if (!this.#running) throw new FabricError('NOT_RUNNING', schemaId);
    const entry = this.#registry.get(schemaId);
    return {
      schemaName: entry.schemaName,
      schemaVersion: entry.major,
      messageType,
      messageId: newId('msg'),
      producer,
      occurredAt: this.#now().toISOString(),
      tenantId: context.tenantId,
      projectId: context.projectId,
      correlationId: context.correlationId,
      ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
      ...(context.workflowRunId === undefined ? {} : { workflowRunId: context.workflowRunId }),
      payload: structuredClone(assertValid(entry.schema, payload)),
    };
  }
}

const FABRIC_CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  { capability: 'fabric.in-process-routing', status: 'SUPPORTED', schemaNames: [] },
  {
    capability: 'fabric.cross-process',
    status: 'UNSUPPORTED',
    schemaNames: [],
    reason: 'M1 runs every communication subject in one process',
  },
  {
    capability: 'fabric.durable-delivery',
    status: 'UNSUPPORTED',
    schemaNames: ['platform.fabric.ConsumerOffsetRef.v0'],
    reason: 'the M1 Outbox and Inbox live in memory',
  },
]);
