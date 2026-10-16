import type { AnalysisReport, AuthorizationRequest, RunSummary } from '@multiagentos/contracts';
import { InteractionMessages as messages, describeReason } from './interaction-messages.js';

/** Escape C0, DEL and C1 controls; LF remains available for ordinary text layout. */
function terminalText(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code !== 10 && (code < 32 || (code >= 127 && code <= 159))
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character;
    })
    .join('');
}

/**
 * Why the last call of a degraded run did not finish. The report will carry it as a structured
 * field; the text is always written here, never by Workflow.
 */
export type ReportLastIssue =
  | { readonly kind: 'FAILURE'; readonly code: string }
  | { readonly kind: 'INVALID_OUTPUT'; readonly reason: string }
  | { readonly kind: 'NO_FINISH' };

/** Facts shown with a report that the report Schema does not carry yet. */
export interface ReportExtras {
  readonly lastIssue?: ReportLastIssue;
  readonly emptyPaths?: readonly string[];
}

function describeLastIssue(issue: ReportLastIssue): string {
  if (issue.kind === 'FAILURE') return messages.lastFailure(describeReason(issue.code));
  if (issue.kind === 'INVALID_OUTPUT')
    return messages.lastInvalidOutput(
      Object.hasOwn(messages.invalidOutput, issue.reason)
        ? (messages.invalidOutput[issue.reason] ?? messages.genericReason)
        : messages.genericReason,
    );
  return messages.lastNoFinish;
}

/**
 * Produces plain Chinese terminal text without exposing internal diagnostics. A normal report
 * shows the model's summary as written; a degraded report has no model text, so its ending is
 * described from `wrapUp` and its placeholder summary is not shown.
 */
export function renderReport(report: AnalysisReport, extras: ReportExtras = {}): string {
  const lines = report.degraded
    ? [messages.degraded, messages.degradedReason[report.wrapUp.reason]]
    : [messages.reportTitle, report.summary];
  if (report.degraded && extras.lastIssue !== undefined)
    lines.push(describeLastIssue(extras.lastIssue));
  for (const conclusion of report.conclusions) {
    lines.push(messages.conclusion(conclusion.statement));
    for (const source of conclusion.sources)
      lines.push(messages.source(source.path, source.startLine, source.endLine));
  }
  for (const item of report.unconfirmed)
    lines.push(messages.unconfirmedItem(item.statement, messages.unconfirmedReason[item.reason]));
  if (!report.degraded && report.wrapUp !== undefined)
    lines.push(messages.wrapUpLine(messages.wrapUp[report.wrapUp.reason]));
  if (extras.emptyPaths !== undefined && extras.emptyPaths.length > 0)
    lines.push(messages.emptyFiles(extras.emptyPaths.length));
  return terminalText(lines.join('\n') + '\n');
}

export function renderQuestion(question: AuthorizationRequest): string {
  return terminalText(
    [
      messages.repository(question.repositoryPath),
      messages.exclusions(question.exclusions),
      messages.provider(question.provider),
      messages.expiresAt(question.expiresAt),
    ].join('\n') + '\n',
  );
}

export function renderSummary(summary: RunSummary): string {
  const lines: string[] = [messages.summaryTitle];
  for (const agent of summary.agentRuns)
    lines.push(messages.agentRounds(agent.agentRef.id, agent.rounds));
  lines.push(
    messages.unitCounts(
      summary.units.submitted,
      summary.units.ok,
      summary.units.rejected,
      summary.units.failed,
      summary.units.notDelivered,
    ),
    messages.modelCalls(summary.model.requests),
    messages.tokenCounts(summary.tokens.used, summary.tokens.unknown, summary.tokens.limit),
    messages.duration(summary.durationMs),
  );
  if ('failure' in summary && summary.failure !== undefined) {
    lines.push(
      messages.failureCategory(
        messages.category[summary.failure.category] ?? messages.unknownCategory,
      ),
    );
    lines.push(describeReason(summary.failure.code));
  }
  return terminalText(lines.join('\n') + '\n');
}
