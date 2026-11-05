import type { ParsedCommand } from './command-parser.js';

/**
 * Matching of `deniedCommands` and `criticalCommands` (M2Design 5.2): a pattern is a command name
 * with optional leading words (`git push`, `gh`). It matches when any simple command of the syntax
 * tree starts with those words, or when the original text holds them as whole words. The two
 * results are joined, so a command the tree could not read is still checked against the text.
 */
const ESCAPE = /[.*+?^${}()|[\]\\]/gu;

function textMatches(raw: string, words: readonly string[]): boolean {
  const body = words.map((word) => word.replace(ESCAPE, '\\$&')).join('\\s+');
  // The words must start a command (line start or after a separator) and end at a word boundary.
  const pattern = new RegExp(`(?:^|[\\s;&|(){}\`])${body}(?=$|[\\s;&|(){}\`])`, 'u');
  return pattern.test(raw);
}

export function matchesCommandPattern(
  parsed: ParsedCommand,
  raw: string,
  pattern: string,
): boolean {
  const words = pattern.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return false;
  for (const command of parsed.subcommands) {
    if (command.name === undefined) continue;
    const have = [command.name, ...command.args];
    if (words.every((word, index) => have[index] === word)) return true;
  }
  return textMatches(raw, words);
}

/** The first pattern that matches, or undefined. */
export function firstMatchingPattern(
  parsed: ParsedCommand,
  raw: string,
  patterns: readonly string[],
): string | undefined {
  return patterns.find((pattern) => matchesCommandPattern(parsed, raw, pattern));
}
