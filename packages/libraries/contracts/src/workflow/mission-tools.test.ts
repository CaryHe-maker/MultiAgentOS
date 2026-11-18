import { describe, expect, it } from 'vitest';
import {
  MESSAGE_HEAD_CHARS,
  MESSAGE_SHOWN_CHARS,
  MESSAGE_SHOWN_LINES,
  SendMessageArgsSchema,
  messageFullText,
  messageIsLong,
  messageShownText,
} from './mission-tools.js';
import { validate } from '../platform-common/validation.js';

describe('a long message (Orchestration 5.3)', () => {
  it('is taken whatever its length', () => {
    const text = 'x'.repeat(MESSAGE_SHOWN_CHARS * 5);
    expect(validate(SendMessageArgsSchema, { to: 'ui', summary: 's', text }).ok).toBe(true);
  });

  it('is long by its characters or by its lines', () => {
    expect(messageIsLong('x'.repeat(MESSAGE_SHOWN_CHARS))).toBe(false);
    expect(messageIsLong('x'.repeat(MESSAGE_SHOWN_CHARS + 1))).toBe(true);
    expect(messageIsLong('a\n'.repeat(MESSAGE_SHOWN_LINES))).toBe(true);
  });

  it('is shown whole when it fits, otherwise by its beginning and how to read the rest', () => {
    expect(messageShownText('short', 'call_1')).toBe('short');
    const text = `${'a'.repeat(MESSAGE_HEAD_CHARS)}${'b'.repeat(MESSAGE_SHOWN_CHARS)}`;
    const shown = messageShownText(text, 'call_1');
    expect(shown.startsWith('a'.repeat(MESSAGE_HEAD_CHARS))).toBe(true);
    expect(shown).not.toContain('b');
    expect(shown).toContain(
      `[the message is 1 lines and ${String(text.length)} characters, too long to show here; read all of it with read_output, toolCallId call_1]`,
    );
  });

  it('is read back whole: the summary, then the text', () => {
    expect(messageFullText({ summary: 'The API', text: 'GET /keys' })).toBe('The API\n\nGET /keys');
    expect(messageFullText({ text: 'GET /keys' })).toBe('GET /keys');
    expect(messageFullText({ summary: ' ', text: 'GET /keys' })).toBe('GET /keys');
  });
});
