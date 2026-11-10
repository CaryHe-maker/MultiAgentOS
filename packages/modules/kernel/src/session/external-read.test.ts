import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDeniedRoot, resolveExternal, type ExternalSupport } from './external-read.js';
import { RunAuthorization } from './run-authorization.js';
import {
  decideUnit,
  type AuthorizationEntry,
  type Capability,
  type CapabilityCeiling,
  type UnitDemand,
} from './unit-decision.js';

/**
 * Reading outside the workspace (docs/M2/Kernel/Core.md 5h): what a path the model wrote comes to,
 * what is never readable, the folder one answer allows, and what Core decides on that alone.
 */

const support: ExternalSupport = { homeDir: '/home/alice', dataDir: '/home/alice/.multiagentos' };

describe('what is never readable', () => {
  it.each([
    '/',
    '/opt',
    '/home',
    '/tmp',
    '/etc',
    '/etc/ssh',
    '/proc/1',
    '/sys/kernel',
    '/dev/shm',
    '/root',
    '/root/proj',
    '/var/lib/docker',
    '/boot',
    '/run/user/1000',
    '/home/alice',
    '/home/other',
    '/home/alice/.ssh',
    '/home/alice/.config/gh',
    '/home/alice/.multiagentos/sessions',
    '/mnt',
    '/mnt/c',
    '/mnt/wsl',
    '/mnt/c/Windows/System32',
    '/mnt/c/Program Files/x',
    '/mnt/c/Users',
    '/mnt/c/Users/alice',
    '/mnt/c/Users/alice/.ssh',
    '/mnt/c/Users/alice/AppData/Roaming',
    '/mnt/C/WINDOWS',
  ])('refuses %s', (path) => {
    expect(isDeniedRoot(path, support)).toBe(true);
  });

  it.each([
    '/home/alice/projects',
    '/home/alice/projects/app/src',
    '/home/other/work',
    '/tmp/project',
    '/opt/tools/lib',
    '/srv/www',
    '/usr/share/doc',
    '/mnt/c/dev/app',
    '/mnt/d/work',
    '/mnt/c/Users/alice/Documents/app',
  ])('allows %s', (path) => {
    expect(isDeniedRoot(path, support)).toBe(false);
  });

  it('keeps the data directory out wherever it is', () => {
    expect(isDeniedRoot('/srv/mas-data/log', { ...support, dataDir: '/srv/mas-data' })).toBe(true);
    expect(isDeniedRoot('/srv/mas-data-x', { ...support, dataDir: '/srv/mas-data' })).toBe(false);
  });
});

describe('the folder an answer allows', () => {
  let base: string;
  let home: string;
  let workspace: string;
  let context: Parameters<typeof resolveExternal>[1];

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'external-')));
    home = join(base, 'home');
    workspace = join(base, 'work');
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    context = { support: { homeDir: home }, repositoryRoot: workspace, granted: [] };
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const tree = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(base, path)), { recursive: true });
      await writeFile(join(base, path), text);
    }
  };

  it('is the folder itself for a folder', async () => {
    await tree({ 'proj/a/b.ts': 'x' });
    const found = await resolveExternal(join(base, 'proj', 'a'), context);
    expect(found).toMatchObject({
      ok: true,
      root: join(base, 'proj', 'a'),
      path: '',
      isDirectory: true,
    });
  });

  it('is the repository the file is in, for a file', async () => {
    await tree({ 'proj/.git/HEAD': 'ref', 'proj/src/a.ts': 'x' });
    const found = await resolveExternal(join(base, 'proj', 'src', 'a.ts'), context);
    expect(found).toMatchObject({
      ok: true,
      root: join(base, 'proj'),
      path: 'src/a.ts',
      isDirectory: false,
    });
  });

  it('is the folder of the file when no repository is found', async () => {
    await tree({ 'loose/notes.md': 'x' });
    const found = await resolveExternal(join(base, 'loose', 'notes.md'), context);
    expect(found).toMatchObject({ ok: true, root: join(base, 'loose'), path: 'notes.md' });
  });

  it('keeps a root that was allowed, for every path below it', async () => {
    await tree({ 'proj/.git/HEAD': 'ref', 'proj/src/a.ts': 'x', 'proj/docs/d.md': 'y' });
    const allowed = join(base, 'proj', 'src');
    const found = await resolveExternal(join(base, 'proj', 'src', 'a.ts'), {
      ...context,
      granted: [allowed],
    });
    // The repository root is wider than what the user allowed: the answer's root is kept.
    expect(found).toMatchObject({ ok: true, root: allowed, path: 'a.ts' });
    // A path outside it asks again, and its own root is the repository.
    const other = await resolveExternal(join(base, 'proj', 'docs', 'd.md'), {
      ...context,
      granted: [allowed],
    });
    expect(other).toMatchObject({ ok: true, root: join(base, 'proj') });
  });

  it('says only that it cannot, for every path it will not read', async () => {
    await tree({ 'work/in.ts': 'x', 'home/.ssh/id': 'k', 'home/proj/a.ts': 'x' });
    const unreadable = [
      join(base, 'missing'),
      'relative/path',
      '',
      '../x',
      join(workspace, 'in.ts'),
      home,
      join(home, '.ssh'),
      join(home, '.ssh', 'id'),
      '/',
      '/etc/passwd',
      `${base}\u0000/x`,
    ];
    for (const path of unreadable)
      expect(await resolveExternal(path, context), path).toEqual({ ok: false });
    expect(await resolveExternal(join(home, 'proj', 'a.ts'), context)).toMatchObject({ ok: true });
  });

  it('leaves the workspace to read_file even when a folder above it was allowed', async () => {
    await tree({ 'work/in.ts': 'x', 'proj/a.ts': 'x' });
    const above = { ...context, granted: [base] };
    expect(await resolveExternal(join(workspace, 'in.ts'), above)).toEqual({ ok: false });
    expect(await resolveExternal(workspace, above)).toEqual({ ok: false });
    expect(await resolveExternal(join(base, 'proj', 'a.ts'), above)).toMatchObject({
      ok: true,
      root: base,
    });
  });

  it('looks at where a link leads, not at what it is called', async () => {
    await tree({ 'proj/a.ts': 'x', 'home/.ssh/id': 'k' });
    await symlink(join(home, '.ssh'), join(base, 'proj', 'innocent'));
    await symlink(join(workspace), join(base, 'proj', 'back'));
    expect(await resolveExternal(join(base, 'proj', 'innocent'), context)).toEqual({ ok: false });
    expect(await resolveExternal(join(base, 'proj', 'innocent', 'id'), context)).toEqual({
      ok: false,
    });
    expect(await resolveExternal(join(base, 'proj', 'back'), context)).toEqual({ ok: false });
  });

  it('keeps the data directory below a root out of reach', async () => {
    const data = join(base, 'proj', 'state');
    await tree({ 'proj/a.ts': 'x', 'proj/state/log': 'l' });
    const found = await resolveExternal(join(base, 'proj'), {
      ...context,
      support: { homeDir: home, dataDir: data },
    });
    expect(found).toMatchObject({ ok: true });
    if (found.ok) expect(found.exclusions).toContain('state/**');
    // And a root that is inside the data directory is no root at all.
    expect(
      await resolveExternal(join(data, 'log'), {
        ...context,
        support: { homeDir: home, dataDir: data },
      }),
    ).toEqual({ ok: false });
  });

  it('always carries the rules about where credentials live', async () => {
    await tree({ 'proj/a.ts': 'x' });
    const found = await resolveExternal(join(base, 'proj'), context);
    if (!found.ok) throw new Error('expected a root');
    expect(found.exclusions).toEqual(expect.arrayContaining(['**/.ssh/**', '**/.aws/**']));
  });
});

describe('what Core decides on it', () => {
  const ceiling = (...capabilities: Capability[]): CapabilityCeiling => ({
    capabilities: new Set(capabilities),
    writeRoots: [],
    exclusions: [],
  });
  const demand = (root: string | undefined, requestId = 'req-1'): UnitDemand => ({
    requestId,
    agentRunId: 'run-1',
    capability: 'external.read',
    external: { root },
  });
  const grant = (resourceKey: string): AuthorizationEntry => ({
    scope: 'RUN',
    effect: 'ALLOW',
    capability: 'external.read',
    resourceKey,
  });
  const main = ceiling('repo.read', 'external.read');

  it('asks once for a folder, and never for a path that cannot be read', () => {
    expect(decideUnit(demand('/x/proj'), main, [])).toEqual({
      kind: 'ASK',
      capability: 'external.read',
      resourceKey: '/x/proj',
      critical: false,
    });
    expect(decideUnit(demand(undefined), main, [])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'EXTERNAL_PATH_UNAVAILABLE',
    });
  });

  it('allows what an entry covers, as a path of the file system does', () => {
    const entries = [grant('/x/proj')];
    expect(decideUnit(demand('/x/proj'), main, entries).kind).toBe('ALLOW');
    expect(decideUnit(demand('/x/proj/sub'), main, entries).kind).toBe('ALLOW');
    expect(decideUnit(demand('/x/project'), main, entries).kind).toBe('ASK');
    expect(decideUnit(demand('/x'), main, entries).kind).toBe('ASK');
  });

  it('is not there for an Agent without the capability', () => {
    expect(decideUnit(demand('/x/proj'), ceiling('repo.read'), [grant('/x/proj')])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'CAPABILITY_NOT_GRANTED',
    });
  });

  it('keeps a no binding on the AgentRun that was refused', () => {
    const refused: AuthorizationEntry = {
      scope: 'RUN',
      effect: 'DENY',
      capability: 'external.read',
      agentRunId: 'run-1',
    };
    expect(decideUnit(demand('/x/proj'), main, [refused])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'USER_DECLINED',
    });
    expect(decideUnit({ ...demand('/x/proj'), agentRunId: 'run-2' }, main, [refused]).kind).toBe(
      'ASK',
    );
  });

  it('is asked once for a repository, whatever tool or file comes next', () => {
    const auth = new RunAuthorization({
      repositoryRoot: '/repo',
      provider: 'deepseek',
      repositoryExclusions: [],
      webSearchTrusted: false,
      now: () => new Date(0),
    });
    const first = auth.askExternalRead('/x/proj', '/x/proj/a.ts', 'req-1', 'run-1');
    expect(first.requested).toMatchObject({
      capability: 'external.read',
      root: '/x/proj',
      path: '/x/proj/a.ts',
      provider: 'deepseek',
    });
    // The same folder asked about again joins the open question.
    const second = auth.askExternalRead('/x/proj', '/x/proj/b.ts', 'req-2', 'run-1');
    expect(second.requested).toBeUndefined();
    if (first.decision.kind !== 'PENDING') throw new Error('expected a question');
    const settled = auth.answer(first.decision.questionId, 'ALLOW');
    expect(settled?.waiters).toEqual(['req-1', 'req-2']);
    expect(auth.externalRoots()).toEqual(['/x/proj']);
    expect(auth.decide(demand('/x/proj/deep'), main).kind).toBe('ALLOW');
    // The entry is of this run only.
    auth.endLease();
    expect(auth.externalRoots()).toEqual([]);
  });
});
