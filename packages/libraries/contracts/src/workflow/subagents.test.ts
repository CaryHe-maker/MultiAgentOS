import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_REPORT_CHARS,
  SUBAGENT_REPORT_LINES,
  SUBAGENT_SUMMARY_CHARS,
  subagentAsWrittenText,
  subagentFullText,
  subagentShownText,
} from './subagents.js';

describe('what a caller is shown of a result', () => {
  it('is the summary and the report whole when the report fits', () => {
    expect(subagentShownText({ summary: 'short', report: 'a\nb' }, 'call_1')).toBe('short\n\na\nb');
    expect(subagentShownText({ summary: 'short' }, 'call_1')).toBe('short');
  });

  it('is the summary and the id to read by when the report has too many lines', () => {
    const report = 'x\n'.repeat(SUBAGENT_REPORT_LINES);
    const shown = subagentShownText({ summary: 'short', report }, 'call_1');
    expect(shown.startsWith('short\n\n[the report is')).toBe(true);
    expect(shown).toContain('read_output, toolCallId call_1');
    expect(shown).not.toContain('x\nx');
  });

  it('is the same when the report has too many characters on few lines', () => {
    const shown = subagentShownText(
      { summary: 'short', report: 'y'.repeat(SUBAGENT_REPORT_CHARS + 1) },
      'call_2',
    );
    expect(shown).toContain('read all of it with read_output, toolCallId call_2');
    expect(shown.length).toBeLessThan(400);
  });

  it('keeps a report exactly at the limits', () => {
    const report = 'y'.repeat(SUBAGENT_REPORT_CHARS);
    expect(subagentShownText({ summary: 's', report }, 'call_3')).toBe(`s\n\n${report}`);
  });

  it('cuts a summary longer than asked and says where all of it is, and never refuses it', () => {
    const shown = subagentShownText({ summary: 's'.repeat(SUBAGENT_SUMMARY_CHARS + 50) }, 'call_4');
    expect(shown).toContain('[summary cut:');
    expect(shown).toContain('toolCallId call_4');
  });

  it('is read back whole, summary first', () => {
    expect(subagentFullText({ summary: 's', report: 'r' })).toBe('s\n\nr');
    expect(subagentFullText({ summary: 's' })).toBe('s');
  });

  it('shows a call that does not follow the form as it was written, within the same limits', () => {
    expect(subagentAsWrittenText('{"report":"x"}', 'call_5')).toBe('{"report":"x"}');
    const long = subagentAsWrittenText('z'.repeat(SUBAGENT_REPORT_CHARS + 1), 'call_5');
    expect(long).toContain('toolCallId call_5');
    expect(long.length).toBeLessThan(2400);
  });
});
