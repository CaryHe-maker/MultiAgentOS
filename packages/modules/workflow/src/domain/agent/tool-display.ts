import type { AgentDefinitions, AgentEnding } from './agent-cycle.js';

/**
 * What the interface shows of a tool call on its line (only the interface: it goes into no log
 * record): the tool and the one argument that says what it does, on one line, at most 80
 * characters, as the activity contract takes.
 */

const LIMIT = 80;

/** One line, cut to the limit with an ellipsis. */
export function oneLine(text: string, limit = LIMIT): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

const field = (args: unknown, name: string): string | undefined => {
  if (args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/** The argument that names what a call does: a command, a path, a pattern, a query, an address. */
export function argsSummaryOf(args: unknown): string {
  const pattern = field(args, 'pattern');
  const path = field(args, 'path');
  if (pattern !== undefined) return oneLine(path === undefined ? pattern : `${pattern} in ${path}`);
  for (const name of ['command', 'path', 'query', 'url', 'toolCallId', 'ref', 'operation'])
    if (field(args, name) !== undefined) return oneLine(field(args, name) ?? '');
  return '';
}

const listed = (items: unknown, key: string): string[] =>
  Array.isArray(items)
    ? items.flatMap((item) => {
        const value = field(item, key);
        return value === undefined ? [] : [value];
      })
    : [];

/**
 * A control call, shown as a line because it runs no Unit: whom a message goes to and what it
 * says first, what a sleep waits for, which tasks are started or stopped.
 */
export function controlSummaryOf(
  kind: 'MESSAGE' | 'VIEW_TASKS' | 'SPAWN' | 'SLEEP' | 'STOP' | 'JOB',
  args: unknown,
): string {
  switch (kind) {
    case 'MESSAGE': {
      const to = field(args, 'to') ?? '?';
      const sort = field(args, 'kind');
      const interrupt =
        args !== null && typeof args === 'object' && (args as { interrupt?: unknown }).interrupt
          ? ' interrupt'
          : '';
      const said = field(args, 'summary') ?? field(args, 'text') ?? '';
      return oneLine(
        `to ${to}${sort === undefined || sort === 'inform' ? '' : ` (${sort})`}${interrupt}: ${said}`,
      );
    }
    case 'VIEW_TASKS':
      return '';
    case 'SPAWN': {
      const names = listed((args as { tasks?: unknown } | null)?.tasks, 'name');
      return oneLine(
        `${String(names.length)} task${names.length === 1 ? '' : 's'}: ${names.join(', ')}`,
      );
    }
    case 'SLEEP': {
      const until = (args as { until?: unknown } | null)?.until;
      const kinds = listed(until, 'kind');
      const seconds = (args as { timeoutSeconds?: unknown } | null)?.timeoutSeconds;
      return oneLine(
        `until ${kinds.join(' or ') || 'woken'}${typeof seconds === 'number' ? `, at most ${String(seconds)} s` : ''}`,
      );
    }
    case 'STOP': {
      const names = (args as { names?: unknown } | null)?.names;
      return oneLine(
        Array.isArray(names) ? names.filter((each) => typeof each === 'string').join(', ') : '',
      );
    }
    case 'JOB':
      return oneLine(field(args, 'jobId') ?? '');
  }
}

/**
 * The line of a control call the runner took (Orchestration 5.3): its tool and what it does. A
 * finishing call and a question are not among them: the interface shows their result instead.
 */
export function controlLineOf(
  definitions: AgentDefinitions,
  ending: AgentEnding,
): { readonly toolName: string; readonly argsSummary: string } | undefined {
  const line = (tool: { readonly toolName: string } | undefined, argsSummary: string) =>
    tool === undefined ? undefined : { toolName: tool.toolName, argsSummary };
  switch (ending.kind) {
    case 'MESSAGE':
      return line(definitions.messageTool, controlSummaryOf('MESSAGE', ending.arguments));
    case 'VIEW_TASKS':
      return line(definitions.viewTasksTool, '');
    case 'SPAWN':
      return line(definitions.spawnTool, controlSummaryOf('SPAWN', ending.arguments));
    case 'SLEEP':
      return line(definitions.sleepTool, controlSummaryOf('SLEEP', ending.arguments));
    case 'STOP':
      return line(definitions.stopTool, controlSummaryOf('STOP', ending.arguments));
    case 'JOB':
      return line(
        definitions.jobTools?.find((each) => each.action === ending.action),
        controlSummaryOf('JOB', ending.arguments),
      );
    default:
      return undefined;
  }
}
