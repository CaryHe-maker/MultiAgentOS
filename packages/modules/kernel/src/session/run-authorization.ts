import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  normalizeRequestPath,
  REPOSITORY_ROOT_PATH,
  newId,
  type ArtifactRef,
  type AuthorizationRequest,
  type AuthorizationResolved,
} from '@multiagentos/contracts';
import {
  decideUnit,
  type AuthorizationEntry,
  type CommandAnalysis,
  type Capability,
  type CapabilityCeiling,
  type UnitDecision,
  type UnitDemand,
} from './unit-decision.js';

/** Lives in this run's memory only, and ends with the run (Kernel/Core 5, invariant 2). */
export interface Lease {
  readonly capability: 'repo.read';
  readonly repositoryRoot: string;
  readonly exclusions: readonly string[];
  readonly provider: string;
  readonly issuedAt: string;
}

export type Resolution = AuthorizationResolved['resolution'];

/** What the user answers: ALLOW and ONCE for the uncertain level, the four of a command otherwise. */
export type AnswerScope = 'ALLOW' | 'ONCE' | 'COMMAND' | 'PREFIX' | 'DENY';

export type AccessDecision =
  | { readonly kind: 'ALLOWED' }
  | { readonly kind: 'PENDING'; readonly questionId: string }
  | { readonly kind: 'DECLINED' };

export interface AccessCheck {
  readonly decision: AccessDecision;
  /** Present only when this check opened a new question. */
  readonly requested?: AuthorizationRequest;
}

/** What an answered question hands back: everyone who waited on it, in arrival order. */
export interface QuestionResolved {
  readonly resolution: Resolution;
  readonly capability: AuthorizationRequest['capability'];
  /** The requests waiting on it. */
  readonly waiters: readonly string[];
  readonly resolved: AuthorizationResolved;
}

export interface RunAuthorizationDeps {
  readonly repositoryRoot: string;
  readonly provider: string;
  readonly repositoryExclusions: readonly string[];
  readonly now: () => Date;
}

/** One question to ask: a write names its root, or for a critical one the exact content. */
export type WriteQuestion =
  | { readonly critical: false; readonly writeRoot: string }
  | {
      readonly critical: true;
      readonly path: string;
      readonly contentRef: ArtifactRef;
    };

/** What a command question shows and what an answer to it grants. */
export interface CommandQuestion {
  readonly analysis: CommandAnalysis;
  readonly workdir: string;
  readonly writableRoots: readonly string[];
  readonly network: boolean;
  readonly unisolated: boolean;
  readonly approvalDigest: string;
  /** ONCE is always there; COMMAND and PREFIX only when nothing makes the line unreusable. */
  readonly options: readonly ('ONCE' | 'COMMAND' | 'PREFIX' | 'DENY')[];
  /** Each simple command's prefix; empty when one of them has none. */
  readonly prefixes: readonly string[];
}

interface Question {
  readonly command?: CommandQuestion;
  readonly questionId: string;
  readonly capability: AuthorizationRequest['capability'];
  /** Asked again by this key is the same question; a critical one has none (Kernel/Core 5a.2). */
  readonly key?: string;
  readonly critical: boolean;
  readonly waiters: string[];
  /** The AgentRuns a refusal binds. */
  readonly agentRuns: Set<string>;
}

const instructionKey = (path: string, sha256: string): string =>
  `project.instructions\u0000${path}\u0000${sha256}`;
const resourceKey = (capability: Capability, key: string): string => `${capability}\u0000${key}`;

/**
 * Authorization of one run. Decisions come from `decideUnit` over the entries kept here, and
 * answers only ever add entries. A question waits until the user answers; it has no timeout, and
 * only the run's convergence cancels it (M2Design 5.3). `project.instructions` is asked per exact
 * content; a refusal is remembered here and trust itself belongs to Session management, because
 * it outlives the run and grants nothing (Kernel/Core 5).
 */
export class RunAuthorization {
  readonly #deps: RunAuthorizationDeps;
  readonly #exclusions: readonly string[];
  readonly #questions = new Map<string, Question>();
  readonly #distrusted = new Set<string>();
  #entries: readonly AuthorizationEntry[] = [];
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

  /** The defaults and the Session's own rules: what every scope and ceiling carries. */
  public get exclusions(): readonly string[] {
    return this.#exclusions;
  }

  decide(demand: UnitDemand, ceiling: CapabilityCeiling): UnitDecision {
    return decideUnit(demand, ceiling, this.#entries);
  }

  #join(key: string, waiter: string, agentRunId: string | undefined): AccessCheck | undefined {
    for (const question of this.#questions.values())
      if (question.key === key) {
        question.waiters.push(waiter);
        if (agentRunId !== undefined) question.agentRuns.add(agentRunId);
        return { decision: { kind: 'PENDING', questionId: question.questionId } };
      }
    return undefined;
  }

  #open(
    fields: Pick<Question, 'capability' | 'critical' | 'command'> & { readonly key?: string },
    waiter: string,
    agentRunId: string | undefined,
  ): string {
    const questionId = newId('qst');
    this.#questions.set(questionId, {
      ...fields,
      questionId,
      waiters: [waiter],
      agentRuns: new Set(agentRunId === undefined ? [] : [agentRunId]),
    });
    return questionId;
  }

  /** Reading a project file needs the repository too, with no AgentRun to bind a refusal to. */
  requireRepoRead(waiter: string, agentRunId?: string): AccessCheck {
    if (this.#lease !== undefined) return { decision: { kind: 'ALLOWED' } };
    if (
      this.#entries.some(
        (entry) =>
          entry.capability === 'repo.read' &&
          entry.scope === 'RUN' &&
          entry.effect === 'DENY' &&
          entry.agentRunId === agentRunId,
      )
    )
      return { decision: { kind: 'DECLINED' } };
    const key = resourceKey('repo.read', REPOSITORY_ROOT_PATH);
    const joined = this.#join(key, waiter, agentRunId);
    if (joined !== undefined) return joined;
    const questionId = this.#open(
      { capability: 'repo.read', critical: false, key },
      waiter,
      agentRunId,
    );
    return {
      decision: { kind: 'PENDING', questionId },
      requested: {
        type: 'AuthorizationRequest',
        questionId,
        capability: 'repo.read',
        repositoryPath: this.#deps.repositoryRoot,
        exclusions: [...this.#exclusions],
        provider: this.#deps.provider,
      },
    };
  }

  askWrite(question: WriteQuestion, waiter: string, agentRunId: string): AccessCheck {
    if (question.critical) {
      const questionId = this.#open(
        { capability: 'workspace.write', critical: true },
        waiter,
        agentRunId,
      );
      return {
        decision: { kind: 'PENDING', questionId },
        requested: {
          type: 'AuthorizationRequest',
          questionId,
          capability: 'workspace.write',
          path: question.path,
          contentRef: question.contentRef,
          critical: true,
        },
      };
    }
    const key = resourceKey('workspace.write', question.writeRoot);
    const joined = this.#join(key, waiter, agentRunId);
    if (joined !== undefined) return joined;
    const questionId = this.#open(
      { capability: 'workspace.write', critical: false, key },
      waiter,
      agentRunId,
    );
    return {
      decision: { kind: 'PENDING', questionId },
      requested: {
        type: 'AuthorizationRequest',
        questionId,
        capability: 'workspace.write',
        writeRoot: question.writeRoot,
        critical: false,
      },
    };
  }

  /**
   * A command (Kernel/Core 5b). A line that must be asked every time (critical, unreusable) is
   * never merged; any other is one question per (work directory, line) for all who wait on it.
   */
  askCommand(
    command: Omit<CommandQuestion, 'options' | 'prefixes'>,
    perAttempt: boolean,
    waiter: string,
    agentRunId: string,
  ): AccessCheck {
    const { analysis } = command;
    const prefixes = analysis.subcommands.map((sub) => sub.prefix);
    const reusable = !perAttempt && analysis.unreusable.length === 0;
    const hasPrefixes = prefixes.length > 0 && prefixes.every((prefix) => prefix !== undefined);
    const options: CommandQuestion['options'] = reusable
      ? ['ONCE', 'COMMAND', ...(hasPrefixes ? (['PREFIX'] as const) : []), 'DENY']
      : ['ONCE', 'DENY'];
    const shown: CommandQuestion = {
      ...command,
      options,
      prefixes: hasPrefixes ? [...new Set(prefixes)] : [],
    };
    const key = perAttempt
      ? undefined
      : resourceKey('command.exec', `${command.workdir}\u0000${analysis.text}`);
    if (key !== undefined) {
      const joined = this.#join(key, waiter, agentRunId);
      if (joined !== undefined) return joined;
    }
    const questionId = this.#open(
      {
        capability: 'command.exec',
        critical: perAttempt,
        ...(key === undefined ? {} : { key }),
        command: shown,
      },
      waiter,
      agentRunId,
    );
    return {
      decision: { kind: 'PENDING', questionId },
      requested: {
        type: 'AuthorizationRequest',
        questionId,
        capability: 'command.exec',
        command: analysis.text,
        workdir: command.workdir,
        writableRoots: [...command.writableRoots],
        network: command.network,
        unisolated: command.unisolated,
        critical: perAttempt,
        prefixes: [...shown.prefixes],
        unreusable: [
          ...analysis.unreusable,
          ...(analysis.critical === undefined ? [] : (['CRITICAL_COMMAND'] as const)),
          ...(command.network ? (['NETWORK'] as const) : []),
          ...(command.unisolated ? (['UNISOLATED'] as const) : []),
        ],
        ...(analysis.critical === undefined ? {} : { matched: analysis.critical }),
        approvalDigest: command.approvalDigest,
        options: [...options],
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
    waiter: string,
  ): AccessCheck {
    const key = instructionKey(file.path, file.sha256);
    if (this.#distrusted.has(key)) return { decision: { kind: 'DECLINED' } };
    const joined = this.#join(key, waiter, undefined);
    if (joined !== undefined) return joined;
    const questionId = this.#open(
      { capability: 'project.instructions', critical: false, key },
      waiter,
      undefined,
    );
    return {
      decision: { kind: 'PENDING', questionId },
      requested: {
        type: 'AuthorizationRequest',
        questionId,
        capability: 'project.instructions',
        path: file.path,
        contentRef: file.contentRef,
        truncated: file.truncated,
      },
    };
  }

  #settle(questionId: string, resolution: Resolution): QuestionResolved | undefined {
    const question = this.#questions.get(questionId);
    if (question === undefined) return undefined;
    this.#questions.delete(questionId);
    return {
      resolution,
      capability: question.capability,
      waiters: question.waiters,
      resolved: { type: 'AuthorizationResolved', questionId, resolution },
    };
  }

  /** True when the question offers this answer: only a critical one takes ONCE, and only it. */
  offers(questionId: string, scope: AnswerScope): boolean {
    const question = this.#questions.get(questionId);
    if (question === undefined || scope === 'DENY') return true;
    if (question.command !== undefined) return question.command.options.includes(scope as 'ONCE');
    if (scope === 'COMMAND' || scope === 'PREFIX') return false;
    return question.critical === (scope === 'ONCE');
  }

  answer(questionId: string, scope: AnswerScope): QuestionResolved | undefined {
    const question = this.#questions.get(questionId);
    const settled = this.#settle(questionId, scope === 'DENY' ? 'DECLINED' : 'GRANTED');
    if (question === undefined || settled === undefined) return undefined;
    if (question.capability === 'project.instructions') {
      if (scope === 'DENY' && question.key !== undefined) this.#distrusted.add(question.key);
      return settled;
    }
    this.#remember(question, question.capability, scope);
    return settled;
  }

  #remember(question: Question, capability: Capability, scope: AnswerScope): void {
    if (question.command !== undefined && scope !== 'DENY') {
      this.#rememberCommand(question, question.command, scope);
      return;
    }
    if (question.critical) {
      const [requestId] = question.waiters;
      if (requestId === undefined) throw new Error('A question has no one waiting on it');
      this.#entries = [
        ...this.#entries,
        { scope: 'ONCE', effect: scope === 'DENY' ? 'DENY' : 'ALLOW', capability, requestId },
      ];
      return;
    }
    if (scope === 'DENY') {
      // A refused command is refused as that command; the AgentRun keeps the capability.
      const commandKey =
        question.command === undefined
          ? undefined
          : `${question.command.workdir}\u0000${question.command.analysis.text}`;
      this.#entries = [
        ...this.#entries,
        ...[...question.agentRuns].map((agentRunId): AuthorizationEntry => ({
          scope: 'RUN',
          effect: 'DENY',
          capability,
          agentRunId,
          ...(commandKey === undefined ? {} : { commandKey }),
        })),
      ];
      return;
    }
    const key = question.key?.split('\u0000')[1];
    if (key === undefined) throw new Error('A question without a key cannot grant a resource');
    this.#entries = [
      ...this.#entries,
      { scope: 'RUN', effect: 'ALLOW', capability, resourceKey: key },
    ];
    if (capability === 'repo.read')
      this.#lease = Object.freeze({
        capability: 'repo.read',
        repositoryRoot: this.#deps.repositoryRoot,
        exclusions: this.#exclusions,
        provider: this.#deps.provider,
        issuedAt: this.#deps.now().toISOString(),
      });
  }

  /** ONCE covers the first who waits; COMMAND and PREFIX cover each simple command of the line. */
  #rememberCommand(question: Question, command: CommandQuestion, scope: AnswerScope): void {
    const [requestId] = question.waiters;
    if (requestId === undefined) throw new Error('A question has no one waiting on it');
    if (scope === 'ONCE') {
      this.#entries = [
        ...this.#entries,
        { scope: 'ONCE', effect: 'ALLOW', capability: 'command.exec', requestId },
      ];
      return;
    }
    const kind = scope === 'PREFIX' ? 'PREFIX' : 'COMMAND';
    const values =
      kind === 'PREFIX' ? command.prefixes : command.analysis.subcommands.map((sub) => sub.text);
    this.#entries = [
      ...this.#entries,
      ...values.map((value): AuthorizationEntry => ({
        scope: 'RUN',
        effect: 'ALLOW',
        capability: 'command.exec',
        command: {
          kind,
          workdir:
            command.workdir === ''
              ? '.'
              : (normalizeRequestPath(command.workdir) ?? command.workdir),
          value,
        },
      })),
    ];
  }

  /** The attempt of this request ended: its single answer is spent (Kernel/Core 5a.4). */
  attemptEnded(requestId: string): void {
    this.#entries = this.#entries.filter(
      (entry) => entry.scope !== 'ONCE' || entry.requestId !== requestId,
    );
  }

  /** The run started converging: nothing stays pending, and results in flight still settle. */
  cancelQuestions(): readonly QuestionResolved[] {
    return [...this.#questions.keys()].flatMap(
      (questionId) => this.#settle(questionId, 'CANCELLED') ?? [],
    );
  }

  /** The run has drained: the Lease ends with it (Kernel/Interaction 6.3). */
  endLease(): void {
    this.#lease = undefined;
    this.#entries = [];
  }
}
