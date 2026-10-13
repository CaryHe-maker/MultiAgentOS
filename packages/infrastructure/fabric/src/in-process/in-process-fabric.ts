import {
  assertValid,
  BoundaryContextSchema,
  ContractValidationError,
  IdSchemas,
  newId,
  validate,
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
import { SCHEMA_IDS } from '../stubs/port-stubs.js';

/** A message could not be routed. Schema violations throw ContractValidationError instead. */
export class FabricError extends Error {
  public constructor(
    public readonly code:
      | 'NO_HANDLER'
      | 'NO_SUBSCRIBER'
      | 'ALREADY_REGISTERED'
      | 'INVALID_REGISTRATION'
      | 'NOT_RUNNING',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'FabricError';
  }
}

type RequestHandler = (envelope: Envelope<unknown>) => Promise<unknown>;
type MessageHandler = (envelope: Envelope<unknown>) => Promise<void>;
interface RegisteredHandler {
  readonly handle: RequestHandler;
  readonly onInvalid?: (
    envelope: Envelope<unknown>,
    error: ContractValidationError,
  ) => Promise<unknown>;
}

const GATEWAY_REQUEST_SCHEMAS = new Set<string>([
  SCHEMA_IDS.registerAgentRun,
  SCHEMA_IDS.submitUnit,
  SCHEMA_IDS.endAgentRun,
  SCHEMA_IDS.closeRun,
  SCHEMA_IDS.createRun,
  SCHEMA_IDS.answerAuthorization,
  SCHEMA_IDS.cancelRun,
  SCHEMA_IDS.readArtifact,
  SCHEMA_IDS.shutdown,
]);

function hasValidRequestId(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, 'requestId') &&
    validate(IdSchemas.requestId, (payload as { readonly requestId: unknown }).requestId).ok
  );
}

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
  readonly #handlers = new Map<string, RegisteredHandler>();
  readonly #subscribers = new Map<FabricAddress, MessageHandler>();
  readonly #addressTails = new Map<FabricAddress, Promise<void>>();
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
      register: (schemaId, handler, onInvalid) => {
        this.#registry.get(schemaId);
        if (this.#handlers.has(schemaId)) throw new FabricError('ALREADY_REGISTERED', schemaId);
        if (
          onInvalid !== undefined &&
          (producer !== 'gateway' || !GATEWAY_REQUEST_SCHEMAS.has(schemaId))
        )
          throw new FabricError('INVALID_REGISTRATION', schemaId);
        this.#handlers.set(schemaId, {
          handle: handler as RequestHandler,
          ...(onInvalid === undefined ? {} : { onInvalid }),
        });
      },
      request: async <TRequest, TResponse>(
        schemaId: string,
        payload: TRequest,
        context: BoundaryContext,
      ) => {
        // A bad transport context is never a malformed Gateway syscall body.
        assertValid(BoundaryContextSchema, context);
        const handler = this.#handlers.get(schemaId);
        let envelope: Envelope<unknown>;
        try {
          envelope = this.#envelope(producer, 'command', schemaId, payload, context);
        } catch (error) {
          if (
            !(error instanceof ContractValidationError) ||
            handler?.onInvalid === undefined ||
            !hasValidRequestId(payload)
          )
            throw error;
          const malformed = this.#envelope(producer, 'command', schemaId, payload, context, false);
          return structuredClone(await handler.onInvalid(malformed, error)) as TResponse;
        }
        if (handler === undefined) throw new FabricError('NO_HANDLER', schemaId);
        return structuredClone(await handler.handle(envelope)) as TResponse;
      },
      send: async (address, schemaId, payload, context) => {
        const envelope = this.#envelope(producer, 'event', schemaId, payload, context);
        const subscriber = this.#subscribers.get(address);
        if (subscriber === undefined) throw new FabricError('NO_SUBSCRIBER', address);
        const previous = this.#addressTails.get(address);
        const delivery = (previous ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => subscriber(envelope));
        this.#addressTails.set(address, delivery);
        try {
          await delivery;
        } finally {
          if (this.#addressTails.get(address) === delivery) this.#addressTails.delete(address);
        }
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
    validatePayload = true,
  ): Envelope<unknown> {
    if (!this.#running) throw new FabricError('NOT_RUNNING', schemaId);
    const checkedContext = assertValid<BoundaryContext>(BoundaryContextSchema, context);
    const entry = this.#registry.get(schemaId);
    return {
      schemaName: entry.schemaName,
      schemaVersion: entry.major,
      messageType,
      messageId: newId('msg'),
      producer,
      occurredAt: this.#now().toISOString(),
      tenantId: checkedContext.tenantId,
      projectId: checkedContext.projectId,
      correlationId: checkedContext.correlationId,
      ...(checkedContext.causationId === undefined
        ? {}
        : { causationId: checkedContext.causationId }),
      ...(checkedContext.workflowRunId === undefined
        ? {}
        : { workflowRunId: checkedContext.workflowRunId }),
      payload: structuredClone(validatePayload ? assertValid(entry.schema, payload) : payload),
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
