import type { RunSubagentsArgs } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { validateSpawn, type SpawnContext } from './validate-spawn.js';

const context = (overrides: Partial<SpawnContext> = {}): SpawnContext => ({
  rules: { maxSubagentsPerCall: 4, maxDependencyDepth: 2, maxTasks: 12, maxSpawnCalls: 4 },
  agents: new Map([
    ['explorer', { writes: false, allowedEfforts: ['none', 'low'] }],
    ['worker', { writes: true, allowedEfforts: ['low', 'high', 'max'] }],
  ]),
  callerRoots: ['.'],
  spawned: { tasks: 0, calls: 0 },
  readable: () => true,
  ...overrides,
});

const explorer = (name: string, extra: object = {}) => ({
  name,
  agent: 'explorer' as const,
  goal: `look at ${name}`,
  ...extra,
});
const worker = (name: string, writeScope: string[], extra: object = {}) => ({
  name,
  agent: 'worker' as const,
  goal: `change ${name}`,
  writeScope,
  ...extra,
});
const codes = (args: RunSubagentsArgs, ctx = context()) => {
  const result = validateSpawn(args, ctx);
  return result.ok ? [] : result.errors.map((error) => error.code);
};

describe('validateSpawn', () => {
  it('accepts a plain call and keeps the order the caller wrote', () => {
    const result = validateSpawn(
      { tasks: [explorer('b'), worker('a', ['src/a']), explorer('c', { dependsOn: ['b'] })] },
      context(),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.plan.tasks.map((task) => [task.name, task.writeRoots])).toEqual([
        ['b', []],
        ['a', ['src/a']],
        ['c', []],
      ]);
  });

  it('refuses more tasks than a call may start', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((name) => explorer(name));
    expect(codes({ tasks })).toEqual(['TOO_MANY_TASKS']);
  });

  it('refuses a name used twice and a dependency outside the call', () => {
    expect(codes({ tasks: [explorer('a'), explorer('a')] })).toContain('DUPLICATE_NAME');
    expect(codes({ tasks: [explorer('a', { dependsOn: ['zzz'] })] })).toEqual([
      'UNKNOWN_DEPENDENCY',
    ]);
  });

  it('refuses a circle and a chain that is too deep', () => {
    expect(
      codes({
        tasks: [explorer('a', { dependsOn: ['b'] }), explorer('b', { dependsOn: ['a'] })],
      }),
    ).toEqual(['CYCLE']);
    expect(
      codes({
        tasks: [
          explorer('a'),
          explorer('b', { dependsOn: ['a'] }),
          explorer('c', { dependsOn: ['b'] }),
          explorer('d', { dependsOn: ['c'] }),
        ],
      }),
    ).toEqual(['TOO_DEEP']);
  });

  it('wants a writeScope for a worker only', () => {
    expect(codes({ tasks: [{ name: 'w', agent: 'worker', goal: 'x' }] })).toEqual([
      'WRITE_SCOPE_REQUIRED',
    ]);
    expect(codes({ tasks: [explorer('e', { writeScope: ['src'] })] })).toEqual([
      'WRITE_SCOPE_FORBIDDEN',
    ]);
  });

  it('keeps a writeScope inside what the caller may write', () => {
    expect(codes({ tasks: [worker('w', ['../outside'])] })).toEqual(['WRITE_SCOPE_OUTSIDE']);
    expect(codes({ tasks: [worker('w', ['/etc'])] })).toEqual(['WRITE_SCOPE_OUTSIDE']);
    expect(codes({ tasks: [worker('w', ['lib/x'])] }, context({ callerRoots: ['src'] }))).toEqual([
      'WRITE_SCOPE_OUTSIDE',
    ]);
    expect(codes({ tasks: [worker('w', ['src/x'])] }, context({ callerRoots: ['src'] }))).toEqual(
      [],
    );
  });

  it('refuses tasks that can run together and write the same files', () => {
    expect(codes({ tasks: [worker('a', ['src']), worker('b', ['src/api'])] })).toEqual([
      'WRITE_SCOPE_OVERLAP',
    ]);
  });

  it('lets tasks that wait for each other share files', () => {
    expect(
      codes({ tasks: [worker('a', ['src']), worker('b', ['src/api'], { dependsOn: ['a'] })] }),
    ).toEqual([]);
  });

  it('keeps an effort inside what the Agent allows', () => {
    expect(codes({ tasks: [explorer('e', { effort: 'max' })] })).toEqual(['EFFORT_NOT_ALLOWED']);
    expect(codes({ tasks: [worker('w', ['src'], { effort: 'none' })] })).toEqual([
      'EFFORT_NOT_ALLOWED',
    ]);
  });

  it('counts tasks and calls per Turn', () => {
    expect(codes({ tasks: [explorer('a')] }, context({ spawned: { tasks: 0, calls: 4 } }))).toEqual(
      ['SPAWN_LIMIT'],
    );
    expect(
      codes(
        { tasks: [explorer('a'), explorer('b')] },
        context({ spawned: { tasks: 11, calls: 1 } }),
      ),
    ).toEqual(['SPAWN_LIMIT']);
  });

  it('hands over only what the caller can read', () => {
    const ref = {
      artifactId: `art_${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      size: 1,
      mediaType: 'text/plain',
    };
    expect(
      codes({ tasks: [explorer('e', { inputs: [ref] })] }, context({ readable: () => false })),
    ).toEqual(['INPUT_NOT_READABLE']);
  });

  it('reports every rule that fails, not only the first', () => {
    expect(codes({ tasks: [{ name: 'w', agent: 'worker', goal: 'x', effort: 'none' }] })).toEqual([
      'EFFORT_NOT_ALLOWED',
      'WRITE_SCOPE_REQUIRED',
    ]);
  });
});
