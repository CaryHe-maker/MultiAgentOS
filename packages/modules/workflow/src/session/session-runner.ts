import {
  newId,
  type BoundaryContextV1,
  type DefinitionRef,
  type KernelToWorkflowEventV1,
  type PinnedDefinitionRef,
  type SessionCommandFailure,
  type SessionLogRecord,
  type ThinkingEffort,
  type WorkflowGatewayPortV1,
  type WorkflowInboxEventV1,
  type WorkflowSessionEvent,
  type WorkflowSystemEvent,
} from '@multiagentos/contracts';
import { projectInstructions, projectMainHistory } from '../domain/context/main-projection.js';
import {
  advanceGraph,
  chatGrowthPoint,
  chatGrowthRevision,
  initialChatRevision,
  projectGraph,
  type GraphRevision,
} from '../domain/graph/session-graph.js';
import {
  receiveAgentReport,
  startAgent,
  type AgentConfig,
  type AgentContext,
  type AgentDefinitions,
  type AgentEnding,
  type AgentState,
  type AgentTransition,
} from '../domain/agent/agent-cycle.js';
import {
  type SessionLogStore,
  SessionStoreFailure,
  type NewLogRecord,
} from './session-log-store.js';

/**
 * Turn-chat on top of the session log (Module/Workflow 4-6, 9): one event at a time, log first,
 * then the projection, then syscalls. All state that matters is in `#records`; a Session reopened
 * later rebuilds it from the same log. `analyze` joins in S1-WF-4.
 */
export interface SessionRunnerDeps {
  readonly gateway: WorkflowGatewayPortV1;
  readonly store: SessionLogStore;
  readonly definitions: AgentDefinitions;
  readonly agent: {
    readonly ref: PinnedDefinitionRef;
    readonly modelRef: DefinitionRef;
    readonly effort: ThinkingEffort;
    readonly toolsDigest: string;
  };
  readonly definitionsDigest: string;
  readonly definitionVersions: readonly string[];
  readonly config: AgentConfig;
  readonly runtime: () => { readonly sandbox: string; readonly currentDate: string };
  /** A failure Workflow cannot report through closeRun (Module/Workflow 10). */
  readonly reportFault: (error: unknown) => void;
  readonly newAgentRunId?: () => string;
}

type HumanContentRef = Extract<SessionLogRecord, { type: 'HUMAN_ANSWERED' }>['contentRef'];

const contextOf = (sessionId: string, workflowRunId?: string): BoundaryContextV1 => ({
  correlationId: newId('cor'),
  tenantId: 'local',
  projectId: 'local',
  sessionId,
  ...(workflowRunId === undefined ? {} : { workflowRunId }),
});

const asHumanRequestId = (nodeId: string): string => `hrq_${nodeId.slice('nod_'.length)}`;

export class SessionRunner {
  readonly #deps: SessionRunnerDeps;
  #sessionId: string | undefined;
  #repositoryRoot = '';
  #records: SessionLogRecord[] = [];
  #turnId: string | undefined;
  #main: { state: AgentState; nodeId: string } | undefined;
  #orientPackRef: AgentState['orientPackRef'];

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
    this.#main = undefined;
    this.#orientPackRef = undefined;
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
        this.#main = undefined;
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

  async #onRunStart(
    workflowRunId: string,
    event: Extract<KernelToWorkflowEventV1, { type: 'RunStart' }>,
  ): Promise<void> {
    if (event.mode !== 'CHAT') throw new Error('analyze joins the runner in S1-WF-4');
    await this.#append([
      {
        type: 'WORKFLOW_RUN_STARTED',
        workflowRunId,
        mode: event.mode,
        preset: event.preset,
        initialInput: event.initialInput,
      },
    ]);
    const sessionId = this.#sessionIdOrThrow();
    const file = await this.#deps.gateway.readProjectFile(
      { requestId: newId('req'), sessionId, workflowRunId, path: 'AGENTS.md' },
      contextOf(sessionId, workflowRunId),
    );
    if (file.outcome === 'ACCEPTED' && file.exists && 'trusted' in file) {
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
    await this.#extend(
      workflowRunId,
      1,
      'TEMPLATE',
      initialChatRevision(workflowRunId, this.#mainRef()),
    );
    if (!event.initialInput) await this.#advance(workflowRunId);
  }

  #mainRef(): DefinitionRef {
    const { id, version } = this.#deps.agent.ref;
    return { id, version };
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
      {
        type: 'TURN_STARTED',
        workflowRunId,
        turnId: event.turnId,
        promptNodeId: node.nodeId,
      },
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
    const growth = chatGrowthPoint(projectGraph(this.#records, workflowRunId));
    if (growth !== undefined) {
      const revision = projectGraph(this.#records, workflowRunId).lastRevision + 1;
      await this.#extend(
        workflowRunId,
        revision,
        'CHAT_GROWTH',
        chatGrowthRevision(workflowRunId, revision, growth, this.#mainRef()),
      );
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
      if (node.kind === 'HUMAN') await this.#requestHuman(workflowRunId, node.nodeId);
      else await this.#startAgent(workflowRunId, node.nodeId);
    }
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

  #context(workflowRunId: string): AgentContext {
    return {
      objectiveRef: this.#objectiveRef(),
      assembleInput: (status, final) => {
        const instructions = projectInstructions(this.#records, workflowRunId);
        return {
          final,
          effort: this.#deps.agent.effort,
          ...(instructions === undefined ? {} : { projectInstructions: instructions }),
          ...(this.#orientPackRef === undefined ? {} : { orientPackRef: this.#orientPackRef }),
          history: [...projectMainHistory(this.#records)],
          status,
        };
      },
    };
  }

  #objectiveRef(): HumanContentRef {
    const prompt = [...this.#records].reverse().find((record) => record.type === 'HUMAN_ANSWERED');
    if (prompt?.type !== 'HUMAN_ANSWERED') throw new Error('main needs a prompt');
    return prompt.contentRef;
  }

  async #startAgent(workflowRunId: string, nodeId: string): Promise<void> {
    const sessionId = this.#sessionIdOrThrow();
    const turnId = this.#turnId;
    if (turnId === undefined) throw new Error('main needs an open Turn');
    const agentRunId = this.#deps.newAgentRunId?.() ?? newId('agr');
    const { agent } = this.#deps;
    await this.#append([
      {
        type: 'AGENT_RUN_REGISTERED',
        workflowRunId,
        turnId,
        agentRunId,
        nodeId,
        agentRef: agent.ref,
        effort: agent.effort,
      },
      {
        type: 'REQUEST_CONTEXT',
        workflowRunId,
        turnId,
        agentRunId,
        modelRef: agent.modelRef,
        thinking: agent.effort,
        toolsDigest: agent.toolsDigest,
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
        agentRef: agent.ref,
        effort: agent.effort,
        workspaceViewId: 'main',
        display: { label: this.#deps.definitions.label },
      },
      contextOf(sessionId, workflowRunId),
    );
    if (registered.outcome === 'REJECTED') {
      await this.#endNode(workflowRunId, turnId, nodeId, 'FAILED');
      return;
    }
    const transition = startAgent(
      {
        workflowRunId,
        sessionId,
        turnId,
        agentRunId,
        effort: agent.effort,
        definitions: this.#deps.definitions,
        ...(this.#orientPackRef === undefined ? {} : { orientPackRef: this.#orientPackRef }),
      },
      this.#context(workflowRunId),
    );
    this.#main = { state: transition.state, nodeId };
    await this.#apply(workflowRunId, transition);
  }

  async #apply(workflowRunId: string, transition: AgentTransition): Promise<void> {
    await this.#append(transition.records);
    if (this.#main !== undefined) this.#main = { ...this.#main, state: transition.state };
    if (transition.state.orientPackRef !== undefined)
      this.#orientPackRef = transition.state.orientPackRef;
    const sessionId = this.#sessionIdOrThrow();
    for (const request of transition.submissions) {
      const response = await this.#deps.gateway.submitUnit(
        request,
        contextOf(sessionId, workflowRunId),
      );
      if (response.outcome === 'REJECTED' && response.reasonCode !== 'RUN_BLOCKED')
        throw new Error(`submitUnit refused: ${response.reasonCode}`);
    }
    if (transition.ending !== undefined) await this.#finishMain(workflowRunId, transition.ending);
  }

  async #onUnitReport(
    workflowRunId: string,
    report: Extract<KernelToWorkflowEventV1, { type: 'UnitReport' }>,
  ): Promise<void> {
    if (this.#main === undefined) return;
    const transition = receiveAgentReport(
      this.#main.state,
      report,
      this.#context(workflowRunId),
      this.#deps.config,
    );
    await this.#apply(workflowRunId, transition);
  }

  async #endNode(
    workflowRunId: string,
    turnId: string,
    nodeId: string,
    status: 'SUCCEEDED' | 'FAILED',
    resultRef?: NonNullable<AgentState['modelOutputRef']>,
  ): Promise<void> {
    await this.#append([
      {
        type: 'NODE_ENDED',
        workflowRunId,
        turnId,
        nodeId,
        status,
        ...(resultRef === undefined ? {} : { resultRef }),
      },
    ]);
  }

  async #finishMain(workflowRunId: string, ending: AgentEnding): Promise<void> {
    const main = this.#main;
    if (main === undefined) return;
    const { agentRunId, turnId, wrapUpReason } = main.state;
    this.#main = undefined;
    await this.#append([
      {
        type: 'AGENT_RUN_ENDED',
        workflowRunId,
        turnId,
        agentRunId,
        outcome: ending.kind,
        ...(wrapUpReason === undefined ? {} : { wrapUpReason }),
      },
    ]);
    const sessionId = this.#sessionIdOrThrow();
    await this.#deps.gateway.endAgentRun(
      { requestId: newId('req'), sessionId, workflowRunId, agentRunId },
      contextOf(sessionId, workflowRunId),
    );
    const messageRef = ending.kind === 'REPLIED' ? ending.messageRef : undefined;
    await this.#endNode(
      workflowRunId,
      turnId,
      main.nodeId,
      ending.kind === 'REPLIED' ? 'SUCCEEDED' : 'FAILED',
      messageRef,
    );
    if (ending.kind === 'REPLIED' && ending.budget.run !== 'NORMAL') {
      await this.#deps.gateway.closeRun(
        { requestId: newId('req'), sessionId, workflowRunId, outcome: 'BUDGET' },
        contextOf(sessionId, workflowRunId),
      );
      return;
    }
    await this.#advance(workflowRunId);
  }
}
