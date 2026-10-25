import {
  validate,
  SearchContextPackSchema,
  type HandoffBrief,
  type ModelToolSpec,
  type Provenance,
  type ResolvedStep,
  type SearchContextPack,
  type StatusFacts,
  type ToolResultStep,
  type UnitFailedCode,
  type UnitRejectedCode,
  type WrapUpReason,
} from '@multiagentos/contracts';
import { numberLines, parseText } from '../text/text-document.js';

/**
 * How AgentRun content is written for the model (issue #26, D). Everything is plain text: M0
 * measured that JSON tool results cost 18% more input tokens than numbered text for no gain
 * (`experiments/minimal-agent-loop/RUNS.md`, C4).
 */

export const ELIDED_RESULT =
  '[Output omitted to fit the context budget; call the tool again with a narrower range if you still need it.]';

export function renderObjective(objective: string): string {
  return `User question:\n${objective}`;
}

export function renderHandoff(handoff: HandoffBrief): string {
  const list = (title: string, entries: readonly string[]) =>
    entries.length === 0 ? [] : [`${title}:`, ...entries.map((entry) => `- ${entry}`)];
  return [
    'Task handed over by the planner:',
    handoff.task,
    ...list('Focus areas', handoff.focusAreas),
    ...list('Open questions', handoff.openQuestions),
  ].join('\n');
}

const REJECTED_HINTS: Record<UnitRejectedCode, string> = {
  INVALID_INPUT: 'the arguments do not match the tool parameters; fix them and call again',
  INVALID_ARTIFACT_REF: 'an internal reference was invalid; continue with what you have',
  USER_DECLINED:
    'repository access was not granted (declined or not answered in time); answer from what you already have',
  BUDGET_WRAP_UP: 'the budget is nearly used up; finish with what you already have',
  BUDGET_EXHAUSTED: 'the budget is used up; finish with what you already have',
  FINAL_CALL_USED: 'no more tool calls are possible; finish now',
  OUT_OF_SCOPE:
    'the path is outside the readable repository (absolute, `..`, or a protected file such as .env, keys or node_modules); use a relative path inside the repository',
  NOT_FOUND:
    'no file at this path; use search_repository with mode PATH to find the right path, and do not guess paths',
  UNSUPPORTED_FILE:
    'the path is a directory, a binary file or not UTF-8 text; read a UTF-8 text file instead',
  INVALID_RANGE:
    'the line range is outside the file; check totalLines and ask for an existing range',
  INVALID_QUERY:
    'the query is empty or not usable for this mode (SYMBOL needs a plain identifier such as parseConfig); change it',
  LIMIT_EXCEEDED: 'the result would be too large; ask for a smaller range or a more specific query',
};

const FAILED_HINTS: Record<UnitFailedCode, string> = {
  PROVIDER_UNREACHABLE: 'the model provider could not be reached',
  PROVIDER_RATE_LIMITED: 'the model provider is rate limiting',
  PROVIDER_AUTH: 'the model provider refused the credentials',
  PROVIDER_ERROR: 'the model provider returned an error',
  INTERNAL: 'the tool failed internally; try a different request',
  UNIT_TIMEOUT: 'the tool took too long; try a narrower request',
};

/** What a tool result says to the model, and the repository range it shows when it shows one. */
export interface RenderedResult {
  readonly content: string;
  readonly provenance?: Provenance;
  /** True when the content is the body of a successful result, which trimming may elide. */
  readonly hasBody: boolean;
}

export function renderToolResult(
  resolved: ResolvedStep & { step: ToolResultStep },
): RenderedResult {
  const { step, outputText } = resolved;
  if (step.status === 'REJECTED')
    return {
      content: `Error ${step.reasonCode}: ${REJECTED_HINTS[step.reasonCode]}.`,
      hasBody: false,
    };
  if (step.status === 'FAILED')
    return {
      content: `Error ${step.reasonCode}: ${FAILED_HINTS[step.reasonCode]}.`,
      hasBody: false,
    };
  const text = outputText ?? '';
  if ('hits' in step.output) return { content: renderSearch(step.output, text), hasBody: true };
  const { path, startLine, endLine, totalLines, contentSha256 } = step.output;
  if (totalLines === 0) return { content: `${path} (empty file)`, hasBody: true };
  const lines = parseText(text).lines;
  const rest =
    endLine < totalLines
      ? `\n[Lines ${endLine + 1}-${totalLines} not shown; call read_file with startLine ${endLine + 1} to continue.]`
      : '';
  return {
    content: `${path} (lines ${startLine}-${endLine} of ${totalLines})\n${numberLines(lines, startLine)}${rest}`,
    provenance: { path, startLine, endLine, contentSha256, retrieval: 'FILE_READ' },
    hasBody: true,
  };
}

function renderSearch(
  output: { hits: readonly unknown[]; truncated: boolean },
  packText: string,
): string {
  let pack: SearchContextPack | undefined;
  try {
    const parsed = validate<SearchContextPack>(SearchContextPackSchema, JSON.parse(packText));
    if (parsed.ok) pack = parsed.value;
  } catch {
    pack = undefined;
  }
  const items = pack?.items ?? [];
  if (items.length === 0)
    return 'No matches. Try a shorter or different query, another mode (TEXT, PATH or SYMBOL), or a name you saw in a file.';
  const more = output.truncated
    ? '\n[More matches exist; refine the query or use read_file on the most relevant files.]'
    : '';
  return `${items.length} matches:\n\n${items.map((item) => item.content).join('\n\n')}${more}`;
}

export function renderFeedback(code: string, message: string): string {
  return `[${code}] ${message}`;
}

const WRAP_UP_REASONS: Record<WrapUpReason, string> = {
  ROUND_LIMIT: 'the round limit has been reached',
  BUDGET_WRAP_UP: 'the token budget is nearly used up',
  BUDGET_EXHAUSTED: 'the token budget is used up',
  USER_DECLINED: 'repository access was not granted (declined or not answered in time)',
  NO_PROGRESS: 'the last rounds made no progress',
  REGENERATION_LIMIT: 'too many replies were invalid',
};

/**
 * The only segment that changes every call, so it goes last and the provider's prefix cache
 * covers everything before it.
 */
export function renderStatus(status: StatusFacts, toolSpecs: readonly ModelToolSpec[]): string {
  const lines = [
    `Status: ${status.roundsUsed} of ${status.maxRounds} rounds used. Budget: ${status.budgetState}.`,
  ];
  if (status.final) {
    const finish = toolSpecs.filter((spec) => spec.purpose === 'CONTROL').map((spec) => spec.name);
    const reason =
      status.wrapUpReason === undefined ? '' : ` because ${WRAP_UP_REASONS[status.wrapUpReason]}`;
    lines.push(
      `This is your final call${reason}. Call ${finish.join(' or ') || 'the finish tool'} now with your best answer; cite only content you have read and list what you could not confirm.`,
    );
    return lines.join('\n');
  }
  const left = status.maxRounds - status.roundsUsed;
  if (status.budgetState !== 'NORMAL' || left <= 2)
    lines.push(
      `Only ${left} round${left === 1 ? '' : 's'} left: prioritize and prepare to finish.`,
    );
  return lines.join('\n');
}
