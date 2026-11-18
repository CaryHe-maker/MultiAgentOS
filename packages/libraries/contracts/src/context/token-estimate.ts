import type { ModelToolCall } from '../executor/model-tool-call.js';
import { canonicalJson } from '../platform-common/canonical-json.js';
import type { ModelToolSpec } from './context-pack.js';

/** The fields of a ContextItem that are sent to the provider and therefore counted. */
export interface CountedItem {
  readonly role: string;
  readonly content: string;
  readonly reasoningContent?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly toolSpecs?: readonly ModelToolSpec[];
}

/** What the provider counted for the last request of an AgentRun, beside its own estimate. */
export interface TokenCalibration {
  readonly measuredInputTokens: number;
  readonly estimatedInputTokens: number;
}

const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff';
const SEGMENT = new RegExp(
  `[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+|[${CJK}]+|\\n+|[ \\t\\r]+|[!-/:-@\\[-\`{-~]|[^]`,
  'gu',
);
const IS_CJK = new RegExp(`^[${CJK}]`, 'u');

/** Tokens of one Latin word by its length, then per letter above that (docs/experiments.md). */
const WORD_TOKENS = [0.5, 2.08, 0.8, 0.9, 0.9, 1, 1.2, 1.2, 3.96, 3.96, 3.96, 3.96];
const LONG_WORD_LETTER = 0.15;
const DIGIT_GROUP = 1.26;
const CJK_CHARACTER = 0.59;
const NEWLINE_RUN = 1.07;
const PUNCTUATION = 0.52;
const ASTRAL_CHARACTER = 0.81;
const OTHER_CHARACTER = 2.05;
const TOOL_LIST = 2.5;

function textTokens(text: string): number {
  let tokens = 0;
  for (const [segment] of text.matchAll(SEGMENT)) {
    const first = segment.charCodeAt(0);
    const length = segment.length;
    if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122))
      tokens += WORD_TOKENS[length - 1] ?? length * LONG_WORD_LETTER;
    else if (first >= 48 && first <= 57) tokens += Math.ceil(length / 3) * DIGIT_GROUP;
    else if (first === 10) tokens += NEWLINE_RUN;
    else if (first === 32 || first === 9 || first === 13) continue;
    else if (first > 32 && first < 127) tokens += PUNCTUATION;
    else if (IS_CJK.test(segment)) tokens += CJK_CHARACTER * length;
    else if (length > 1) tokens += ASTRAL_CHARACTER;
    else tokens += OTHER_CHARACTER;
  }
  return tokens;
}

/**
 * The tokens DeepSeek counts for a text, fitted to the provider's own counts: the classes of
 * segments and their weights approximate its BPE without its 6 MB vocabulary. A figure that
 * decides a limit goes through `calibratedTokens`, which corrects most of the remaining error.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(textTokens(text));
}

/**
 * The input tokens of one item. Context assembly, the reservation and the start-up budget check
 * all use this function, so they cannot disagree. Replayed reasoning counts as input.
 */
export function estimateItemTokens(item: CountedItem): number {
  let tokens = textTokens(item.content);
  if (item.reasoningContent !== undefined) tokens += textTokens(item.reasoningContent);
  if (item.toolCalls !== undefined) tokens += textTokens(canonicalJson(item.toolCalls));
  if (item.toolSpecs !== undefined) tokens += textTokens(canonicalJson(item.toolSpecs)) + TOOL_LIST;
  return Math.ceil(tokens);
}

export function estimatePackTokens(pack: { readonly items: readonly CountedItem[] }): number {
  return pack.items.reduce((total, item) => total + estimateItemTokens(item), 0);
}

/** Below this share of the measured request, the two no longer share a prefix worth scaling. */
const SAME_PREFIX_SHARE = 0.7;

/**
 * Scales an estimate by how the last request's estimate compared with the provider's count: most
 * of a request is the previous one, so the error left is that of what was added.
 */
export function calibratedTokens(estimate: number, calibration?: TokenCalibration): number {
  if (calibration === undefined) return estimate;
  const { measuredInputTokens, estimatedInputTokens } = calibration;
  if (estimatedInputTokens <= 0 || estimate < estimatedInputTokens * SAME_PREFIX_SHARE)
    return estimate;
  return Math.ceil((estimate * measuredInputTokens) / estimatedInputTokens);
}
