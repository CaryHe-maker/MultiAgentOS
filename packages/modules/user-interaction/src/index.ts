/**
 * UserInteraction Module (Module/UserInteraction). `console/` holds the terminal-independent
 * console: it turns Kernel events into what the view shows and the user's input into requests
 * through `InteractionGatewayPort`. `apps/cli` draws the view; `domain/` renders the analyze
 * report.
 */
import type { HealthStatus, LifecyclePort } from '@multiagentos/contracts';
import { Console, type ConsoleDeps } from './console/console.js';

export { Console, RUN_EXIT_CODES, type ConsoleDeps } from './console/console.js';
export { ConsoleText, terminalText } from './console/console-text.js';
export type {
  ActivityLine,
  ConsoleView,
  LiveState,
  PendingItem,
  TranscriptRecord,
} from './console/console-view.js';
export { renderReport } from './domain/report-view.js';

/** The console as a ModuleHost module; it holds no state that a start or stop must handle. */
export interface UserInteractionModule extends LifecyclePort {
  readonly console: Console;
}

export function createUserInteraction(deps: ConsoleDeps): UserInteractionModule {
  const console = new Console(deps);
  let running = false;
  return {
    console,
    manifest: { moduleId: 'user-interaction', version: '0.2.0', dependencies: ['gateway'] },
    start: () => {
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
        checkedAt: new Date().toISOString(),
        details: [],
      }),
  };
}
