import type {
  AnalysisReport,
  AuthorizationRequest,
  ReportLastIssue,
  RunSummary,
} from '@multiagentos/contracts';
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

function describeLastIssue(issue: ReportLastIssue): string {
  if (issue.kind === 'FAILURE') return messages.lastFailure(describeReason(issue.code));
  if (issue.kind === 'INVALID_OUTPUT')
    return messages.lastInvalidOutput(
      messages.invalidOutput[issue.reason] ?? messages.genericReason,
    );
  return messages.lastNoFinish;
}

const INDENT = '  ';

/** `text` under `head`, every line of it indented by `pad`. */
function block(head: string, text: string, pad: string): string[] {
  const [first = '', ...rest] = text.split('\n');
  return [head + first, ...rest.map((line) => pad + line)];
}

/** One numbered entry: its text, then its detail lines aligned under the text. */
function entry(index: number, text: string, details: readonly string[]): string[] {
  const label = `${index + 1}. `;
  const pad = INDENT + ' '.repeat(label.length);
  return [...block(INDENT + label, text, pad), ...details.map((line) => pad + line)];
}

/** Source lines: the first carries the label, the others line up under its first path. */
function sourceLines(sources: AnalysisReport['conclusions'][number]['sources']): string[] {
  // The label is three full-width characters, six terminal columns.
  const pad = ' '.repeat(6);
  return sources.map(
    (source, index) =>
      (index === 0 ? messages.sourceLabel : pad) +
      messages.source(source.path, source.startLine, source.endLine),
  );
}

/**
 * Produces plain Chinese terminal text without exposing internal diagnostics. A normal report
 * shows the model's summary as written under "回答", then numbered conclusions with their
 * sources and numbered unverified points with why each is not a conclusion. A degraded report
 * has no model text, so its ending is described from `wrapUp` and its placeholder summary is
 * not shown.
 */
export function renderReport(report: AnalysisReport): string {
  const lines: string[] = [];
  if (report.degraded) {
    lines.push(messages.degraded, messages.degradedReason[report.wrapUp.reason]);
    if (report.wrapUp.lastIssue !== undefined)
      lines.push(describeLastIssue(report.wrapUp.lastIssue));
  } else {
    lines.push(messages.reportTitle, '', messages.answerTitle);
    lines.push(...block(INDENT, report.summary, INDENT));
    if (report.conclusions.length > 0) {
      lines.push('', messages.conclusionsTitle);
      report.conclusions.forEach((conclusion, index) =>
        lines.push(...entry(index, conclusion.statement, sourceLines(conclusion.sources))),
      );
    }
    if (report.unconfirmed.length > 0) {
      lines.push('', messages.unconfirmedTitle);
      report.unconfirmed.forEach((item, index) =>
        lines.push(
          ...entry(index, item.statement, [`（${messages.unconfirmedReason[item.reason]}）`]),
        ),
      );
    }
    lines.push('');
    if (report.wrapUp !== undefined)
      lines.push(messages.wrapUpLine(messages.wrapUp[report.wrapUp.reason]));
  }
  if (report.emptyReads !== undefined && report.emptyReads.length > 0)
    lines.push(messages.emptyFiles(report.emptyReads.length));
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
