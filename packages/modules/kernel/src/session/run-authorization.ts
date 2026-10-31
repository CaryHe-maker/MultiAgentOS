import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  newId,
  type ArtifactRef,
  type AuthorizationRequestV1,
  type AuthorizationResolved,
} from '@multiagentos/contracts';

/** Lives in this run's memory only, and ends with the run (Kernel/Core 5, invariant 2). */
export interface Lease {
  readonly capability: 'repo.read';
  readonly repositoryRoot: string;
  readonly exclusions: readonly string[];
  readonly provider: string;
  readonly issuedAt: string;
}

export type Resolution = AuthorizationResolved['resolution'];

export type AccessDecision =
  | { readonly kind: 'ALLOWED' }
  | { readonly kind: 'PENDING'; readonly questionId: string }
  | { readonly kind: 'DECLINED' };

export interface AccessCheck {
  readonly decision: AccessDecision;
  /** Present only when this check opened a new question. */
  readonly requested?: AuthorizationRequestV1;
}

/** What an answered question hands back: everyone who waited on it, in arrival order. */
export interface QuestionResolved<W> {
  readonly resolution: Resolution;
  readonly capability: AuthorizationRequestV1['capability'];
  readonly waiters: readonly W[];
  readonly resolved: AuthorizationResolved;
}

export interface RunAuthorizationDeps {
  readonly repositoryRoot: string;
  readonly provider: string;
  readonly repositoryExclusions: readonly string[];
  readonly authorizationTimeoutMs: number;
  readonly now: () => Date;
}

interface Question<W> {
  readonly questionId: string;
  readonly capability: AuthorizationRequestV1['capability'];
  readonly instruction?: string;
  readonly waiters: W[];
}

const instructionKey = (path: string, sha256: string): string => `${path}\u0000${sha256}`;

/**
 * Authorization of one run. `repo.read` is asked once: a grant and a refusal last for the run, and
 * a timeout or a cancellation refuses only the requests that waited. `project.instructions` is
 * asked per exact content; a refusal is remembered here and trust itself belongs to Session
 * management, because it outlives the run and grants nothing (Kernel/Core 5).
 */
export class RunAuthorization<W> {
  readonly #deps: RunAuthorizationDeps;
  readonly #exclusions: readonly string[];
  readonly #questions = new Map<string, Question<W>>();
  readonly #distrusted = new Set<string>();
  #repoReadQuestion: string | undefined;
  #repoReadDenied = false;
  #lease: Readonly<Lease> | undefined;

  public constructor(deps: RunAuthorizationDeps) {
    this.#deps = deps;
    this.#exclusions = Object.freeze([
      ...DEFAULT_REPOSITORY_EXCLUSIONS,
      ...deps.repositoryExclusions,
    ]);
  }

  public get lease(): Readonly<Lease> | undefined {
    return this.#lease;
  }

  #expiresAt(): string {
    return new Date(this.#deps.now().getTime() + this.#deps.authorizationTimeoutMs).toISOString();
  }

  requireRepoRead(waiter: W): AccessCheck {
    if (this.#lease !== undefined) return { decision: { kind: 'ALLOWED' } };
    if (this.#repoReadDenied) return { decision: { kind: 'DECLINED' } };
    const pending =
      this.#repoReadQuestion === undefined
        ? undefined
        : this.#questions.get(this.#repoReadQuestion);
    if (pending !== undefined) {
      pending.waiters.push(waiter);
      return { decision: { kind: 'PENDING', questionId: pending.questionId } };
    }
    const questionId = newId('qst');
    this.#questions.set(questionId, { questionId, capability: 'repo.read', waiters: [waiter] });
    this.#repoReadQuestion = questionId;
    return {
      decision: { kind: 'PENDING', questionId },
      requested: {
        type: 'AuthorizationRequest',
        questionId,
        capability: 'repo.read',
        repositoryPath: this.#deps.repositoryRoot,
        exclusions: [...this.#exclusions],
        provider: this.#deps.provider,
        expiresAt: this.#expiresAt(),
      },
    };
  }

  /** The caller has already looked in the trust records; this decides what remains. */
  askInstructions(
    file: {
      readonly path: string;
      readonly sha256: string;
      readonly contentRef: ArtifactRef;
      readonly truncated: boolean;
    },
    waiter: W,
  ): AccessCheck {
    const key = instructionKey(file.path, file.sha256);
    if (this.#distrusted.has(key)) return { decision: { kind: 'DECLINED' } };
    for (const question of this.#questions.values())
      if (question.instruction === key) {
        question.waiters.push(waiter);
        return { decision: { kind: 'PENDING', questionId: question.questionId } };
      }
    const questionId = newId('qst');
    this.#questions.set(questionId, {
      questionId,
      capability: 'project.instructions',
      instruction: key,
      waiters: [waiter],
    });
    return {
      decision: { kind: 'PENDING', questionId },
      requested: {
        type: 'AuthorizationRequest',
        questionId,
        capability: 'project.instructions',
        path: file.path,
        contentRef: file.contentRef,
        truncated: file.truncated,
        expiresAt: this.#expiresAt(),
      },
    };
  }

  #settle(questionId: string, resolution: Resolution): QuestionResolved<W> | undefined {
    const question = this.#questions.get(questionId);
    if (question === undefined) return undefined;
    this.#questions.delete(questionId);
    if (this.#repoReadQuestion === questionId) this.#repoReadQuestion = undefined;
    return {
      resolution,
      capability: question.capability,
      waiters: question.waiters,
      resolved: { type: 'AuthorizationResolved', questionId, resolution },
    };
  }

  answer(questionId: string, scope: 'ALLOW' | 'DENY'): QuestionResolved<W> | undefined {
    const question = this.#questions.get(questionId);
    const settled = this.#settle(questionId, scope === 'ALLOW' ? 'GRANTED' : 'DECLINED');
    if (question === undefined || settled === undefined) return undefined;
    if (question.capability === 'project.instructions') {
      if (scope === 'DENY' && question.instruction !== undefined)
        this.#distrusted.add(question.instruction);
      return settled;
    }
    if (scope === 'DENY') this.#repoReadDenied = true;
    else
      this.#lease = Object.freeze({
        capability: 'repo.read',
        repositoryRoot: this.#deps.repositoryRoot,
        exclusions: this.#exclusions,
        provider: this.#deps.provider,
        issuedAt: this.#deps.now().toISOString(),
      });
    return settled;
  }

  /** Refuses only those who waited: the next need asks again (M2Design 5.3). */
  expire(questionId: string): QuestionResolved<W> | undefined {
    return this.#settle(questionId, 'TIMED_OUT');
  }

  /** Convergence: nothing stays pending and the Lease ends with the run. */
  closeAll(): readonly QuestionResolved<W>[] {
    const settled = [...this.#questions.keys()].flatMap(
      (questionId) => this.#settle(questionId, 'CANCELLED') ?? [],
    );
    this.#lease = undefined;
    return settled;
  }
}
