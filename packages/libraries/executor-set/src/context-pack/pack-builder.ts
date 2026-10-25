import {
  MEDIA_TYPES,
  canonicalJson,
  estimateItemTokens,
  newId,
  sha256Hex,
  type ContextItem,
  type ContextPack,
} from '@multiagentos/contracts';

/** A ContextItem before the fields derived from its content and its place in the pack. */
export type ItemDraft<Item extends ContextItem = ContextItem> = Item extends unknown
  ? Omit<Item, 'itemId' | 'contentSha256' | 'tokenCount'>
  : never;

/** The token count an item will have once finished (contracts `estimateItemTokens`). */
export function draftTokens(draft: ItemDraft): number {
  return estimateItemTokens(draft);
}

/** Numbers the drafts and fills `contentSha256` and `tokenCount`. */
export function finishItems<Item extends ContextItem>(
  contextPackId: string,
  drafts: readonly ItemDraft<Item>[],
): Item[] {
  return drafts.map(
    (draft, index) =>
      ({
        ...draft,
        itemId: `${contextPackId}:${index}`,
        contentSha256: sha256Hex(draft.content),
        tokenCount: estimateItemTokens(draft),
      }) as Item,
  );
}

export function newContextPackId(): string {
  return newId('ctx');
}

export function packTokens(items: readonly { readonly tokenCount: number }[]): number {
  return items.reduce((total, item) => total + item.tokenCount, 0);
}

/** The artifact of a ContextPack: its canonical JSON (SharedContracts 4.3). */
export function packArtifact(pack: ContextPack): { mediaType: string; text: string } {
  return { mediaType: MEDIA_TYPES.contextPack, text: canonicalJson(pack) };
}

/**
 * Greedy fit used by orient and search: keeps the drafts in order while they fit the budget and
 * skips the ones that do not, so a large item never hides smaller ones after it.
 */
export function fitToBudget<Draft extends ItemDraft>(
  drafts: readonly Draft[],
  tokenBudget: number,
): { kept: Draft[]; dropped: number } {
  const kept: Draft[] = [];
  let used = 0;
  let dropped = 0;
  for (const draft of drafts) {
    const tokens = draftTokens(draft);
    if (used + tokens <= tokenBudget) {
      kept.push(draft);
      used += tokens;
    } else dropped += 1;
  }
  return { kept, dropped };
}
