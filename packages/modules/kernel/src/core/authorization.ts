import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  newId,
  type AuthorizationRequest,
  type AuthorizationResolved,
  type UnitDefinition,
} from '@multiagentos/contracts';

/** Core-private Lease (docs/M1/Kernel/Core.md 4). It never leaves Core. */
export interface Lease {
  readonly capability: 'repo.read';
  readonly repositoryRoot: string;
  readonly exclusions: readonly string[];
  readonly provider: string;
  readonly issuedAt: string;
}

export type AuthorizationStatus = 'PENDING' | 'GRANTED' | 'DECLINED' | 'TIMED_OUT' | 'CANCELLED';

export interface AuthorizationRecord {
  readonly questionId: string;
  readonly askedAt: string;
  readonly expiresAt: string;
  answeredAt?: string;
  status: AuthorizationStatus;
  readonly pendingRequests: string[];
}

export type PermissionDecision =
  | { readonly kind: 'ALLOWED' }
  | { readonly kind: 'PENDING'; readonly questionId: string }
  | { readonly kind: 'DECLINED' };

export interface PermissionCheck {
  readonly decision: PermissionDecision;
  /** Present only when this check created a new question. */
  readonly requested?: AuthorizationRequest;
}

export interface AuthorizationResolution {
  readonly resolution: 'GRANTED' | 'DECLINED' | 'TIMED_OUT' | 'CANCELLED';
  /** Requests that were waiting for the answer, in arrival order. */
  readonly released: readonly string[];
  readonly resolved: AuthorizationResolved;
}

export interface AuthorizationManagerDeps {
  readonly repositoryRoot: string;
  readonly provider: string;
  readonly repositoryExclusions: readonly string[];
  readonly authorizationTimeoutMs: number;
  readonly now?: () => Date;
}

/**
 * Core-owned authorization and Lease state (docs/M1/Kernel/Core.md 4, Interaction 5.2).
 * M1 asks once per run for `repo.read`; a denial or timeout is retained for the whole run.
 */
export class AuthorizationManager {
  readonly #repositoryRoot: string;
  readonly #provider: string;
  readonly #exclusions: readonly string[];
  readonly #authorizationTimeoutMs: number;
  readonly #now: () => Date;
  #record: AuthorizationRecord | undefined;
  #lease: Lease | undefined;

  public constructor(deps: AuthorizationManagerDeps) {
    this.#repositoryRoot = deps.repositoryRoot;
    this.#provider = deps.provider;
    this.#exclusions = Object.freeze([
      ...DEFAULT_REPOSITORY_EXCLUSIONS,
      ...deps.repositoryExclusions,
    ]);
    this.#authorizationTimeoutMs = deps.authorizationTimeoutMs;
    this.#now = deps.now ?? (() => new Date());
  }

  public get status(): AuthorizationStatus | undefined {
    return this.#record?.status;
  }

  public get questionId(): string | undefined {
    return this.#record?.questionId;
  }

  public get record(): Readonly<AuthorizationRecord> | undefined {
    return this.#record;
  }

  public get lease(): Readonly<Lease> | undefined {
    return this.#lease;
  }

  public isLeaseValid(): boolean {
    return this.#lease !== undefined;
  }

  /**
   * Decides whether this Unit may proceed. A protected Unit opens the one authorization
   * question when no decision exists; later protected requests join the same question.
   */
  public check(requestId: string, unit: UnitDefinition): PermissionCheck {
    if (!unit.protectedCapabilities.includes('repo.read')) return { decision: { kind: 'ALLOWED' } };

    const record = this.#record;
    if (record === undefined) {
      const askedAt = this.#now();
      const questionId = newId('qst');
      const expiresAt = new Date(askedAt.getTime() + this.#authorizationTimeoutMs);
      this.#record = {
        questionId,
        askedAt: askedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: 'PENDING',
        pendingRequests: [requestId],
      };
      return {
        decision: { kind: 'PENDING', questionId },
        requested: {
          type: 'AuthorizationRequest',
          questionId,
          capability: 'repo.read',
          repositoryPath: this.#repositoryRoot,
          exclusions: [...this.#exclusions],
          provider: this.#provider,
          expiresAt: expiresAt.toISOString(),
        },
      };
    }

    if (record.status === 'PENDING') {
      if (!record.pendingRequests.includes(requestId)) record.pendingRequests.push(requestId);
      return { decision: { kind: 'PENDING', questionId: record.questionId } };
    }
    if (record.status === 'GRANTED')
      return { decision: this.#lease === undefined ? { kind: 'DECLINED' } : { kind: 'ALLOWED' } };
    return { decision: { kind: 'DECLINED' } };
  }

  public answer(questionId: string, answer: 'YES' | 'NO'): AuthorizationResolution | undefined {
    const record = this.#record;
    if (record === undefined || record.questionId !== questionId || record.status !== 'PENDING')
      return undefined;
    if (answer === 'YES') {
      record.status = 'GRANTED';
      record.answeredAt = this.#now().toISOString();
      this.#lease = Object.freeze({
        capability: 'repo.read',
        repositoryRoot: this.#repositoryRoot,
        exclusions: this.#exclusions,
        provider: this.#provider,
        issuedAt: record.answeredAt,
      });
      return this.#resolution(record, 'GRANTED');
    }
    record.status = 'DECLINED';
    record.answeredAt = this.#now().toISOString();
    return this.#resolution(record, 'DECLINED');
  }

  public expire(): AuthorizationResolution | undefined {
    const record = this.#record;
    if (record === undefined || record.status !== 'PENDING') return undefined;
    record.status = 'TIMED_OUT';
    record.answeredAt = this.#now().toISOString();
    return this.#resolution(record, 'TIMED_OUT');
  }

  public cancel(): AuthorizationResolution | undefined {
    // The Lease dies with the run even when the question had already been answered.
    this.#lease = undefined;
    const record = this.#record;
    if (record === undefined || record.status !== 'PENDING') return undefined;
    record.status = 'CANCELLED';
    record.answeredAt = this.#now().toISOString();
    return this.#resolution(record, 'CANCELLED');
  }

  #resolution(
    record: AuthorizationRecord,
    resolution: AuthorizationResolved['resolution'],
  ): AuthorizationResolution {
    return {
      resolution,
      released: [...record.pendingRequests],
      resolved: {
        type: 'AuthorizationResolved',
        questionId: record.questionId,
        resolution,
      },
    };
  }
}
