import {
  MEDIA_TYPES,
  canonicalJson,
  estimateItemTokens,
  newId,
  sha256Hex,
  type AssembleContextPack,
  type ContextPack,
} from '@multiagentos/contracts';

type AnyItem = AssembleContextPack['items'][number];

/** A ContextItem before the fields derived from its content and its place in the pack. */
export type ItemDraft<Item extends AnyItem = AnyItem> = Item extends unknown
  ? Omit<Item, 'itemId' | 'contentSha256' | 'tokenCount'>
  : never;

/** The token count an item will have once finished (contracts `estimateItemTokens`). */
export function draftTokens(draft: ItemDraft): number {
  return estimateItemTokens(draft);
}

/** Numbers the drafts and fills `contentSha256` and `tokenCount`. */
export function finishItems<Item extends AnyItem>(
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
export function packArtifact(pack: ContextPack): {
  mediaType: string;
  text: string;
} {
  return { mediaType: MEDIA_TYPES.contextPack, text: canonicalJson(pack) };
}
