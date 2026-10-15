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

/** Produces plain Chinese terminal text without exposing internal diagnostics. */
export function renderReport(report: AnalysisReport): string {
  const lines = [report.degraded ? messages.degraded : messages.reportTitle, report.summary];
  for (const conclusion of report.conclusions) {
    lines.push(messages.conclusion(conclusion.statement));
    for (const source of conclusion.sources)
      lines.push(messages.source(source.path, source.startLine, source.endLine));
  }
  for (const item of report.unconfirmed)
    lines.push(messages.unconfirmedItem(item.statement, messages.unconfirmedReason[item.reason]));
  if (report.wrapUp !== undefined)
    lines.push(messages.wrapUpLine(messages.wrapUp[report.wrapUp.reason]));
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
