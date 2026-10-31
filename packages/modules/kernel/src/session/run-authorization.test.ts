import type { ArtifactRef } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { RunAuthorization } from './run-authorization.js';

const sha256 = 'a'.repeat(64);
const contentRef: ArtifactRef = {
  artifactId: `art_${sha256}`,
  sha256,
  size: 1,
  mediaType: 'text/plain',
};
const file = { path: 'AGENTS.md', sha256, contentRef, truncated: false };

const authorization = () =>
  new RunAuthorization<string>({
    repositoryRoot: '/repository',
    provider: 'deepseek',
    repositoryExclusions: [],
    authorizationTimeoutMs: 1000,
    now: () => new Date('2026-10-31T00:00:00.000Z'),
  });

function ask(auth: RunAuthorization<string>, waiter: string): string {
  const { decision } = auth.requireRepoRead(waiter);
  if (decision.kind !== 'PENDING') throw new Error(decision.kind);
  return decision.questionId;
}

describe('repo.read', () => {
  it('asks once and releases everyone who waited, in order', () => {
    const auth = authorization();
    const first = auth.requireRepoRead('a');
    expect(first.requested).toMatchObject({
      capability: 'repo.read',
      expiresAt: '2026-10-31T00:00:01.000Z',
    });
    const second = auth.requireRepoRead('b');
    expect(second.requested).toBeUndefined();
    if (first.decision.kind !== 'PENDING') throw new Error('not pending');
    const settled = auth.answer(first.decision.questionId, 'ALLOW');
    expect(settled).toMatchObject({ resolution: 'GRANTED', waiters: ['a', 'b'] });
    expect(auth.requireRepoRead('c').decision).toEqual({ kind: 'ALLOWED' });
  });

  it('keeps a refusal for the run', () => {
    const auth = authorization();
    auth.answer(ask(auth, 'a'), 'DENY');
    expect(auth.requireRepoRead('b').decision).toEqual({ kind: 'DECLINED' });
    expect(auth.lease).toBeUndefined();
  });

  it('asks again after a timeout, which refused only this time', () => {
    const auth = authorization();
    const questionId = ask(auth, 'a');
    expect(auth.expire(questionId)).toMatchObject({ resolution: 'TIMED_OUT', waiters: ['a'] });
    expect(auth.requireRepoRead('b').requested).toBeDefined();
  });

  it('answers a question once', () => {
    const auth = authorization();
    const questionId = ask(auth, 'a');
    auth.answer(questionId, 'ALLOW');
    expect(auth.answer(questionId, 'ALLOW')).toBeUndefined();
    expect(auth.expire(questionId)).toBeUndefined();
  });
});

describe('project.instructions', () => {
  it('remembers a refusal of this exact content only', () => {
    const auth = authorization();
    const asked = auth.askInstructions(file, 'a');
    if (asked.decision.kind !== 'PENDING') throw new Error('not pending');
    auth.answer(asked.decision.questionId, 'DENY');
    expect(auth.askInstructions(file, 'b').decision).toEqual({ kind: 'DECLINED' });
    const changed = auth.askInstructions({ ...file, sha256: 'b'.repeat(64) }, 'c');
    expect(changed.decision.kind).toBe('PENDING');
  });

  it('joins a question about the same content', () => {
    const auth = authorization();
    auth.askInstructions(file, 'a');
    expect(auth.askInstructions(file, 'b').requested).toBeUndefined();
  });

  it('grants no execution right', () => {
    const auth = authorization();
    const asked = auth.askInstructions(file, 'a');
    if (asked.decision.kind !== 'PENDING') throw new Error('not pending');
    auth.answer(asked.decision.questionId, 'ALLOW');
    expect(auth.lease).toBeUndefined();
    expect(auth.requireRepoRead('b').decision.kind).toBe('PENDING');
  });
});

describe('closing', () => {
  it('cancels every question and ends the Lease', () => {
    const auth = authorization();
    auth.answer(ask(auth, 'a'), 'ALLOW');
    auth.askInstructions(file, 'b');
    const settled = auth.closeAll();
    expect(settled.map((entry) => entry.resolution)).toEqual(['CANCELLED']);
    expect(auth.lease).toBeUndefined();
  });
});
