/**
 * UserInteraction Module (docs/M1/Module/UserInteraction.md). `domain/` holds the exit codes,
 * `InteractionMessages` and the report view; `application/` consumes the Inbox and drives
 * createRun, the authorization question and shutdown; `ports/` declares the terminal port that
 * the CLI adapter in `apps/cli` implements.
 */
import type {
  InteractionGatewayPort,
  InteractionInboxPort,
  LifecyclePort,
} from '@multiagentos/contracts';
import type { TerminalPort } from './ports/terminal-port.js';

export { EXIT_CODES, EXIT_CODE_RUN_REJECTED } from './domain/exit-codes.js';
export type { TerminalPort } from './ports/terminal-port.js';

export interface AnalyzeCommand {
  readonly goal: string;
  /** Absolute path of the repository to analyse. */
  readonly repositoryPath: string;
  /** Also show the RunSummary. */
  readonly details: boolean;
}

export interface UserInteractionDeps {
  /** UserInteraction's only way into the Kernel. */
  readonly gateway: InteractionGatewayPort;
  readonly terminal: TerminalPort;
  readonly now?: () => Date;
}

/**
 * `inbox` is served on the address `inbox.user-interaction` by the composition root.
 * `analyze` runs one goal to its end, shows the result, requests shutdown and resolves with
 * the exit code; the composition root exits the process with it after everything stopped.
 */
export interface UserInteractionModule extends LifecyclePort {
  readonly inbox: InteractionInboxPort;
  analyze(command: AnalyzeCommand): Promise<number>;
}

export function createUserInteraction(deps: UserInteractionDeps): UserInteractionModule {
  void deps;
  throw new Error('NOT_IMPLEMENTED: UserInteraction');
}
