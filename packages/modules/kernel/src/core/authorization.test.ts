import type { UnitDefinition } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { AuthorizationManager } from './authorization.js';

const unit = (protectedCapabilities: UnitDefinition['protectedCapabilities']): UnitDefinition => ({
  schemaVersion: 'v0',
  kind: 'UNIT',
  id: 'file-read',
  version: 'v0.1.0',
  digest: 'd'.repeat(64),
  description: 'read',
  executionKind: 'FILE_READ',
  protectedCapabilities,
  inputContract: { kind: 'contract', id: 'executor.FileReadInput', version: 'v0' },
  outputContract: { kind: 'contract', id: 'executor.FileReadOutput', version: 'v0' },
  toolRefs: [],
  effect: 'READ_ONLY',
  isIdempotent: true,
  failurePolicy: {},
});

function manager(
  now: () => Date = () => new Date('2026-10-19T00:00:00.000Z'),
): AuthorizationManager {
  return new AuthorizationManager({
    repositoryRoot: '/repo',
    provider: 'deepseek',
    repositoryExclusions: ['**/secrets/**'],
    authorizationTimeoutMs: 300_000,
    now,
  });
}

describe('AuthorizationManager', () => {
  it('allows unprotected Units without asking', () => {
    const authorization = manager();
    expect(authorization.check('req_123456', unit([]))).toEqual({
      decision: { kind: 'ALLOWED' },
    });
    expect(authorization.status).toBeUndefined();
  });

  it('asks once for repo.read and joins later requests to the same question', () => {
    const authorization = manager();
    const first = authorization.check('req_first1', unit(['repo.read']));
    expect(first.decision).toMatchObject({ kind: 'PENDING' });
    expect(first.requested).toMatchObject({
      type: 'AuthorizationRequest',
      questionId: authorization.questionId,
      capability: 'repo.read',
      repositoryPath: '/repo',
      provider: 'deepseek',
      expiresAt: '2026-10-19T00:05:00.000Z',
    });
    expect(first.requested?.exclusions).toEqual(
      expect.arrayContaining(['**/.env*', '**/secrets/**']),
    );

    const second = authorization.check('req_second', unit(['repo.read']));
    expect(second).toEqual({
      decision: { kind: 'PENDING', questionId: authorization.questionId },
    });
    expect(authorization.record?.pendingRequests).toEqual(['req_first1', 'req_second']);
  });

  it('grants a Lease covering the repository and the configured exclusions', () => {
    const authorization = manager();
    const check = authorization.check('req_first1', unit(['repo.read']));
    const questionId = check.requested?.questionId;
    if (questionId === undefined) throw new Error('no question');

    const answer = authorization.answer(questionId, 'YES');
    expect(answer).toMatchObject({
      resolution: 'GRANTED',
      released: ['req_first1'],
      resolved: { type: 'AuthorizationResolved', questionId, resolution: 'GRANTED' },
    });
    expect(authorization.status).toBe('GRANTED');
    expect(authorization.isLeaseValid()).toBe(true);
    expect(authorization.lease).toMatchObject({
      capability: 'repo.read',
      repositoryRoot: '/repo',
      provider: 'deepseek',
      issuedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(authorization.lease?.exclusions).toEqual(
      expect.arrayContaining(['**/.env*', '**/secrets/**']),
    );
    expect(authorization.check('req_third1', unit(['repo.read']))).toEqual({
      decision: { kind: 'ALLOWED' },
    });
    expect(authorization.answer(questionId, 'YES')).toBeUndefined();
    expect(authorization.cancel()).toBeUndefined();
    expect(authorization.isLeaseValid()).toBe(true);
    authorization.invalidateLease();
    expect(authorization.isLeaseValid()).toBe(false);
    expect(authorization.check('req_fourth', unit(['repo.read']))).toEqual({
      decision: { kind: 'DECLINED' },
    });
  });

  it('retains a denial and never issues a Lease', () => {
    const authorization = manager();
    const check = authorization.check('req_first1', unit(['repo.read']));
    const questionId = check.requested?.questionId;
    if (questionId === undefined) throw new Error('no question');

    expect(authorization.answer(questionId, 'NO')).toMatchObject({ resolution: 'DECLINED' });
    expect(authorization.status).toBe('DECLINED');
    expect(authorization.lease).toBeUndefined();
    expect(authorization.check('req_second', unit(['repo.read']))).toEqual({
      decision: { kind: 'DECLINED' },
    });
    expect(authorization.check('req_third1', unit([]))).toEqual({
      decision: { kind: 'ALLOWED' },
    });
  });

  it('expires and cancels pending questions exactly once', () => {
    const timedOut = manager();
    timedOut.check('req_first1', unit(['repo.read']));
    expect(timedOut.expire()).toMatchObject({
      resolution: 'TIMED_OUT',
      released: ['req_first1'],
    });
    expect(timedOut.status).toBe('TIMED_OUT');
    expect(timedOut.expire()).toBeUndefined();
    expect(timedOut.check('req_second', unit(['repo.read']))).toEqual({
      decision: { kind: 'DECLINED' },
    });

    const cancelled = manager();
    cancelled.check('req_first1', unit(['repo.read']));
    expect(cancelled.cancel()).toMatchObject({
      resolution: 'CANCELLED',
      released: ['req_first1'],
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancel()).toBeUndefined();
  });

  it('rejects an answer for an unknown question', () => {
    const authorization = manager();
    authorization.check('req_first1', unit(['repo.read']));
    expect(authorization.answer('qst_unknown', 'YES')).toBeUndefined();
  });
});
