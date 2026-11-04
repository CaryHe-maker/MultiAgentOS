import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ceilingOf,
  decideUnit,
  type AuthorizationEntry,
  type Capability,
  type CapabilityCeiling,
  type UnitDemand,
} from './unit-decision.js';

const main: CapabilityCeiling = {
  capabilities: new Set<Capability>(['repo.read', 'workspace.write']),
  writeRoots: ['.'],
  exclusions: [],
};

const write = (path: string, overrides: Partial<UnitDemand> = {}): UnitDemand => ({
  requestId: 'req-1',
  agentRunId: 'run-1',
  capability: 'workspace.write',
  path,
  ...overrides,
});

const grant: AuthorizationEntry = {
  scope: 'RUN',
  effect: 'ALLOW',
  capability: 'workspace.write',
  resourceKey: '.',
};

const refusal: AuthorizationEntry = {
  scope: 'RUN',
  effect: 'DENY',
  capability: 'workspace.write',
  agentRunId: 'run-1',
};

describe('the capability ceiling', () => {
  const request = {
    agentCapabilities: ['repo.read', 'workspace.write'] as Capability[],
    requestedCapabilities: ['repo.read', 'workspace.write'] as Capability[],
    writeRoots: ['.'],
    preset: 'standard' as const,
    exclusions: [],
  };

  it('is what was requested, inside the definition', () => {
    const narrowed = ceilingOf({ ...request, requestedCapabilities: ['repo.read'] });
    expect(narrowed).toMatchObject({ ok: true });
    if (narrowed.ok) expect([...narrowed.ceiling.capabilities]).toEqual(['repo.read']);
  });

  it('refuses a capability the definition does not give', () => {
    expect(ceilingOf({ ...request, agentCapabilities: ['repo.read'] })).toEqual({
      ok: false,
      reasonCode: 'CAPABILITY_NOT_SUBSET',
    });
  });

  it('readonly leaves only the safe capabilities', () => {
    expect(ceilingOf({ ...request, preset: 'readonly' })).toMatchObject({ ok: false });
    expect(
      ceilingOf({ ...request, preset: 'readonly', requestedCapabilities: ['repo.read'] }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a write root outside the repository', () => {
    for (const root of ['../x', '/etc', 'a/../../b'])
      expect(ceilingOf({ ...request, writeRoots: [root] })).toMatchObject({ ok: false });
  });
});

describe('the decision order', () => {
  it('② refuses what the ceiling lacks, before anything else is looked at', () => {
    const readOnly = { ...main, capabilities: new Set<Capability>(['repo.read']) };
    expect(decideUnit(write('.git/config'), readOnly, [grant])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'CAPABILITY_NOT_GRANTED',
    });
  });

  it('③ refuses without asking, and no grant lifts it', () => {
    expect(decideUnit(write('../x'), main, [grant])).toMatchObject({
      reasonCode: 'WRITE_OUT_OF_SCOPE',
    });
    expect(decideUnit(write('.git/config'), main, [grant])).toMatchObject({
      reasonCode: 'PROTECTED_PATH',
    });
    expect(decideUnit(write('.env'), main, [grant])).toMatchObject({
      reasonCode: 'PROTECTED_PATH',
    });
    const worker = { ...main, writeRoots: ['src'] };
    expect(decideUnit(write('lib/a.ts'), worker, [grant])).toMatchObject({
      reasonCode: 'WRITE_OUT_OF_SCOPE',
    });
  });

  it('④ a grant allows; a refusal binds the AgentRun that asked', () => {
    expect(decideUnit(write('src/a.ts'), main, [grant])).toEqual({
      kind: 'ALLOW',
      capability: 'workspace.write',
      resourceKey: '.',
    });
    expect(decideUnit(write('src/a.ts'), main, [refusal])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'USER_DECLINED',
    });
    expect(
      decideUnit(write('src/a.ts', { agentRunId: 'run-2' }), main, [refusal]),
    ).toMatchObject({ kind: 'ASK' });
  });

  it('④ a refusal outweighs a grant from before it', () => {
    expect(decideUnit(write('src/a.ts'), main, [grant, refusal])).toMatchObject({
      reasonCode: 'USER_DECLINED',
    });
  });

  it('④ a grant covers its root and below, and not a sibling', () => {
    const worker = { ...main, writeRoots: ['src', 'lib'] };
    const onSrc: AuthorizationEntry = { ...grant, resourceKey: 'src' };
    expect(decideUnit(write('src/x/a.ts'), worker, [onSrc])).toMatchObject({ kind: 'ALLOW' });
    expect(decideUnit(write('lib/a.ts'), worker, [onSrc])).toMatchObject({
      kind: 'ASK',
      resourceKey: 'lib',
    });
  });

  it('⑤ asks when nothing covers it', () => {
    expect(decideUnit(write('src/a.ts'), main, [])).toEqual({
      kind: 'ASK',
      capability: 'workspace.write',
      resourceKey: '.',
      critical: false,
    });
  });

  it('a question on repo.read is keyed by the repository', () => {
    const read = { requestId: 'r', agentRunId: 'a', capability: 'repo.read' };
    expect(decideUnit(read, main, [])).toMatchObject({ kind: 'ASK', resourceKey: '.' });
    expect(
      decideUnit(read, main, [
        { scope: 'RUN', effect: 'ALLOW', capability: 'repo.read', resourceKey: '.' },
      ]),
    ).toMatchObject({ kind: 'ALLOW' });
    expect(decideUnit(read, main, [grant])).toMatchObject({ kind: 'ASK' });
  });
});

describe('a critical write', () => {
  const once = (effect: 'ALLOW' | 'DENY', requestId = 'req-1'): AuthorizationEntry => ({
    scope: 'ONCE',
    effect,
    capability: 'workspace.write',
    requestId,
  });

  it('asks despite a grant, in any directory', () => {
    for (const path of ['AGENTS.md', 'pkg/AGENTS.md', 'pkg/agents.md'])
      expect(decideUnit(write(path), main, [grant])).toMatchObject({
        kind: 'ASK',
        critical: true,
      });
  });

  it('is decided only by the answer to this request', () => {
    expect(decideUnit(write('AGENTS.md'), main, [once('ALLOW')])).toMatchObject({ kind: 'ALLOW' });
    expect(decideUnit(write('AGENTS.md'), main, [once('DENY')])).toMatchObject({
      reasonCode: 'USER_DECLINED',
    });
    expect(decideUnit(write('AGENTS.md'), main, [once('ALLOW', 'req-2')])).toMatchObject({
      kind: 'ASK',
    });
  });

  it('stays refused once the AgentRun refused the capability', () => {
    expect(decideUnit(write('AGENTS.md'), main, [refusal])).toMatchObject({
      reasonCode: 'USER_DECLINED',
    });
  });

  it('a refused AGENTS.md leaves ordinary writes alone', () => {
    expect(
      decideUnit(write('src/a.ts', { requestId: 'req-2' }), main, [once('DENY')]),
    ).toMatchObject({ kind: 'ASK' });
  });
});

describe('a failed check is a refusal', () => {
  it('refuses a capability Core does not know, and a write without a path', () => {
    expect(decideUnit(write('a', { capability: 'root.shell' }), main, [grant])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'ADMISSION_CHECK_FAILED',
    });
    expect(
      decideUnit({ requestId: 'r', agentRunId: 'a', capability: 'workspace.write' }, main, [grant]),
    ).toMatchObject({ reasonCode: 'ADMISSION_CHECK_FAILED' });
    expect(decideUnit(write('a', { capability: 'constructor' }), main, [grant])).toMatchObject({
      reasonCode: 'ADMISSION_CHECK_FAILED',
    });
  });

  it('refuses when deciding throws', () => {
    const broken = { ...main, writeRoots: ['../x'] };
    expect(decideUnit(write('a'), broken, [grant])).toMatchObject({
      reasonCode: 'ADMISSION_CHECK_FAILED',
    });
  });
});

describe('properties', () => {
  const segment = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/u);
  const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));
  const entry = fc.oneof<fc.Arbitrary<AuthorizationEntry>[]>(
    path.map((resourceKey) => ({ ...grant, resourceKey })),
    fc.constant(grant),
    fc.constant(refusal),
    fc.constant<AuthorizationEntry>({
      scope: 'ONCE',
      effect: 'ALLOW',
      capability: 'workspace.write',
      requestId: 'req-1',
    }),
  );
  const protectedPath = fc.oneof(
    path.map((p) => `.git/${p}`),
    path.map((p) => `${p}/.multiagentos/x`),
    path.map((p) => `${p}/.env`),
    path.map((p) => `../${p}`),
  );

  it('no entries can ever allow a protected or escaping path', () => {
    fc.assert(
      fc.property(protectedPath, fc.array(entry), (target, entries) => {
        expect(decideUnit(write(target), main, entries).kind).toBe('REFUSE');
      }),
    );
  });

  it('never allows without an entry: the decision starts at asking', () => {
    fc.assert(
      fc.property(path, (target) => {
        expect(decideUnit(write(target), main, []).kind).not.toBe('ALLOW');
      }),
    );
  });

  it('more entries of grant never turn a refusal into an allow', () => {
    fc.assert(
      fc.property(path, fc.array(entry), (target, entries) => {
        const before = decideUnit(write(target), main, [refusal]);
        const others = entries.filter((e) => e.scope === 'RUN');
        expect(before.kind).toBe('REFUSE');
        expect(decideUnit(write(target), main, [refusal, ...others]).kind).toBe('REFUSE');
      }),
    );
  });
});
