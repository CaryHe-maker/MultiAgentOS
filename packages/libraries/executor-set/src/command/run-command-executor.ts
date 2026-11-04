import {
  MEDIA_TYPES,
  type CommandOutput,
  type Executor,
  type ExecutorEnvironment,
} from '@multiagentos/contracts';
import { completed, guarded, rejected, throwIfAborted, violation } from '../outcome/outcomes.js';
import { previewLimitsOf, retainBytes } from '../retention/retention.js';

/** Leaves room in the preview for the status line and the notice of what was left out. */
const FRAME_BYTES = 512;

function statusLine(output: CommandOutput): string {
  const how =
    output.timedOut || output.signal !== null
      ? `${output.timedOut ? 'timed out' : 'stopped'}${output.signal === null ? '' : ` (${output.signal})`}`
      : `exit code ${String(output.exitCode)}`;
  const denied =
    output.sandboxDenials > 0
      ? `; the sandbox refused ${String(output.sandboxDenials)} operation${output.sandboxDenials === 1 ? '' : 's'}`
      : '';
  return `${how}${denied}${output.backend === 'UNISOLATED' ? ' [not isolated]' : ''}`;
}

/**
 * COMMAND (ExecutorSet 5c): runs one command in the sandbox of its scope and keeps the head and
 * the tail of what it printed. The Executor builds no `bwrap` arguments and starts no process
 * itself; a non-zero exit, a timeout and a sandbox refusal are results, not failures.
 */
export function createRunCommandExecutor(): Executor<'COMMAND'> {
  return {
    executionKind: 'COMMAND',
    execute: (input, environment) =>
      guarded(async () => {
        const { scope } = environment;
        if (scope.kind !== 'SANDBOX') return violation('SCOPE_MISSING');
        const limits = previewLimitsOf(environment);
        throwIfAborted(environment.signal);
        const result = await environment.sandbox.run({
          scope,
          command: input.command,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: fullOutputLimit(environment),
          signal: environment.signal,
        });
        if (result.kind === 'REFUSED')
          return rejected(result.reason === 'WORKDIR_INVALID' ? 'OUT_OF_SCOPE' : result.reason);

        const base: CommandOutput = {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          backend: result.backend,
          sandboxDenials: result.denials,
        };
        const head = `${statusLine(base)}\n`;
        const room = Math.max(1, limits.maxBytes - Buffer.byteLength(head, 'utf8') - FRAME_BYTES);
        const mediaType = MEDIA_TYPES.fileText;
        const preview = previewOf(result.output, room, limits.maxLines);
        if (preview.omittedBytes === 0 && !result.truncated)
          return completed({ output: base, artifact: { mediaType, text: head + result.output } });
        const notice =
          `\n[${String(preview.omittedBytes)} bytes of output left out of the middle` +
          `${result.truncated ? ' (the full output is cut as well)' : ''}. ` +
          'The full output is kept for 7 days; read it with read_output.]';
        return completed({
          output: {
            ...base,
            retention: {
              strategy: 'BOTH',
              unit: 'BYTES',
              limit: room,
              retained: preview.retainedBytes,
              omitted: Math.max(1, preview.omittedBytes),
              fullOutputTruncated: result.truncated,
            },
          },
          artifact: { mediaType, text: `${head}${preview.head}${notice}${preview.tail}` },
          fullOutput: { text: result.output },
        });
      }),
  };
}

const fullOutputLimit = (environment: ExecutorEnvironment): number =>
  'maxFullOutputBytes' in environment.limits
    ? environment.limits.maxFullOutputBytes
    : environment.limits.maxOutputBytes;

/** Head and tail within `maxBytes` and `maxLines` together. */
function previewOf(
  text: string,
  maxBytes: number,
  maxLines: number,
): { head: string; tail: string; omittedBytes: number; retainedBytes: number } {
  const lines = text.split('\n');
  const total = Buffer.byteLength(text, 'utf8');
  const byBytes = retainBytes(text, maxBytes, 'BOTH');
  let { head, tail } = byBytes;
  // Fewer lines than the byte cut kept: shrink both ends until the lines fit.
  const budget = Math.max(2, maxLines - 3);
  const kept = head.split('\n').length + tail.split('\n').length;
  if (kept > budget) {
    const half = Math.floor(budget / 2);
    head = lines.slice(0, half).join('\n');
    tail = lines.slice(Math.max(half, lines.length - (budget - half))).join('\n');
  }
  const retainedBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  return { head, tail, omittedBytes: Math.max(0, total - retainedBytes), retainedBytes };
}
