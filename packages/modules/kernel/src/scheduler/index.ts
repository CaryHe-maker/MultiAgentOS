import { ulid } from '@multiagentos/contracts';
import type { ProviderCapacityPort, SchedulerDuties } from '../interfaces/index.js';

/** Process-wide capacity: each provider can hold `slots` tokens at a time (`providerCapacity`). */
export class InProcessProviderCapacity implements ProviderCapacityPort {
  readonly #held = new Map<string, Set<string>>();
  readonly #byToken = new Map<string, string>();
  readonly #slots: number;

  constructor(slots = 1) {
    if (!Number.isSafeInteger(slots) || slots < 1)
      throw new Error('Provider capacity must be a positive integer');
    this.#slots = slots;
  }

  tryAcquire(provider: string): string | null {
    if (provider.trim().length === 0) throw new Error('Provider must be non-empty');
    const held = this.#held.get(provider) ?? new Set<string>();
    if (held.size >= this.#slots) return null;
    const token = `cap_${ulid()}`;
    held.add(token);
    this.#held.set(provider, held);
    this.#byToken.set(token, provider);
    return token;
  }

  release(token: string): void {
    const provider = this.#byToken.get(token);
    if (provider === undefined) return;
    this.#byToken.delete(token);
    this.#held.get(provider)?.delete(token);
  }
}

/** One run's grants. All runs must receive the same ProviderCapacityPort instance. */
export class Scheduler implements SchedulerDuties {
  readonly #capacity: ProviderCapacityPort;
  readonly #grants = new Map<string, string>();
  #granting = true;

  constructor(capacity: ProviderCapacityPort) {
    this.#capacity = capacity;
  }

  acquire(
    provider: string,
  ):
    | { readonly ok: true; readonly grantId: string }
    | { readonly ok: false; readonly reason: 'CAPACITY' | 'STOPPED' } {
    if (!this.#granting) return { ok: false, reason: 'STOPPED' };
    const token = this.#capacity.tryAcquire(provider);
    if (token === null) return { ok: false, reason: 'CAPACITY' };
    if ([...this.#grants.values()].includes(token))
      throw new Error('Provider capacity returned a token already held by this run');
    const grantId = `grt_${ulid()}`;
    this.#grants.set(grantId, token);
    return { ok: true, grantId };
  }

  release(grantId: string): void {
    const token = this.#grants.get(grantId);
    if (token === undefined) return;
    this.#capacity.release(token);
    this.#grants.delete(grantId);
  }

  stopGranting(): void {
    this.#granting = false;
  }

  releaseAll(): number {
    const held = this.#grants.size;
    for (const grantId of this.#grants.keys()) this.release(grantId);
    return held;
  }
}
