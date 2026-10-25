import { describe, expect, it } from 'vitest';
import { InProcessProviderCapacity, Scheduler } from './index.js';

function grantId(decision: ReturnType<Scheduler['acquire']>): string {
  if (!decision.ok) throw new Error('Expected a grant');
  return decision.grantId;
}

describe('Scheduler', () => {
  it('shares one slot per provider across runs and releases grants idempotently', () => {
    const capacity = new InProcessProviderCapacity();
    const first = new Scheduler(capacity);
    const second = new Scheduler(capacity);
    const grant = grantId(first.acquire('deepseek'));
    expect(second.acquire('deepseek')).toEqual({ ok: false });
    const otherProvider = grantId(second.acquire('local'));
    first.release(grant);
    first.release(grant);
    expect(grantId(second.acquire('deepseek'))).toMatch(/^grt_/u);
    second.release(otherProvider);
    expect(first.releaseAll()).toBe(0);
    expect(second.releaseAll()).toBe(1);
    expect(grantId(first.acquire('deepseek'))).toMatch(/^grt_/u);
  });

  it('stops granting without revoking held tokens and releases leftovers at convergence', () => {
    const capacity = new InProcessProviderCapacity();
    const first = new Scheduler(capacity);
    const second = new Scheduler(capacity);
    const held = grantId(first.acquire('deepseek'));
    first.stopGranting();
    first.stopGranting();
    expect(first.acquire('local')).toEqual({ ok: false });
    expect(second.acquire('deepseek')).toEqual({ ok: false });
    expect(first.releaseAll()).toBe(1);
    expect(first.releaseAll()).toBe(0);
    first.release(held);
    expect(first.acquire('deepseek')).toEqual({ ok: false });
    expect(grantId(second.acquire('deepseek'))).toMatch(/^grt_/u);
  });
});
