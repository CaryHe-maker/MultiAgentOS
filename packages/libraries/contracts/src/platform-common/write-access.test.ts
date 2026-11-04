import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isProjectInstructionPath,
  isWritable,
  normalizeRequestPath,
  writableRoots,
  writeRootCovers,
  writeRootsOverlap,
  type WriteProfile,
} from './write-access.js';

const everywhere = { writeRoots: ['.'], exclusions: [] };

const refusal = (path: string, profile: WriteProfile = everywhere) => {
  const access = isWritable(profile, path);
  return access.writable ? 'WRITABLE' : access.reasonCode;
};

const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/u);
const relativePath = fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => s.join('/'));

describe('isWritable', () => {
  it('allows an ordinary path and names the root it falls under', () => {
    expect(isWritable(everywhere, 'src/./a.ts')).toEqual({
      writable: true,
      path: 'src/a.ts',
      writeRoot: '.',
    });
    expect(isWritable({ writeRoots: ['lib', 'src'], exclusions: [] }, 'src/a.ts')).toMatchObject({
      writeRoot: 'src',
    });
  });

  it.each([
    '/etc/passwd',
    'C:/Windows/system32',
    '../outside',
    'src/../../outside',
    'src\\..\\..\\outside',
    'a\0b',
    '',
    '.',
    './',
  ])('refuses %j as out of scope', (path) => {
    expect(refusal(path)).toBe('WRITE_OUT_OF_SCOPE');
  });

  it('refuses a path outside the write roots, even one that only shares a prefix', () => {
    const profile = { writeRoots: ['src'], exclusions: [] };
    expect(refusal('lib/a.ts', profile)).toBe('WRITE_OUT_OF_SCOPE');
    expect(refusal('src-old/a.ts', profile)).toBe('WRITE_OUT_OF_SCOPE');
    expect(refusal('src/a.ts', profile)).toBe('WRITABLE');
  });

  it.each([
    '.git/config',
    '.git',
    'vendor/.git/config',
    '.GIT/hooks/pre-commit',
    '.multiagentos/sessions/x',
    'nested/.MultiAgentOS/x',
    '.env',
    'apps/.env.local',
    'keys/server.pem',
    'node_modules/a/index.js',
    // What Windows reads as the names above.
    '.git./config',
    '.git /config',
    '.env::$DATA',
    '.git::$INDEX_ALLOCATION/config',
  ])('refuses %j as protected', (path) => {
    expect(refusal(path)).toBe('PROTECTED_PATH');
  });

  it('applies the rules the Session adds', () => {
    const profile = { writeRoots: ['.'], exclusions: ['secrets/**'] };
    expect(refusal('secrets/a.txt', profile)).toBe('PROTECTED_PATH');
    expect(refusal('public/a.txt', profile)).toBe('WRITABLE');
  });

  it('leaves AGENTS.md writable, and says it is critical in any directory', () => {
    expect(refusal('pkg/AGENTS.md')).toBe('WRITABLE');
    expect(isProjectInstructionPath('AGENTS.md')).toBe(true);
    expect(isProjectInstructionPath('pkg/agents.MD')).toBe(true);
    expect(isProjectInstructionPath('pkg/AGENTS.md.')).toBe(true);
    expect(isProjectInstructionPath('AGENTS.md/other')).toBe(false);
    expect(isProjectInstructionPath('MY_AGENTS.md')).toBe(false);
  });

  it('agrees with writableRoots: whatever is writable lies under a root it returns', () => {
    fc.assert(
      fc.property(
        fc.array(relativePath, { minLength: 1, maxLength: 4 }),
        relativePath,
        (writeRoots, path) => {
          const access = isWritable({ writeRoots, exclusions: [] }, path);
          const roots = writableRoots({ writeRoots });
          if (access.writable) expect(roots).toContain(access.writeRoot);
          expect(access.writable).toBe(roots.some((root) => writeRootCovers(root, path)));
        },
      ),
    );
  });

  it('never allows a path that climbs out, however it is spelled', () => {
    const climbing = fc
      .tuple(fc.array(segment, { maxLength: 3 }), fc.array(segment, { maxLength: 3 }))
      .map(([down, rest]) =>
        [...down, ...down.map(() => '..'), '..', ...rest].join('/'),
      );
    fc.assert(
      fc.property(climbing, (path) => {
        expect(refusal(path)).toBe('WRITE_OUT_OF_SCOPE');
      }),
    );
  });

  it('never allows anything below a protected directory, in any case', () => {
    const protectedName = fc
      .constantFrom('.git', '.multiagentos', 'node_modules')
      .chain((name) =>
        fc
          .array(fc.boolean(), { minLength: name.length, maxLength: name.length })
          .map((upper) =>
            [...name].map((c, i) => (upper[i] === true ? c.toUpperCase() : c)).join(''),
          ),
      );
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 3 }),
        protectedName,
        relativePath,
        (above, name, below) => {
          expect(refusal([...above, name, below].join('/'))).toBe('PROTECTED_PATH');
        },
      ),
    );
  });

  it('gives the same answer for a path and its normalized form', () => {
    fc.assert(
      fc.property(relativePath, (path) => {
        const spelled = `./${path.replaceAll('/', '//')}/`;
        expect(normalizeRequestPath(spelled)).toBe(path);
        expect(isWritable(everywhere, spelled)).toEqual(isWritable(everywhere, path));
      }),
    );
  });
});

describe('write roots', () => {
  it('drops a root nested in another and repeats', () => {
    expect(writableRoots({ writeRoots: ['src/a', 'src', './src/', 'lib'] })).toEqual([
      'lib',
      'src',
    ]);
    expect(writableRoots({ writeRoots: ['src', '.'] })).toEqual(['.']);
  });

  it('treats a root outside the repository as a defect', () => {
    expect(() => writableRoots({ writeRoots: ['../x'] })).toThrow(/leaves the repository/u);
  });

  it('overlap means some path lies under both', () => {
    expect(writeRootsOverlap(['src'], ['src/a'])).toBe(true);
    expect(writeRootsOverlap(['src/a'], ['src'])).toBe(true);
    expect(writeRootsOverlap(['.'], ['src'])).toBe(true);
    expect(writeRootsOverlap(['src'], ['src-old'])).toBe(false);
    expect(writeRootsOverlap(['src', 'lib'], ['docs', 'lib/x'])).toBe(true);
  });

  it('overlap is symmetric and agrees with covering', () => {
    fc.assert(
      fc.property(relativePath, relativePath, relativePath, (left, right, path) => {
        expect(writeRootsOverlap([left], [right])).toBe(writeRootsOverlap([right], [left]));
        if (writeRootCovers(left, path) && writeRootCovers(right, path))
          expect(writeRootsOverlap([left], [right])).toBe(true);
      }),
    );
  });
});
