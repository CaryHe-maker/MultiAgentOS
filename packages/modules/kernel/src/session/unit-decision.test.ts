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
    expect(decideUnit(write('src/a.ts', { agentRunId: 'run-2' }), main, [refusal])).toMatchObject({
      kind: 'ASK',
    });
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

describe('the web capabilities (Kernel/Core 5f)', () => {
  const web: CapabilityCeiling = {
    capabilities: new Set<Capability>(['web.search', 'web.fetch']),
    writeRoots: [],
    exclusions: [],
  };
  const search = (): UnitDemand => ({
    requestId: 'req-1',
    agentRunId: 'run-1',
    capability: 'web.search',
  });
  const fetchOf = (
    url: string,
    deniedDomains: string[] = [],
    agentRunId = 'run-1',
  ): UnitDemand => ({
    requestId: 'req-1',
    agentRunId,
    capability: 'web.fetch',
    web: { url, deniedDomains },
  });
  const allowHost = (host: string): AuthorizationEntry => ({
    scope: 'RUN',
    effect: 'ALLOW',
    capability: 'web.fetch',
    resourceKey: host,
  });

  it('asks a search once for the whole capability, and then lets it through', () => {
    expect(decideUnit(search(), web, [])).toEqual({
      kind: 'ASK',
      capability: 'web.search',
      resourceKey: '.',
      critical: false,
    });
    const granted: AuthorizationEntry = {
      scope: 'RUN',
      effect: 'ALLOW',
      capability: 'web.search',
      resourceKey: '.',
    };
    expect(decideUnit(search(), web, [granted])).toMatchObject({ kind: 'ALLOW' });
  });

  it('asks a fetch per host, in lower case', () => {
    expect(decideUnit(fetchOf('https://Docs.Example.com/a'), web, [])).toMatchObject({
      kind: 'ASK',
      capability: 'web.fetch',
      resourceKey: 'docs.example.com',
    });
  });

  it('lets a fetch through for the host that was allowed, and for no other', () => {
    const entries = [allowHost('docs.example.com')];
    expect(decideUnit(fetchOf('https://docs.example.com/b?q=1'), web, entries)).toMatchObject({
      kind: 'ALLOW',
    });
    for (const other of [
      'https://example.com/',
      'https://a.docs.example.com/',
      'https://docs.example.com.evil.test/',
    ])
      expect(decideUnit(fetchOf(other), web, entries)).toMatchObject({ kind: 'ASK' });
  });

  it('does not take a search grant for a fetch, nor the other way round', () => {
    const grant = (capability: 'web.search' | 'web.fetch'): AuthorizationEntry => ({
      scope: 'RUN',
      effect: 'ALLOW',
      capability,
      resourceKey: '.',
    });
    expect(decideUnit(fetchOf('https://example.com/'), web, [grant('web.search')])).toMatchObject({
      kind: 'ASK',
    });
    expect(decideUnit(search(), web, [grant('web.fetch')])).toMatchObject({ kind: 'ASK' });
  });

  it.each([
    'http://127.0.0.1/',
    'http://localhost:8080/',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://intranet/',
    'http://printer.local/',
    'http://user:pw@example.com/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'not a url',
  ])('① refuses %s without asking, even where the host was allowed', (url) => {
    const host = 'localhost';
    expect(decideUnit(fetchOf(url), web, [allowHost(host), allowHost('127.0.0.1')])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'ADDRESS_FORBIDDEN',
    });
  });

  it('① refuses a denied domain and everything under it, without asking', () => {
    const denied = ['Example.com'];
    for (const url of ['https://example.com/', 'https://a.b.example.com/x'])
      expect(decideUnit(fetchOf(url, denied), web, [])).toEqual({
        kind: 'REFUSE',
        reasonCode: 'DOMAIN_DENIED',
      });
    expect(decideUnit(fetchOf('https://notexample.com/', denied), web, [])).toMatchObject({
      kind: 'ASK',
    });
  });

  it('② refuses what the ceiling lacks, before the address is looked at', () => {
    const none = { ...web, capabilities: new Set<Capability>(['repo.read']) };
    expect(decideUnit(fetchOf('http://127.0.0.1/'), none, [])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'CAPABILITY_NOT_GRANTED',
    });
    expect(decideUnit(search(), none, [])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'CAPABILITY_NOT_GRANTED',
    });
  });

  it('keeps a refusal to its host and its AgentRun', () => {
    const refused: AuthorizationEntry = {
      scope: 'RUN',
      effect: 'DENY',
      capability: 'web.fetch',
      agentRunId: 'run-1',
      hostKey: 'bad.example.com',
    };
    expect(decideUnit(fetchOf('https://bad.example.com/'), web, [refused])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'USER_DECLINED',
    });
    // Another host is asked about, and so is another AgentRun for the same host.
    expect(decideUnit(fetchOf('https://good.example.com/'), web, [refused])).toMatchObject({
      kind: 'ASK',
    });
    expect(
      decideUnit(fetchOf('https://bad.example.com/', [], 'run-2'), web, [refused]),
    ).toMatchObject({
      kind: 'ASK',
    });
  });

  it('keeps a refusal of a search to the AgentRun for the whole capability', () => {
    const refused: AuthorizationEntry = {
      scope: 'RUN',
      effect: 'DENY',
      capability: 'web.search',
      agentRunId: 'run-1',
    };
    expect(decideUnit(search(), web, [refused])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'USER_DECLINED',
    });
    expect(decideUnit({ ...search(), agentRunId: 'run-2' }, web, [refused])).toMatchObject({
      kind: 'ASK',
    });
  });

  it('a refusal of a host does not bind the other hosts of the capability', () => {
    const refused: AuthorizationEntry = {
      scope: 'RUN',
      effect: 'DENY',
      capability: 'web.fetch',
      agentRunId: 'run-1',
      hostKey: 'bad.example.com',
    };
    expect(decideUnit(fetchOf('https://other.example.org/'), web, [refused])).toMatchObject({
      kind: 'ASK',
    });
  });

  it('is a refusal when the fetch demand carries no address', () => {
    expect(
      decideUnit({ requestId: 'r', agentRunId: 'a', capability: 'web.fetch' }, web, []),
    ).toEqual({ kind: 'REFUSE', reasonCode: 'ADMISSION_CHECK_FAILED' });
  });

  it('is not offered under the readonly preset', () => {
    expect(
      ceilingOf({
        agentCapabilities: ['repo.read', 'web.search', 'web.fetch'],
        requestedCapabilities: ['web.search'],
        writeRoots: [],
        preset: 'readonly',
        exclusions: [],
      }),
    ).toMatchObject({ ok: false });
  });
});
