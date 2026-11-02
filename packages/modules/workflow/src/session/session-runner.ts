import {
  REPOSITORY_KINDS_V1,
  REASON_CODE_CATEGORY,
  newId,
  type AnalysisReportDraft,
  type ArtifactRef,
  type BoundaryContextV1,
  type DefinitionRef,
  type KernelToWorkflowEventV1,
  type PinnedDefinitionRef,
  type ReasonCode,
  type SessionCommandFailure,
  type SessionLogRecord,
  type TemplateDefinition,
  type SubmitUnitRequestV1,
  type ThinkingEffort,
  type UnitInputV1,
  type WorkflowGatewayPortV1,
  type WorkflowInboxEventV1,
  type WorkflowSessionEvent,
  type WorkflowSystemEvent,
} from '@multiagentos/contracts';
import {
  closeAgent,
  receiveAgentReport,
  startAgent,
  type AgentConfig,
  type AgentContext,
  type AgentDefinitions,
  type AgentEnding,
  type AgentState,
  type AgentTransition,
  type ControlSource,
  type EndAction,
} from '../domain/agent/agent-cycle.js';
import {
  analysisFacts,
  degradedReportBody,
  normalReportBody,
  type AgentRounds,
} from '../domain/agent/analysis-report.js';
import { projectHistory, type ProjectionScope } from '../domain/context/history-projection.js';
import {
  advanceGraph,
  chatGrowthPoint,
  chatGrowthRevision,
  compileTemplate,
  initialChatRevision,
  projectGraph,
  type GraphRevision,
} from '../domain/graph/session-graph.js';
import {
  SessionStoreFailure,
  type NewLogRecord,
  type SessionLogStore,
} from './session-log-store.js';

/**
 * Every run of a Session on top of the session log (Module/Workflow 4-6, 9): one event at a time,
 * log first, then the projection, then syscalls. Turn-chat and templates differ only in how the
 * graph grows; all Agents share one AgentRun cycle and one kind of projection.
 */
const REPOSITORY_KINDS: ReadonlySet<string> = new Set(REPOSITORY_KINDS_V1);

export interface AgentBinding {
  readonly ref: PinnedDefinitionRef;
  readonly modelRef: DefinitionRef;
  readonly effort: ThinkingEffort;
  readonly toolsDigest: string;
  readonly definitions: AgentDefinitions;
}

export interface SessionRunnerDeps {
  readonly gateway: WorkflowGatewayPortV1;
  readonly store: SessionLogStore;
  /** Built-in Agents by id; `chat` runs the one named `main`. */
  readonly agents: ReadonlyMap<string, AgentBinding>;
  /** Built-in templates by id. */
  readonly templates: ReadonlyMap<string, TemplateDefinition>;
  readonly definitionsDigest: string;
  readonly definitionVersions: readonly string[];
  readonly config: AgentConfig;
  readonly runtime: () => { readonly sandbox: string; readonly currentDate: string };
  readonly now?: () => Date;
  readonly newAgentRunId?: () => string;
}

const MAIN = 'main';

type HumanContentRef = Extract<SessionLogRecord, { type: 'HUMAN_ANSWERED' }>['contentRef'];

const contextOf = (sessionId: string, workflowRunId?: string): BoundaryContextV1 => ({
  correlationId: newId('cor'),
  tenantId: 'local',
  projectId: 'local',
  sessionId,
  ...(workflowRunId === undefined ? {} : { workflowRunId }),
});

const asHumanRequestId = (nodeId: string): string => `hrq_${nodeId.slice('nod_'.length)}`;

/** How a node ends once its AgentRun closed. */
interface NodeEnding {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly result?: Record<string, unknown>;
  /** The run's result when this node is its output. */
  readonly runOutput: boolean;
}

const OVER_BUDGET: readonly string[] = ['BUDGET_WRAP_UP', 'BUDGET_EXHAUSTED'];

interface ActiveAgent {
  readonly state: AgentState;
  readonly nodeId: string;
  readonly scope: ProjectionScope;
  readonly agentId: string;
  readonly nodeEnding?: NodeEnding;
}

export class SessionRunner {
  readonly #deps: SessionRunnerDeps;
  #sessionId: string | undefined;
  #repositoryRoot = '';
  #records: SessionLogRecord[] = [];
  #mode: 'CHAT' | 'ORCHESTRATION' = 'CHAT';
  #turnId: string | undefined;
  #agent: ActiveAgent | undefined;
  #orientPackRef: AgentState['orientPackRef'];
  /** A repository tool succeeded in the current run. */
  #readRepository = false;
  /** The run whose `AGENTS.md` was already asked for. */
  #instructionsRun: string | undefined;
  #rounds: AgentRounds[] = [];
  #runResult: ArtifactRef | undefined;
  #overBudget = false;
  #runFailure: string | undefined;

  public constructor(deps: SessionRunnerDeps) {
    this.#deps = deps;
  }

  get records(): readonly SessionLogRecord[] {
    return this.#records;
  }

  async #append(records: readonly NewLogRecord[]): Promise<void> {
    for (const record of records) this.#records.push(await this.#deps.store.append(record));
  }

  async handleSessionEvent(envelope: WorkflowSessionEvent): Promise<void> {
    const { sessionId, event } = envelope;
    const reply = (
      result: Parameters<WorkflowGatewayPortV1['reportSessionCommand']>[0]['result'],
    ) =>
      this.#deps.gateway.reportSessionCommand(
        { requestId: newId('req'), sessionId, commandId: event.commandId, result },
        contextOf(sessionId),
      );
    const fail = (failure: SessionCommandFailure) =>
      reply({ command: event.command, outcome: 'FAILED', failure });
    try {
      if (event.command === 'CLOSE') {
        await this.#deps.store.close();
        this.#reset();
        await reply({ command: 'CLOSE', outcome: 'DONE' });
      } else if (event.command === 'CREATE') {
        const started = await this.#deps.store.create({
          sessionId,
          repositoryRoot: event.repositoryRoot,
          definitionsDigest: this.#deps.definitionsDigest,
          definitionVersions: this.#deps.definitionVersions,
        });
        this.#adopt(sessionId, event.repositoryRoot, [started]);
        await reply({ command: 'CREATE', outcome: 'READY' });
      } else {
        const opened = await this.#deps.store.open(sessionId, this.#deps.definitionsDigest);
        this.#adopt(sessionId, event.repositoryRoot, opened.records);
        const lastTurn = [...opened.records].reverse().find((r) => r.type === 'TURN_STARTED');
        await reply({
          command: 'OPEN',
          outcome: 'READY',
          ...(lastTurn?.type === 'TURN_STARTED' && lastTurn.turnId !== undefined
            ? { lastTurnId: lastTurn.turnId }
            : {}),
        });
      }
    } catch (error) {
      if (!(error instanceof SessionStoreFailure)) throw error;
      await fail({ code: error.code });
    }
  }

  #adopt(sessionId: string, repositoryRoot: string, records: readonly SessionLogRecord[]): void {
    this.#sessionId = sessionId;
    this.#repositoryRoot = repositoryRoot;
    this.#records = [...records];
  }

  #reset(): void {
    this.#sessionId = undefined;
    this.#records = [];
    this.#turnId = undefined;
    this.#agent = undefined;
    this.#clearRun();
  }

  #clearRun(): void {
    this.#orientPackRef = undefined;
    this.#readRepository = false;
    this.#rounds = [];
    this.#runResult = undefined;
    this.#overBudget = false;
    this.#runFailure = undefined;
  }

  async handleSystemEvent(envelope: WorkflowSystemEvent): Promise<void> {
    const { event } = envelope;
    if (event.type === 'SessionListQuery') {
      await this.#deps.gateway.reportSessionList(
        {
          requestId: newId('req'),
          queryId: event.queryId,
          sessions: await this.#deps.store.list(event.repositoryRoot),
        },
        { correlationId: newId('cor'), tenantId: 'local', projectId: 'local' },
      );
      return;
    }
    let result: Parameters<WorkflowGatewayPortV1['reportSessionCommand']>[0]['result'] = {
      command: 'DELETE',
      outcome: 'DONE',
    };
    try {
      await this.#deps.store.remove(event.sessionId);
    } catch (error) {
      if (!(error instanceof SessionStoreFailure)) throw error;
      result = { command: 'DELETE', outcome: 'FAILED', failure: { code: error.code } };
    }
    await this.#deps.gateway.reportSessionCommand(
      { requestId: newId('req'), sessionId: event.sessionId, commandId: event.commandId, result },
      contextOf(event.sessionId),
    );
  }

  async handleRunEvent(envelope: WorkflowInboxEventV1): Promise<void> {
    const { event, workflowRunId } = envelope;
    switch (event.type) {
      case 'RunStart':
        await this.#onRunStart(workflowRunId, event);
        break;
      case 'HumanAnswered':
        await this.#onHumanAnswered(workflowRunId, event);
        break;
      case 'UnitReport':
        await this.#onUnitReport(workflowRunId, event);
        break;
      case 'TurnClosed':
        await this.#append([
          {
            type: 'TURN_ENDED',
            workflowRunId,
            turnId: event.turnId,
            reason: event.reason,
            usage: event.usage,
          },
        ]);
        await this.#deps.store.recordTurnClosed();
        break;
      case 'RunClosed':
        await this.#append([
          { type: 'WORKFLOW_RUN_ENDED', workflowRunId, closeReason: event.closeReason },
        ]);
        this.#agent = undefined;
        this.#clearRun();
        break;
    }
  }

  #sessionIdOrThrow(): string {
    if (this.#sessionId === undefined) throw new Error('no Session is open');
    return this.#sessionId;
  }

  async #extend(
    workflowRunId: string,
    revision: number,
    source: 'TEMPLATE' | 'CHAT_GROWTH',
    content: GraphRevision,
  ): Promise<void> {
    await this.#append([
      {
        type: 'GRAPH_EXTENDED',
        workflowRunId,
        revision,
        source,
        nodes: [...content.nodes],
        edges: [...content.edges],
      },
    ]);
  }

  #initialRevision(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEventV1, { type: 'RunStart' }>,
  ): GraphRevision {
    if (event.mode === 'CHAT') return initialChatRevision(workflowRunId, this.#mainRef());
    const template = this.#deps.templates.get(event.templateRef.id);
    if (template === undefined) throw new Error(`unknown template ${event.templateRef.id}`);
    const compiled = compileTemplate(workflowRunId, template);
    if (compiled.errors.length > 0) throw new Error('a built-in template does not compile');
    return compiled.revision;
  }

  async #onRunStart(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEventV1, { type: 'RunStart' }>,
  ): Promise<void> {
    this.#mode = event.mode;
    await this.#append([
      {
        type: 'WORKFLOW_RUN_STARTED',
        workflowRunId,
        mode: event.mode,
        ...(event.mode === 'ORCHESTRATION' ? { templateRef: event.templateRef } : {}),
        preset: event.preset,
        initialInput: event.initialInput,
      },
    ]);
    await this.#extend(workflowRunId, 1, 'TEMPLATE', this.#initialRevision(workflowRunId, event));
    if (!event.initialInput) await this.#advance(workflowRunId);
  }

  #mainRef(): DefinitionRef {
    const { id, version } = this.#binding(MAIN).ref;
    return { id, version };
  }

  #binding(agentId: string): AgentBinding {
    const binding = this.#deps.agents.get(agentId);
    if (binding === undefined) throw new Error(`unknown Agent ${agentId}`);
    return binding;
  }

  async #onHumanAnswered(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEventV1, { type: 'HumanAnswered' }>,
  ): Promise<void> {
    const { graph, view } = projectGraph(this.#records, workflowRunId);
    const node =
      event.origin === 'initial'
        ? graph.nodes.find((candidate) => candidate.kind === 'HUMAN')
        : graph.nodes.find(
            (candidate) => asHumanRequestId(candidate.nodeId) === event.humanRequestId,
          );
    if (node === undefined) throw new Error('HumanAnswered names no HUMAN node');
    if (view.get(node.nodeId)?.status === 'SUCCEEDED') return;
    this.#turnId = event.turnId;
    await this.#append([
      {
        type: 'HUMAN_ANSWERED',
        workflowRunId,
        turnId: event.turnId,
        nodeId: node.nodeId,
        kind: 'prompt',
        origin: event.origin,
        inputId: event.inputId,
        contentRef: event.contentRef,
        ...(event.origin === 'requested' ? { humanRequestId: event.humanRequestId } : {}),
      },
      { type: 'TURN_STARTED', workflowRunId, turnId: event.turnId, promptNodeId: node.nodeId },
      {
        type: 'NODE_ENDED',
        workflowRunId,
        turnId: event.turnId,
        nodeId: node.nodeId,
        status: 'SUCCEEDED',
      },
    ]);
    if (event.origin === 'initial') await this.#deps.store.setTitle(event.contentRef);
    await this.#advance(workflowRunId);
  }

  async #advance(workflowRunId: string): Promise<void> {
    if (this.#mode === 'CHAT') {
      const projected = projectGraph(this.#records, workflowRunId);
      const growth = chatGrowthPoint(projected);
      if (growth !== undefined) {
        const revision = projected.lastRevision + 1;
        await this.#extend(
          workflowRunId,
          revision,
          'CHAT_GROWTH',
          chatGrowthRevision(workflowRunId, revision, growth, this.#mainRef()),
        );
      }
    }
    const projected = projectGraph(this.#records, workflowRunId);
    const { skipped, ready } = advanceGraph(projected.graph, projected.view);
    await this.#append(
      skipped.map(({ node, reason }) => ({
        type: 'NODE_ENDED',
        workflowRunId,
        nodeId: node.nodeId,
        status: 'SKIPPED',
        skipReason: reason,
      })),
    );
    for (const node of ready) {
      const record = projected.nodes.get(node.nodeId);
      if (record === undefined) continue;
      await this.#append([
        {
          type: 'NODE_STARTED',
          workflowRunId,
          ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
          nodeId: node.nodeId,
          path: record.path,
        },
      ]);
      if (node.kind === 'HUMAN') {
        await this.#requestHuman(workflowRunId, node.nodeId);
      } else {
        if (record.agentRef === undefined) throw new Error('an AGENT node names no Agent');
        await this.#startAgent(workflowRunId, node.nodeId, record.agentRef.id, record.inputFrom);
      }
    }
    if (this.#mode === 'ORCHESTRATION' && ready.length === 0 && this.#agent === undefined)
      await this.#closeFinishedRun(workflowRunId);
  }

  /** A template run ends when its graph has nothing left to start. */
  async #closeFinishedRun(workflowRunId: string): Promise<void> {
    if (this.#runFailure !== undefined) await this.#closeFailed(workflowRunId, this.#runFailure);
    else
      await this.#close(workflowRunId, this.#overBudget ? 'BUDGET' : 'COMPLETED', this.#runResult);
  }

  async #requestHuman(workflowRunId: string, nodeId: string): Promise<void> {
    const humanRequestId = asHumanRequestId(nodeId);
    await this.#append([
      { type: 'HUMAN_REQUESTED', workflowRunId, humanRequestId, nodeId, kind: 'prompt' },
    ]);
    const sessionId = this.#sessionIdOrThrow();
    const response = await this.#deps.gateway.requestHuman(
      { requestId: newId('req'), sessionId, workflowRunId, humanRequestId, nodeId, kind: 'prompt' },
      contextOf(sessionId, workflowRunId),
    );
    if (response.outcome === 'REJECTED' && response.reasonCode !== 'RUN_BLOCKED')
      throw new Error(`requestHuman refused: ${response.reasonCode}`);
  }

  #objectiveRef(workflowRunId: string): HumanContentRef {
    const prompt = [...this.#records]
      .reverse()
      .find((record) => record.type === 'HUMAN_ANSWERED' && record.workflowRunId === workflowRunId);
    if (prompt?.type !== 'HUMAN_ANSWERED') throw new Error('an Agent needs a prompt');
    return prompt.contentRef;
  }

  #context(workflowRunId: string, scope: ProjectionScope): AgentContext {
    return {
      objectiveRef: this.#objectiveRef(workflowRunId),
      assembleInput: (status, final) => {
        return {
          final,
          ...(this.#orientPackRef === undefined ? {} : { orientPackRef: this.#orientPackRef }),
          history: [...projectHistory(this.#records, scope)],
          status,
        };
      },
    };
  }

  /** The handoff a node takes as input: the latest one of this run. */
  #handoffInput(workflowRunId: string): Extract<ProjectionScope, { kind: 'NODE' }>['handoff'] {
    const ended = [...this.#records]
      .reverse()
      .find(
        (record) =>
          record.type === 'NODE_ENDED' &&
          record.workflowRunId === workflowRunId &&
          record.result?.['action'] === 'HANDOFF',
      );
    if (ended?.type !== 'NODE_ENDED' || ended.resultRef === undefined) return undefined;
    return { outputRef: ended.resultRef, toolCallId: String(ended.result?.['toolCallId']) };
  }

  async #startAgent(
    workflowRunId: string,
    nodeId: string,
    agentId: string,
    inputFrom: 'HANDOFF' | undefined,
  ): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    const turnId = this.#turnId;
    if (turnId === undefined) throw new Error('an AgentRun needs an open Turn');
    const agentRunId = this.#deps.newAgentRunId?.() ?? newId('agr');
    const binding = this.#binding(agentId);
    await this.#append([
      {
        type: 'AGENT_RUN_REGISTERED',
        workflowRunId,
        turnId,
        agentRunId,
        nodeId,
        agentRef: binding.ref,
        effort: binding.effort,
      },
      {
        type: 'REQUEST_CONTEXT',
        workflowRunId,
        turnId,
        agentRunId,
        modelRef: binding.modelRef,
        thinking: binding.effort,
        toolsDigest: binding.toolsDigest,
        runtimeContext: { workingDirectory: this.#repositoryRoot, ...this.#deps.runtime() },
      },
    ]);
    const registered = await this.#deps.gateway.registerAgentRun(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        agentRunId,
        nodeId,
        agentRef: binding.ref,
        effort: binding.effort,
        workspaceViewId: 'main',
        display: { label: binding.definitions.label },
      },
      contextOf(sessionId, workflowRunId),
    );
    if (registered.outcome === 'REJECTED') {
      await this.#endNode(workflowRunId, turnId, nodeId, 'FAILED');
      return;
    }
    const handoff = inputFrom === 'HANDOFF' ? this.#handoffInput(workflowRunId) : undefined;
    const scope: ProjectionScope =
      this.#mode === 'CHAT'
        ? { kind: 'MAIN' }
        : {
            kind: 'NODE',
            workflowRunId,
            agentRunId,
            ...(handoff === undefined ? {} : { handoff }),
          };
    const transition = startAgent(
      {
        workflowRunId,
        sessionId,
        turnId,
        agentRunId,
        definitions: binding.definitions,
        ...(this.#orientPackRef === undefined ? {} : { orientPackRef: this.#orientPackRef }),
      },
      this.#context(workflowRunId, scope),
    );
    this.#agent = { state: transition.state, nodeId, scope, agentId };
    await this.#apply(workflowRunId, transition);
  }

  async #apply(workflowRunId: string, transition: AgentTransition): Promise<void> {
    await this.#append(transition.records);
    if (this.#agent !== undefined) this.#agent = { ...this.#agent, state: transition.state };
    if (transition.state.orientPackRef !== undefined)
      this.#orientPackRef = transition.state.orientPackRef;
    const sessionId = this.#sessionIdOrThrow();
    for (const planned of transition.submissions) {
      const request = await this.#withInstructions(workflowRunId, planned);
      const response = await this.#deps.gateway.submitUnit(
        request,
        contextOf(sessionId, workflowRunId),
      );
      if (response.outcome === 'REJECTED' && response.reasonCode !== 'RUN_BLOCKED')
        throw new Error(`submitUnit refused: ${response.reasonCode}`);
    }
    if (transition.ending !== undefined) await this.#onEnding(workflowRunId, transition.ending);
  }

  /**
   * `AGENTS.md` is read when the run first needs the repository, like any document, and joins
   * the context after the tool results of that round: a result must directly follow its call,
   * so this waits for the next assembly and refreshes the history that was planned for it.
   */
  async #withInstructions(
    workflowRunId: string,
    request: SubmitUnitRequestV1,
  ): Promise<SubmitUnitRequestV1> {
    const active = this.#agent;
    if (active === undefined || !('history' in request.input) || !this.#readRepository)
      return request;
    if (this.#instructionsRun !== workflowRunId) {
      this.#instructionsRun = workflowRunId;
      const sessionId = this.#sessionIdOrThrow();
      const file = await this.#deps.gateway.readProjectFile(
        { requestId: newId('req'), sessionId, workflowRunId, path: 'AGENTS.md' },
        contextOf(sessionId, workflowRunId),
      );
      if (file.outcome === 'ACCEPTED' && file.exists && 'trusted' in file)
        await this.#append([
          {
            type: 'PROJECT_FILE_LOADED',
            workflowRunId,
            path: 'AGENTS.md',
            ref: file.ref,
            sha256: file.sha256,
            trusted: file.trusted,
          },
        ]);
    }
    return {
      ...request,
      input: { ...request.input, history: [...projectHistory(this.#records, active.scope)] },
    };
  }

  async #onUnitReport(
    workflowRunId: string,
    report: Extract<KernelToWorkflowEventV1, { type: 'UnitReport' }>,
  ): Promise<void> {
    const active = this.#agent;
    if (active === undefined) return;
    if (report.status === 'OK' && REPOSITORY_KINDS.has(report.executionKind))
      this.#readRepository = true;
    const transition = receiveAgentReport(
      active.state,
      report,
      this.#context(workflowRunId, active.scope),
      this.#deps.config,
    );
    await this.#apply(workflowRunId, transition);
  }

  async #endNode(
    workflowRunId: string,
    turnId: string,
    nodeId: string,
    status: 'SUCCEEDED' | 'FAILED',
    result?: Record<string, unknown>,
    resultRef?: ArtifactRef,
  ): Promise<void> {
    await this.#append([
      {
        type: 'NODE_ENDED',
        workflowRunId,
        turnId,
        nodeId,
        status,
        ...(result === undefined ? {} : { result }),
        ...(resultRef === undefined ? {} : { resultRef }),
      },
    ]);
  }

  async #endAgentRun(
    workflowRunId: string,
    active: ActiveAgent,
    outcome: AgentEnding['kind'],
  ): Promise<void> {
    const { agentRunId, turnId, wrapUpReason, round, definitions } = active.state;
    this.#agent = undefined;
    this.#rounds.push({
      agentId: active.agentId,
      agentRunId,
      roundsUsed: round,
      maxRounds: definitions.limits.maxRounds,
    });
    await this.#append([
      {
        type: 'AGENT_RUN_ENDED',
        workflowRunId,
        turnId,
        agentRunId,
        outcome,
        ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
      },
    ]);
    const sessionId = this.#sessionIdOrThrow();
    await this.#deps.gateway.endAgentRun(
      { requestId: newId('req'), sessionId, workflowRunId, agentRunId },
      contextOf(sessionId, workflowRunId),
    );
  }

  async #closeWith(
    workflowRunId: string,
    active: ActiveAgent,
    input: UnitInputV1,
    source: ControlSource | undefined,
    nodeEnding: NodeEnding,
  ): Promise<void> {
    this.#agent = { ...active, nodeEnding };
    await this.#apply(workflowRunId, closeAgent(active.state, input, source));
  }

  #reportInput(workflowRunId: string, active: ActiveAgent) {
    const { round, agentRunId, definitions } = active.state;
    return {
      workflowRunId,
      facts: analysisFacts(this.#records, workflowRunId),
      agentRounds: [
        ...this.#rounds,
        {
          agentId: active.agentId,
          agentRunId,
          roundsUsed: round,
          maxRounds: definitions.limits.maxRounds,
        },
      ],
      createdAt: (this.#deps.now?.() ?? new Date()).toISOString(),
    };
  }

  async #close(
    workflowRunId: string,
    outcome: 'COMPLETED' | 'BUDGET',
    resultRef?: ArtifactRef,
  ): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    await this.#deps.gateway.closeRun(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        outcome,
        ...(resultRef === undefined ? {} : { resultRef }),
      },
      contextOf(sessionId, workflowRunId),
    );
  }

  async #closeFailed(workflowRunId: string, reason: string): Promise<void> {
    const code: ReasonCode =
      reason in REASON_CODE_CATEGORY ? (reason as ReasonCode) : 'WORKFLOW_INTERNAL';
    const sessionId = this.#sessionIdOrThrow();
    await this.#deps.gateway.closeRun(
      {
        requestId: newId('req'),
        sessionId,
        workflowRunId,
        outcome: 'FAILED',
        failure: { code, category: REASON_CODE_CATEGORY[code], source: 'WORKFLOW' },
      },
      contextOf(sessionId, workflowRunId),
    );
  }

  /** The one table of what follows each declared end action. */
  async #runEndAction(
    action: EndAction,
    workflowRunId: string,
    active: ActiveAgent,
    ending: Extract<AgentEnding, { kind: 'ENDED' }>,
  ): Promise<void> {
    const { label } = active.state.definitions;
    const { wrapUpReason } = active.state;
    switch (action) {
      case 'PUBLISH_REPLY':
        return this.#closeWith(
          workflowRunId,
          active,
          {
            kind: 'REPLY',
            agentLabel: label,
            source: {
              modelOutputRef: ending.source.modelOutputRef,
              toolCallId: ending.source.toolCallId,
            },
          },
          ending.source,
          { status: 'SUCCEEDED', runOutput: false },
        );
      case 'PUBLISH_REPORT':
        return this.#closeWith(
          workflowRunId,
          active,
          {
            goalRef: this.#objectiveRef(workflowRunId),
            report: normalReportBody({
              ...this.#reportInput(workflowRunId, active),
              draft: ending.arguments as AnalysisReportDraft,
              ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
            }),
          },
          ending.source,
          { status: 'SUCCEEDED', result: { action: 'FINISH' }, runOutput: true },
        );
      case 'HANDOFF':
        await this.#endAgentRun(workflowRunId, active, 'ENDED');
        await this.#endNode(
          workflowRunId,
          active.state.turnId,
          active.nodeId,
          'SUCCEEDED',
          { action: 'HANDOFF', toolCallId: ending.source.toolCallId },
          ending.source.modelOutputRef,
        );
        return this.#advance(workflowRunId);
    }
  }

  async #onDegraded(workflowRunId: string, active: ActiveAgent, reason: string): Promise<void> {
    if (OVER_BUDGET.includes(reason)) this.#overBudget = true;
    if (active.state.definitions.onDegraded === 'PUBLISH_NOTICE') {
      const input = { kind: 'DEGRADED_REPLY', agentLabel: active.state.definitions.label, reason };
      await this.#closeWith(workflowRunId, active, input as UnitInputV1, undefined, {
        status: 'FAILED',
        runOutput: false,
      });
      return;
    }
    const report = degradedReportBody({ ...this.#reportInput(workflowRunId, active), reason });
    await this.#closeWith(
      workflowRunId,
      active,
      { goalRef: this.#objectiveRef(workflowRunId), report },
      undefined,
      { status: 'FAILED', result: { action: 'FINISH' }, runOutput: true },
    );
  }

  async #onEnding(workflowRunId: string, ending: AgentEnding): Promise<void> {
    const active = this.#agent;
    if (active === undefined) return;
    const { turnId } = active.state;
    switch (ending.kind) {
      case 'ENDED':
        return this.#runEndAction(ending.tool.action, workflowRunId, active, ending);
      case 'DEGRADED':
        return this.#onDegraded(workflowRunId, active, ending.reason);
      case 'CLOSED': {
        const plan = active.nodeEnding ?? { status: 'SUCCEEDED', runOutput: false };
        await this.#endAgentRun(workflowRunId, active, ending.kind);
        await this.#endNode(
          workflowRunId,
          turnId,
          active.nodeId,
          plan.status,
          plan.result,
          ending.outputRef,
        );
        if (plan.runOutput) this.#runResult = ending.outputRef;
        if (this.#mode === 'CHAT' && ending.budget.run !== 'NORMAL')
          return this.#close(workflowRunId, 'BUDGET');
        return this.#advance(workflowRunId);
      }
      case 'FAILED':
        await this.#endAgentRun(workflowRunId, active, ending.kind);
        await this.#endNode(workflowRunId, turnId, active.nodeId, 'FAILED');
        this.#runFailure = ending.code;
        return this.#advance(workflowRunId);
    }
  }
}
