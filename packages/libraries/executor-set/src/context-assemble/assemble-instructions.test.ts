import { describe, expect, it } from 'vitest';
import { instructionsText } from './assemble-executor.js';

const entry = (text: string, trusted = true) =>
  ({ kind: 'PROJECT_INSTRUCTIONS', path: 'AGENTS.md', trusted, text }) as Parameters<
    typeof instructionsText
  >[0];

describe('the instructions file in the context', () => {
  it('is shown whole when it fits, with nothing added', () => {
    const shown = instructionsText(entry('Use pnpm.\n'));
    expect(shown).toBe('Project instructions (AGENTS.md, trusted by the user):\nUse pnpm.\n');
  });

  it('is cut on a character, never in the middle of one, and says how much is not shown', () => {
    // 64 KiB is not a multiple of the three bytes of this character: a cut by bytes splits one.
    const shown = instructionsText(entry('你'.repeat(30_000)));
    expect(shown).not.toContain('�');
    expect(shown).toMatch(/\n\[cut: \d+ bytes of the file are not shown\]$/u);
    const body = shown.split('\n').slice(1, -1).join('\n');
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(body.length).toBeGreaterThan(21_000);
  });

  it('keeps the label that says whether the user trusted it', () => {
    expect(instructionsText(entry('x', false))).toContain('not trusted by the user');
  });
});
