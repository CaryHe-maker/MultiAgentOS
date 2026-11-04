import { describe, expect, it } from 'vitest';
import {
  approvalDigestOf,
  buildSandboxEnvironment,
  countSandboxDenials,
  SandboxScopeSchema,
  type ApprovedCommand,
} from './sandbox.js';
import { validate } from './validation.js';

const approved: ApprovedCommand = {
  command: 'npm test',
  workdir: '',
  network: false,
  writableRoots: ['.'],
  backend: 'BWRAP',
};

describe('approvalDigestOf', () => {
  it('is stable and changes with every part the user was shown', () => {
    const digest = approvalDigestOf(approved);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(approvalDigestOf({ ...approved })).toBe(digest);
    for (const changed of [
      { command: 'npm test ' },
      { workdir: 'sub' },
      { network: true },
      { writableRoots: ['src'] },
      { backend: 'UNISOLATED' as const },
    ])
      expect(approvalDigestOf({ ...approved, ...changed })).not.toBe(digest);
  });
});

describe('buildSandboxEnvironment', () => {
  it('passes only the whitelist and sets HOME to the sandbox home', () => {
    const built = buildSandboxEnvironment(
      { PATH: '/bin', LANG: 'en_US.UTF-8', HOME: '/home/me', EDITOR: 'vim', API_KEY: 'x' },
      '/home/sandbox',
    );
    expect(built).toEqual({
      ok: true,
      env: { HOME: '/home/sandbox', PATH: '/bin', LANG: 'en_US.UTF-8' },
    });
  });

  it('fills PATH and LANG when the host has none', () => {
    const built = buildSandboxEnvironment({}, '/h');
    expect(built.ok && built.env['PATH']).toBeTruthy();
    expect(built.ok && built.env['LANG']).toBe('C.UTF-8');
  });

  it.each(['DEEPSEEK_API_KEY', 'GITHUB_TOKEN', 'db_password', 'AWS_SECRET', 'MY_CREDENTIALS'])(
    'refuses an extra variable named %s',
    (name) => {
      const built = buildSandboxEnvironment({}, '/h', { [name]: 'v' });
      expect(built).toEqual({ ok: false, offending: [name] });
    },
  );
});

describe('countSandboxDenials', () => {
  it('counts the lines the sandbox refused', () => {
    const output = 'ok\ntouch: x: Read-only file system\ncurl: (7) Network is unreachable\n';
    expect(countSandboxDenials(output)).toBe(2);
    expect(countSandboxDenials('fine')).toBe(0);
  });
});

describe('SandboxScope', () => {
  const scope = {
    kind: 'SANDBOX',
    backend: 'BWRAP',
    approvalDigest: approvalDigestOf(approved),
    profile: {
      repositoryRoot: '/repo',
      workdir: '',
      writableRoots: ['.'],
      network: false,
      homeReadOnly: [],
      homeMaskedFiles: [],
      maskedFiles: ['.env'],
      maskedDirs: [],
      protectedExisting: ['.git'],
    },
  };

  it('accepts a complete scope and rejects extra or missing fields', () => {
    expect(validate(SandboxScopeSchema, scope).ok).toBe(true);
    expect(validate(SandboxScopeSchema, { ...scope, extra: 1 }).ok).toBe(false);
    expect(validate(SandboxScopeSchema, { ...scope, approvalDigest: 'abc' }).ok).toBe(false);
    const { profile, ...rest } = scope;
    expect(
      validate(SandboxScopeSchema, { ...rest, profile: { ...profile, writableRoots: [] } }).ok,
    ).toBe(false);
  });
});
