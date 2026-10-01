import {
  CONTEXT_BUILD_UNIT_REF,
  C_REVIEW_AGENT_REF,
  FILE_READ_UNIT_REF,
  MODEL_CALL_UNIT_REF,
  PLANNER_AGENT_REF,
  REPOSITORY_VIEW_UNIT_REF,
  RETURN_RESULT_UNIT_REF,
} from './agent-tool-pool.js';
import type {
  AgentAction,
  AgentDefinition,
  AgentDefinitionReader,
  AgentRunState,
  ContextPack,
  DefinitionRef,
  Result,
  SourceCitation,
  ToolCallAction,
  UnitCompletion,
  UnitDefinitionReader,
  UnitInput,
  UnitIntent,
  UnitRunState,
  WorkflowDecision,
  WorkflowPort,
  WorkflowStartRequest,
  WorkflowState,
} from './contracts.js';

type WorkflowDefinitions = AgentDefinitionReader & UnitDefinitionReader;

const MAX_PLANNER_MODEL_CALLS = 2;
const MAX_REVIEW_MODEL_CALLS = 12;
const MAX_FILE_READS = 16;

function referencesMatch(left: DefinitionRef, right: DefinitionRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

function containsRef(refs: readonly DefinitionRef[], expected: DefinitionRef): boolean {
  return refs.some((ref) => referencesMatch(ref, expected));
}

function updateAgent(
  state: WorkflowState,
  agentRunId: string,
  update: Partial<AgentRunState>,
): WorkflowState {
  const current = state.agentRuns[agentRunId];
  if (current === undefined) return state;
  return {
    ...state,
    agentRuns: {
      ...state.agentRuns,
      [agentRunId]: { ...current, ...update },
    },
  };
}

function clearPendingUnit(state: WorkflowState): WorkflowState {
  const { pendingUnitRunId, ...withoutPending } = state;
  void pendingUnitRunId;
  return withoutPending;
}

function citationWasObserved(citation: SourceCitation, state: WorkflowState): boolean {
  return state.observations.some(
    (observation) =>
      observation.output.path === citation.path &&
      citation.startLine >= observation.output.startLine &&
      citation.endLine <= observation.output.endLine &&
      citation.startLine <= citation.endLine,
  );
}

export class MinimalWorkflow implements WorkflowPort {
  public constructor(private readonly definitions: WorkflowDefinitions) {}

  public async start(request: WorkflowStartRequest): Promise<Result<WorkflowDecision>> {
    const planner = await this.definitions.getAgent(PLANNER_AGENT_REF);
    if (!planner.ok) return planner;
    const reviewer = await this.definitions.getAgent(C_REVIEW_AGENT_REF);
    if (!reviewer.ok) return reviewer;

    const plannerRunId = `${request.workflowRunId}:agent:planner`;
    const reviewRunId = `${request.workflowRunId}:agent:c-review`;
    const state: WorkflowState = {
      workflowRunId: request.workflowRunId,
      objective: request.objective,
      ...(request.repository === undefined ? {} : { repository: request.repository }),
      phase: 'ROUTING',
      activeAgentRunId: plannerRunId,
      agentRuns: {
        [plannerRunId]: {
          agentRunId: plannerRunId,
          agentRef: planner.value.ref,
          status: 'READY',
          modelCallCount: 0,
          fileReadCount: 0,
        },
        [reviewRunId]: {
          agentRunId: reviewRunId,
          agentRef: reviewer.value.ref,
          status: 'WAITING_ACTIVATION',
          modelCallCount: 0,
          fileReadCount: 0,
        },
      },
      unitRuns: {},
      nextStepNumber: 1,
      observations: [],
      queuedToolCalls: [],
    };

    return this.issueContext(state, planner.value, plannerRunId);
  }

  public async resume(
    state: WorkflowState,
    completion: UnitCompletion,
  ): Promise<Result<WorkflowDecision>> {
    const pendingId = state.pendingUnitRunId;
    if (pendingId === undefined) {
      return failure(
        'NO_PENDING_UNIT',
        'Workflow received a Unit result while no Unit was pending.',
      );
    }
    const pending = state.unitRuns[pendingId];
    if (
      pending === undefined ||
      pending.unitIntentId !== completion.unitIntentId ||
      pending.agentRunId !== completion.agentRunId ||
      !referencesMatch(pending.unitRef, completion.unitRef)
    ) {
      return failure('UNIT_RESULT_MISMATCH', 'Unit result does not match the pending UnitRun.');
    }

    const activeAgent = state.agentRuns[pending.agentRunId];
    if (activeAgent === undefined || state.activeAgentRunId !== activeAgent.agentRunId) {
      return failure(
        'AGENT_RESULT_MISMATCH',
        'Unit result does not belong to the active AgentRun.',
      );
    }

    const evaluatingUnit: UnitRunState = {
      ...pending,
      status: 'EVALUATING_RESULT',
      attemptCount: completion.attemptNumber,
      currentAttemptId: completion.unitAttemptId,
    };
    let nextState: WorkflowState = {
      ...state,
      unitRuns: { ...state.unitRuns, [pendingId]: evaluatingUnit },
      agentRuns: {
        ...state.agentRuns,
        [activeAgent.agentRunId]: { ...activeAgent, status: 'APPLYING_RESULT' },
      },
    };

    if (completion.outcome !== 'SUCCEEDED' || completion.output === undefined) {
      nextState = {
        ...nextState,
        unitRuns: {
          ...nextState.unitRuns,
          [pendingId]: { ...evaluatingUnit, status: 'FAILED' },
        },
        agentRuns: {
          ...nextState.agentRuns,
          [activeAgent.agentRunId]: { ...activeAgent, status: 'FAILED' },
        },
      };
      const error = completion.error ?? {
        code: 'UNIT_EXECUTION_FAILED',
        message: 'Unit execution failed.',
        retryable: false,
      };
      return { ok: true, value: { kind: 'FAILED', state: nextState, error } };
    }

    nextState = {
      ...nextState,
      unitRuns: {
        ...nextState.unitRuns,
        [pendingId]: { ...evaluatingUnit, status: 'SUCCEEDED' },
      },
    };

    switch (completion.output.kind) {
      case 'CONTEXT_BUILD':
        return this.issueModelCall(nextState, activeAgent, completion.output.context);
      case 'MODEL_CALL':
        return this.applyAgentActions(nextState, activeAgent, completion.output.response.actions);
      case 'REPOSITORY_VIEW': {
        const withOverview: WorkflowState = {
          ...nextState,
          repositoryOverview: completion.output.overview,
        };
        const definition = await this.definitions.getAgent(activeAgent.agentRef);
        if (!definition.ok) return definition;
        return this.issueContext(withOverview, definition.value, activeAgent.agentRunId);
      }
      case 'FILE_READ': {
        const [nextCall, ...remainingCalls] = nextState.queuedToolCalls;
        const withObservation: WorkflowState = {
          ...nextState,
          observations: [...nextState.observations, completion.output.observation],
          queuedToolCalls: remainingCalls,
        };
        // Run every read from the same model turn before building the next context.
        if (nextCall !== undefined) {
          const agentRun = withObservation.agentRuns[activeAgent.agentRunId] ?? activeAgent;
          return this.issueFileRead(withObservation, agentRun, nextCall);
        }
        const definition = await this.definitions.getAgent(activeAgent.agentRef);
        if (!definition.ok) return definition;
        return this.issueContext(withObservation, definition.value, activeAgent.agentRunId);
      }
      case 'RETURN_RESULT': {
        const completed = updateAgent(
          {
            ...clearPendingUnit(nextState),
            phase: 'COMPLETED',
          },
          activeAgent.agentRunId,
          { status: 'RESULT_SUBMITTED' },
        );
        return {
          ok: true,
          value: { kind: 'COMPLETE', state: completed, response: completion.output.response },
        };
      }
    }
  }

  private async issueContext(
    state: WorkflowState,
    agent: AgentDefinition,
    agentRunId: string,
  ): Promise<Result<WorkflowDecision>> {
    const catalog = await this.definitions.listRoutingAgents();
    if (!catalog.ok) return catalog;
    const run = state.agentRuns[agentRunId];
    if (run === undefined)
      return failure('AGENT_RUN_NOT_FOUND', `AgentRun ${agentRunId} was not found.`);

    return this.issueUnit(state, agent, agentRunId, CONTEXT_BUILD_UNIT_REF, {
      kind: 'CONTEXT_BUILD',
      request: {
        agentRef: agent.ref,
        promptRef: agent.promptRef,
        objective: state.objective,
        ...(state.repository === undefined ? {} : { repository: state.repository }),
        routingCatalog: catalog.value,
        ...(state.handoff === undefined ? {} : { handoff: state.handoff }),
        ...(state.repositoryOverview === undefined
          ? {}
          : { repositoryOverview: state.repositoryOverview }),
        observations: state.observations,
        status: {
          modelCallsRemaining: referencesMatch(agent.ref, PLANNER_AGENT_REF)
            ? MAX_PLANNER_MODEL_CALLS - run.modelCallCount
            : MAX_REVIEW_MODEL_CALLS - run.modelCallCount,
          fileReadsRemaining: MAX_FILE_READS - run.fileReadCount,
        },
      },
    });
  }

  private issueModelCall(
    state: WorkflowState,
    agentRun: AgentRunState,
    context: ContextPack,
  ): Promise<Result<WorkflowDecision>> {
    const limit = referencesMatch(agentRun.agentRef, PLANNER_AGENT_REF)
      ? MAX_PLANNER_MODEL_CALLS
      : MAX_REVIEW_MODEL_CALLS;
    if (agentRun.modelCallCount >= limit) {
      return Promise.resolve(failure('MODEL_CALL_LIMIT', 'Agent exceeded its model-call limit.'));
    }
    return this.definitions.getAgent(agentRun.agentRef).then((agent) =>
      agent.ok
        ? this.issueUnit(state, agent.value, agentRun.agentRunId, MODEL_CALL_UNIT_REF, {
            kind: 'MODEL_CALL',
            request: { context },
          })
        : agent,
    );
  }

  private async applyAgentActions(
    state: WorkflowState,
    agentRun: AgentRunState,
    actions: readonly AgentAction[],
  ): Promise<Result<WorkflowDecision>> {
    const agent = await this.definitions.getAgent(agentRun.agentRef);
    if (!agent.ok) return agent;

    if (referencesMatch(agentRun.agentRef, PLANNER_AGENT_REF)) {
      const [action] = actions;
      if (action === undefined || actions.length !== 1) {
        return failure('INVALID_PLANNER_ACTION', 'Planner must return exactly one action.');
      }
      if (action.kind === 'FINAL') {
        const finalizing: WorkflowState = { ...state, phase: 'FINALIZING' };
        return this.issueUnit(
          finalizing,
          agent.value,
          agentRun.agentRunId,
          RETURN_RESULT_UNIT_REF,
          { kind: 'RETURN_RESULT', response: { answer: action.answer } },
        );
      }
      if (action.kind !== 'HANDOFF') {
        return failure('INVALID_PLANNER_ACTION', 'Planner must return FINAL or HANDOFF.');
      }
      const targetRef = agent.value.allowedHandoffRefs.find(
        (ref) => ref.id === action.targetAgentId,
      );
      if (targetRef === undefined) {
        return failure('HANDOFF_NOT_ALLOWED', 'Planner selected an Agent outside its handoff set.');
      }
      if (state.repository === undefined) {
        return failure(
          'REPOSITORY_REQUIRED',
          'A repository is required for a code review handoff.',
        );
      }

      const reviewRun = Object.values(state.agentRuns).find((run) =>
        referencesMatch(run.agentRef, targetRef),
      );
      if (reviewRun === undefined || reviewRun.status !== 'WAITING_ACTIVATION') {
        return failure('INVALID_HANDOFF_TARGET', 'Review Agent is not waiting for activation.');
      }
      const reviewer = await this.definitions.getAgent(targetRef);
      if (!reviewer.ok) return reviewer;

      let handedOff: WorkflowState = {
        ...state,
        phase: 'REVIEWING',
        activeAgentRunId: reviewRun.agentRunId,
        handoff: action,
        agentRuns: {
          ...state.agentRuns,
          [agentRun.agentRunId]: { ...agentRun, status: 'RESULT_SUBMITTED' },
          [reviewRun.agentRunId]: { ...reviewRun, status: 'READY' },
        },
      };
      handedOff = updateAgent(handedOff, reviewRun.agentRunId, { status: 'RUNNING' });
      return this.issueUnit(
        handedOff,
        reviewer.value,
        reviewRun.agentRunId,
        REPOSITORY_VIEW_UNIT_REF,
        {
          kind: 'REPOSITORY_VIEW',
          request: {
            repository: state.repository,
            maxDepth: 4,
            includeExtensions: ['.c', '.h'],
          },
        },
      );
    }

    if (!referencesMatch(agentRun.agentRef, C_REVIEW_AGENT_REF)) {
      return failure('UNKNOWN_ACTIVE_AGENT', 'Workflow does not support this active Agent.');
    }
    const toolCalls = actions.filter((item) => item.kind === 'TOOL_CALL');
    const [firstCall, ...queuedCalls] = toolCalls;
    if (firstCall !== undefined && toolCalls.length === actions.length) {
      return this.issueFileRead({ ...state, queuedToolCalls: queuedCalls }, agentRun, firstCall);
    }
    const [action] = actions;
    if (action?.kind === 'FINAL' && actions.length === 1) {
      if (state.observations.length === 0) {
        return failure(
          'REVIEW_EVIDENCE_REQUIRED',
          'Review Agent must read repository evidence before returning FINAL.',
        );
      }
      const citations = action.citations ?? [];
      if (!citations.every((citation) => citationWasObserved(citation, state))) {
        return failure(
          'UNSUPPORTED_REVIEW_CITATION',
          'Review report cited a file range that was not observed.',
        );
      }
      const finalizing: WorkflowState = { ...state, phase: 'FINALIZING' };
      return this.issueUnit(finalizing, agent.value, agentRun.agentRunId, RETURN_RESULT_UNIT_REF, {
        kind: 'RETURN_RESULT',
        response: { answer: action.answer },
      });
    }
    return failure(
      'INVALID_REVIEW_ACTION',
      'Review Agent must return file reads only, or a single FINAL.',
    );
  }

  private async issueFileRead(
    state: WorkflowState,
    agentRun: AgentRunState,
    call: ToolCallAction,
  ): Promise<Result<WorkflowDecision>> {
    if (agentRun.fileReadCount >= MAX_FILE_READS) {
      return failure('FILE_READ_LIMIT', 'Review Agent exceeded its file-read limit.');
    }
    if (state.repository === undefined) {
      return failure('REPOSITORY_REQUIRED', 'Review Agent requires a repository.');
    }
    const agent = await this.definitions.getAgent(agentRun.agentRef);
    if (!agent.ok) return agent;
    return this.issueUnit(state, agent.value, agentRun.agentRunId, FILE_READ_UNIT_REF, {
      kind: 'FILE_READ',
      callId: call.callId,
      request: { repository: state.repository, input: call.input },
    });
  }

  private async issueUnit(
    state: WorkflowState,
    agent: AgentDefinition,
    agentRunId: string,
    unitRef: DefinitionRef,
    input: UnitInput,
  ): Promise<Result<WorkflowDecision>> {
    if (!containsRef(agent.allowedUnitRefs, unitRef)) {
      return failure('UNIT_NOT_ALLOWED', `${agent.name} is not allowed to use ${unitRef.id}.`);
    }
    const unit = await this.definitions.getUnit(unitRef);
    if (!unit.ok) return unit;
    if (unit.value.kind !== input.kind) {
      return failure(
        'UNIT_INPUT_MISMATCH',
        `${unit.value.kind} Unit received ${input.kind} input.`,
      );
    }

    const agentRun = state.agentRuns[agentRunId];
    if (agentRun === undefined)
      return failure('AGENT_RUN_NOT_FOUND', `AgentRun ${agentRunId} was not found.`);
    const stepNumber = state.nextStepNumber;
    const unitIntentId = `${state.workflowRunId}:intent:${stepNumber}`;
    const unitRunId = `${state.workflowRunId}:unit:${stepNumber}`;
    const intent: UnitIntent = {
      unitIntentId,
      workflowRunId: state.workflowRunId,
      agentRunId,
      agentRef: agent.ref,
      unitRef,
      stepNumber,
      input,
    };
    const unitRun: UnitRunState = {
      unitRunId,
      unitIntentId,
      agentRunId,
      unitRef,
      status: 'WAITING_EXECUTION',
      attemptCount: 0,
    };
    const updatedAgent: AgentRunState = {
      ...agentRun,
      status: 'WAITING_UNIT',
      modelCallCount: agentRun.modelCallCount + (input.kind === 'MODEL_CALL' ? 1 : 0),
      fileReadCount: agentRun.fileReadCount + (input.kind === 'FILE_READ' ? 1 : 0),
    };
    const nextState: WorkflowState = {
      ...state,
      activeAgentRunId: agentRunId,
      agentRuns: { ...state.agentRuns, [agentRunId]: updatedAgent },
      unitRuns: { ...state.unitRuns, [unitRunId]: unitRun },
      pendingUnitRunId: unitRunId,
      nextStepNumber: stepNumber + 1,
    };
    return { ok: true, value: { kind: 'EXECUTE_UNIT', state: nextState, intent } };
  }
}
