import { canonicalJson, sha256Hex } from '@multiagentos/contracts';

export type LedgerLookup<T> =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly response: T }
  | { readonly kind: 'conflict' };

interface LedgerEntry {
  readonly fingerprint: string;
  readonly response: unknown;
}

/**
 * Request records of the run manager (docs/M1/Kernel/Interaction.md 4.1 and
 * M1Interface 2.3). `createRun` and `shutdown` are recorded here because they do not belong to
 * a run actor. A run's own request records use the same rules inside the Core state block.
 */
export class RequestLedger {
  readonly #entries = new Map<string, LedgerEntry>();

  public lookup<T>(requestId: string, payload: unknown): LedgerLookup<T> {
    const entry = this.#entries.get(requestId);
    if (entry === undefined) return { kind: 'new' };
    if (entry.fingerprint !== fingerprintOf(payload)) return { kind: 'conflict' };
    return { kind: 'replay', response: entry.response as T };
  }

  public remember<T>(requestId: string, payload: unknown, response: T): void {
    this.#entries.set(requestId, { fingerprint: fingerprintOf(payload), response });
  }
}

/** Canonical JSON SHA-256, as required for request idempotency (M1Interface 2.3). */
export function fingerprintOf(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
