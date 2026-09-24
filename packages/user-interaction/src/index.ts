import { randomUUID } from 'node:crypto';
import type {
  BoundaryContext,
  KernelControlPort,
  PortResult,
  RuntimeProjection,
  UserIntent,
  WorkspaceRef,
} from '@multiagentos/contracts';
import { assertValid, UserIntentSchema } from '@multiagentos/contracts';

export interface InteractionSubmission {
  readonly workSessionId: string;
  readonly sessionTreeNodeId: string;
  readonly promptRevisionId: string;
  readonly intent: UserIntent;
  readonly projection: PortResult<RuntimeProjection>;
}
const id = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export class UserInteractionService {
  public constructor(private readonly kernel: KernelControlPort) {}
  async run(objective: string, workspace: WorkspaceRef): Promise<InteractionSubmission> {
    const workSessionId = id('wss');
    const promptRevisionId = id('prv');
    const correlationId = id('cor');
    const intent = assertValid<UserIntent>(UserIntentSchema, {
      kind: 'RUN',
      idempotencyKey: id('idem'),
      workSessionId,
      promptRevisionId,
      objective,
      workspace,
    });
    const context: BoundaryContext = {
      correlationId,
      tenantId: 'local',
      projectId: workspace.workspaceId,
      workSessionId,
    };
    return Object.freeze({
      workSessionId,
      sessionTreeNodeId: id('stn'),
      promptRevisionId,
      intent,
      projection: await this.kernel.submit(intent, context),
    });
  }
  async inspect(workflowRunId: string): Promise<PortResult<RuntimeProjection>> {
    const context: BoundaryContext = {
      correlationId: id('cor'),
      tenantId: 'local',
      projectId: 'local',
      workflowRunId,
    };
    const intent = assertValid<UserIntent>(UserIntentSchema, { kind: 'INSPECT', workflowRunId });
    return await this.kernel.submit(intent, context);
  }
}

export function renderProjection(result: PortResult<RuntimeProjection>): string {
  if (!result.ok) return JSON.stringify({ status: 'ERROR', error: result.error }, undefined, 2);
  return JSON.stringify(result.value, undefined, 2);
}
