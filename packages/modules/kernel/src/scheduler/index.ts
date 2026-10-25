import { ulid } from '@multiagentos/contracts';
import type { ProviderCapacityPort, SchedulerDuties } from '../interfaces/index.js';

/** Process-wide capacity: each provider can hold one token at a time. */
export class InProcessProviderCapacity implements ProviderCapacityPort {
  readonly #byProvider = new Map<string, string>();
  readonly #byToken = new Map<string, string>();

  tryAcquire(provider: string): string | null {
    if (provider.trim().length === 0) throw new Error('Provider must be non-empty');
    if (this.#byProvider.has(provider)) return null;
    const token = `cap_${ulid()}`;
    this.#byProvider.set(provider, token);
    this.#byToken.set(token, provider);
    return token;
  }

  release(token: string): void {
    const provider = this.#byToken.get(token);
    if (provider === undefined) return;
    this.#byToken.delete(token);
    this.#byProvider.delete(provider);
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
  ): { readonly ok: true; readonly grantId: string } | { readonly ok: false } {
    if (!this.#granting) return { ok: false };
    const token = this.#capacity.tryAcquire(provider);
    if (token === null) return { ok: false };
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
