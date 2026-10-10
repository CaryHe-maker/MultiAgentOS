import {
  newId,
  type AdmissionProjection,
  type ArtifactContent,
  type BoundaryContext,
  type FabricPort,
  type GatewayForward,
  type HealthStatus,
  type LifecyclePort,
  type RunCreated,
  type SyscallAck,
  type SyscallRejected,
} from '@multiagentos/contracts';
import { SCHEMA_IDS } from '@multiagentos/fabric';

export interface GatewayDeps {
  /** The Fabric client whose producer is `gateway`. */
  readonly fabric: FabricPort;
  readonly now?: () => Date;
}

type GatewayResponse = SyscallAck | SyscallRejected | RunCreated | ArtifactContent;
type RequestType = GatewayForward['requestType'];

const ROUTES: readonly {
  readonly schemaId: string;
  readonly requestType: RequestType;
  readonly caller: 'workflow' | 'user-interaction';
}[] = [
  { schemaId: SCHEMA_IDS.registerAgentRun, requestType: 'registerAgentRun', caller: 'workflow' },
  { schemaId: SCHEMA_IDS.submitUnit, requestType: 'submitUnit', caller: 'workflow' },
  { schemaId: SCHEMA_IDS.endAgentRun, requestType: 'endAgentRun', caller: 'workflow' },
  { schemaId: SCHEMA_IDS.closeRun, requestType: 'closeRun', caller: 'workflow' },
  { schemaId: SCHEMA_IDS.createRun, requestType: 'createRun', caller: 'user-interaction' },
  {
    schemaId: SCHEMA_IDS.answerAuthorization,
    requestType: 'answerAuthorization',
    caller: 'user-interaction',
  },
  { schemaId: SCHEMA_IDS.cancelRun, requestType: 'cancelRun', caller: 'user-interaction' },
  { schemaId: SCHEMA_IDS.readArtifact, requestType: 'readArtifact', caller: 'user-interaction' },
  { schemaId: SCHEMA_IDS.shutdown, requestType: 'shutdown', caller: 'user-interaction' },
];

interface Admission {
  readonly correlationId: string;
  readonly runState: AdmissionProjection['runState'];
  readonly closeReason?: Exclude<AdmissionProjection, { runState: 'RUNNING' }>['closeReason'];
}

/** Gateway checks identity and admission; the Kernel core still makes every final decision. */
export function createGateway({ fabric, now = () => new Date() }: GatewayDeps): LifecyclePort {
  const admissions = new Map<string, Admission>();
  let registered = false;
  let running = false;

  const rejected = (
    requestId: string,
    reasonCode: 'INVALID_REQUEST' | 'CALLER_FORBIDDEN' | 'RUN_NOT_FOUND',
  ): SyscallRejected => ({ requestId, outcome: 'REJECTED', issuer: 'GATEWAY', reasonCode });

  const serve = (route: (typeof ROUTES)[number]): void => {
    fabric.register<GatewayForward['request'], GatewayResponse>(
      route.schemaId,
      async (envelope) => {
        if (!running) throw new Error('Gateway is stopped');
        const request = envelope.payload;
        if (envelope.producer !== route.caller)
          return rejected(request.requestId, 'CALLER_FORBIDDEN');

        const generatedRunId = route.requestType === 'createRun' ? newId('wfr') : undefined;
        const workflowRunId =
          generatedRunId ?? ('workflowRunId' in request ? request.workflowRunId : undefined);
        const known = workflowRunId === undefined ? undefined : admissions.get(workflowRunId);
        if (
          route.requestType !== 'createRun' &&
          route.requestType !== 'shutdown' &&
          known === undefined
        )
          return rejected(request.requestId, 'RUN_NOT_FOUND');
        if (
          known !== undefined &&
          known.runState !== 'RUNNING' &&
          (route.requestType === 'registerAgentRun' || route.requestType === 'submitUnit')
        ) {
          return {
            requestId: request.requestId,
            outcome: 'REJECTED',
            issuer: 'GATEWAY',
            reasonCode: 'RUN_BLOCKED',
            closeReason: known.closeReason,
          } as SyscallRejected;
        }

        const correlationId =
          known?.correlationId ??
          (generatedRunId === undefined ? envelope.correlationId : newId('cor'));
        if (generatedRunId !== undefined)
          admissions.set(generatedRunId, { correlationId, runState: 'RUNNING' });
        const context: BoundaryContext = {
          tenantId: envelope.tenantId,
          projectId: envelope.projectId,
          correlationId,
          causationId: envelope.messageId,
          ...(workflowRunId === undefined ? {} : { workflowRunId }),
        };
        const forward = {
          caller: route.caller,
          requestType: route.requestType,
          request,
          ...(generatedRunId === undefined ? {} : { workflowRunId: generatedRunId }),
        } as GatewayForward;
        try {
          const response = await fabric.request<GatewayForward, GatewayResponse>(
            SCHEMA_IDS.gatewayForward,
            forward,
            context,
          );
          if (generatedRunId !== undefined) {
            if (response.outcome === 'REJECTED') admissions.delete(generatedRunId);
            else if ('workflowRunId' in response && response.workflowRunId !== generatedRunId)
              admissions.delete(generatedRunId);
          }
          return response;
        } catch (error) {
          if (generatedRunId !== undefined) admissions.delete(generatedRunId);
          throw error;
        }
      },
      (envelope) => {
        if (!running) return Promise.reject(new Error('Gateway is stopped'));
        const request = envelope.payload as { readonly requestId: string };
        const reasonCode =
          envelope.producer === route.caller ? 'INVALID_REQUEST' : 'CALLER_FORBIDDEN';
        process.stderr.write(
          `${JSON.stringify({ at: now().toISOString(), component: 'gateway', requestId: request.requestId, reasonCode })}\n`,
        );
        return Promise.resolve(rejected(request.requestId, reasonCode));
      },
    );
  };

  return {
    manifest: { moduleId: 'gateway', version: '0.1.0', dependencies: ['kernel-core'] },
    start: () => {
      if (!registered) {
        for (const route of ROUTES) serve(route);
        fabric.subscribe<AdmissionProjection>('gateway.admission', (envelope) => {
          if (envelope.producer !== 'kernel-core')
            throw new Error('Admission projection has an invalid producer');
          const projection = envelope.payload;
          const known = admissions.get(projection.workflowRunId);
          if (known === undefined) return Promise.resolve();
          const rank = { RUNNING: 0, CONVERGING: 1, CLOSED: 2 } as const;
          if (rank[projection.runState] >= rank[known.runState]) {
            admissions.set(projection.workflowRunId, {
              correlationId: known.correlationId,
              runState: projection.runState,
              ...(projection.runState === 'RUNNING' ? {} : { closeReason: projection.closeReason }),
            });
          }
          return Promise.resolve();
        });
        registered = true;
      }
      running = true;
      return Promise.resolve();
    },
    stop: () => {
      running = false;
      return Promise.resolve();
    },
    health: (): Promise<HealthStatus> =>
      Promise.resolve({
        status: running ? 'UP' : 'DOWN',
        checkedAt: now().toISOString(),
        details: [],
      }),
  };
}
