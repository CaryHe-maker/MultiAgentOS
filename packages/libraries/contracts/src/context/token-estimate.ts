import type { ModelToolCall } from '../executor/model-tool-call.js';
import { canonicalJson } from '../platform-common/canonical-json.js';
import type { ModelToolSpec } from './context-pack.js';

const ITEM_OVERHEAD = 16;

/** The fields of a ContextItem that are sent to the provider and therefore counted. */
export interface CountedItem {
  readonly role: string;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly toolSpecs?: readonly ModelToolSpec[];
}

/** UTF-8 byte length: a BPE token covers at least one byte, so this is an upper bound. */
export function estimateTextTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Upper bound of the input tokens of one item (M1Interface 6.3). Context assembly, the
 * reservation and the start-up budget check all use this function, so they cannot disagree.
 */
export function estimateItemTokens(item: CountedItem): number {
  const counted = {
    role: item.role,
    content: item.content,
    ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }),
    ...(item.toolCalls === undefined ? {} : { toolCalls: item.toolCalls }),
    ...(item.toolSpecs === undefined ? {} : { toolSpecs: item.toolSpecs }),
  };
  return estimateTextTokens(canonicalJson(counted)) + ITEM_OVERHEAD;
}

export function estimatePackTokens(pack: { readonly items: readonly CountedItem[] }): number {
  return pack.items.reduce((total, item) => total + estimateItemTokens(item), 0);
}
