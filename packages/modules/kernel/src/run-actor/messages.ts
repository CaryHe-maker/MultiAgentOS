import type {
  ArtifactContent,
  BoundaryContext,
  ExecutionFact,
  GatewayForward,
  RunCreated,
  SyscallAck,
  SyscallRejected,
} from '@multiagentos/contracts';

/** The two channels of the run Inbox (docs/M1/Kernel/Interaction.md 4.2). */
export type RunChannel = 'control' | 'work';

/** A timer only enqueues its message; it never changes run state directly. */
export type RunTimer = 'RUN_TIMEOUT' | 'AUTHORIZATION_TIMEOUT' | 'CONVERGENCE_DEADLINE';

/** Everything a GatewayForward can answer with. */
export type RunResponse = SyscallAck | SyscallRejected | RunCreated | ArtifactContent;

/**
 * Messages processed by one run actor (docs/M1/Kernel/Interaction.md 4.3).
 *
 * Gateway requests keep their `GatewayForward` shape so Core can process them through its
 * existing request handler. `CANCEL_RUN` is the internal control message used by run
 * management for shutdown; a user cancel still arrives as a `FORWARD`.
 */
export type RunMessage =
  | { readonly kind: 'RUN_INIT' }
  | {
      readonly kind: 'FORWARD';
      readonly forward: GatewayForward;
      readonly context: Readonly<BoundaryContext>;
    }
  | { readonly kind: 'EXECUTION_FACT'; readonly fact: ExecutionFact }
  | { readonly kind: 'CANCEL_RUN' }
  | { readonly kind: 'RUN_TIMEOUT' }
  | { readonly kind: 'AUTHORIZATION_TIMEOUT' }
  | { readonly kind: 'CONVERGENCE_DEADLINE' }
  | { readonly kind: 'KERNEL_FAULT'; readonly faultId: string };

/**
 * Control messages take priority only between two messages. Execution facts that report a
 * termination, violation or unconfirmed stop are control; normal facts are work.
 */
export function runChannelOf(message: RunMessage): RunChannel {
  switch (message.kind) {
    case 'FORWARD':
      return message.forward.requestType === 'cancelRun' ||
        message.forward.requestType === 'answerAuthorization'
        ? 'control'
        : 'work';
    case 'EXECUTION_FACT':
      return message.fact.outcome === 'TERMINATED' ||
        message.fact.outcome === 'VIOLATION' ||
        message.fact.outcome === 'STOP_UNCONFIRMED'
        ? 'control'
        : 'work';
    default:
      return 'control';
  }
}
