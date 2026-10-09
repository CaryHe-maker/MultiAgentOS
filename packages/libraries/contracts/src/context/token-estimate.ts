import { canonicalJson } from '../platform-common/canonical-json.js';
import type { ContextItem, ContextPack } from './context-pack.js';

const ITEM_OVERHEAD = 16;

/** UTF-8 byte length: a BPE token covers at least one byte, so this is an upper bound. */
export function estimateTextTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Upper bound of the input tokens of one item (M1Interface 6.3). Context assembly, the
 * reservation and the start-up budget check all use this function, so they cannot disagree.
 */
export function estimateItemTokens(
  item: Pick<ContextItem, 'role' | 'content' | 'toolCallId' | 'toolCalls' | 'toolSpecs'>,
): number {
  const counted = {
    role: item.role,
    content: item.content,
    ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }),
    ...(item.toolCalls === undefined ? {} : { toolCalls: item.toolCalls }),
    ...(item.toolSpecs === undefined ? {} : { toolSpecs: item.toolSpecs }),
  };
  return estimateTextTokens(canonicalJson(counted)) + ITEM_OVERHEAD;
}

export function estimatePackTokens(pack: Pick<ContextPack, 'items'>): number {
  return pack.items.reduce((total, item) => total + estimateItemTokens(item), 0);
}
