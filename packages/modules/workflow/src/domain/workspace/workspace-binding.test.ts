import { newId, type ArtifactRef, type SessionLogRecord } from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { instructionsToLoad } from '../context/nested-instructions.js';
import { projectHistory } from '../context/history-projection.js';
import { fileBaselines, toolInputOf } from '../context/tool-inputs.js';
import { lastWorkspaceOf, workspaceChangedNote } from './workspace-binding.js';

/**
 * What changing the folder of a Session does to the history the model is shown, to the file
 * baselines and to the project instructions to load (M2Design 2.3). Every case builds the log the
 * product would write, so what is checked is what a real Session carries across a change.
 */
const at = '2026-11-10T00:00:00.000Z';
const digest = 'a'.repeat(64);
const run = newId('wfr');
const mainRun = newId('agr');
const ref = (digit: string): ArtifactRef => {
  const sha256 = digit.repeat(64);
  return { artifactId: `art_${sha256}`, sha256, size: 1, mediaType: 'text/plain' };
};

type Op =
  | { readonly op: 'turn' }
  | { readonly op: 'load'; readonly path: string; readonly digit: string }
  | { readonly op: 'skip'; readonly path: string }
  | { readonly op: 'read'; readonly path: string; readonly digit: string }
  | { readonly op: 'bind'; readonly root: string };

/** The records of a Session that starts in `/a` and then does `ops`, as Workflow writes them. */
function logOf(ops: readonly Op[]): SessionLogRecord[] {
  const out: object[] = [
    {
      type: 'SESSION_STARTED',
      formatVersion: 1,
      repositoryRoot: '/a',
      definitionsDigest: digest,
      definitionVersions: [],
    },
    {
      type: 'AGENT_RUN_REGISTERED',
      agentRunId: mainRun,
      nodeId: `nod_${'d'.repeat(32)}`,
      agentRef: { kind: 'AGENT', id: 'main', version: 'v1.0.0', digest },
      effort: 'high',
    },
  ];
  let turns = 0;
  let current: string | undefined;
  let root = '/a';
  let calls = 0;
  for (const each of ops) {
    if (each.op === 'turn') {
      turns += 1;
      current = `trn_${String(turns).padStart(32, '0')}`;
      out.push({ type: 'TURN_STARTED', turnId: current, promptNodeId: `nod_${'c'.repeat(32)}` });
    } else if (each.op === 'load') {
      out.push({
        type: 'PROJECT_FILE_LOADED',
        path: each.path,
        ref: ref(each.digit),
        sha256: each.digit.repeat(64),
        trusted: true,
        ...(each.path.includes('/') ? { agentRunId: mainRun } : {}),
      });
    } else if (each.op === 'skip') {
      out.push({
        type: 'PROJECT_FILE_LOADED',
        path: each.path,
        skipped: 'LIMIT',
        agentRunId: mainRun,
      });
    } else if (each.op === 'read') {
      calls += 1;
      const requestId = `req_${String(calls).padStart(32, '0')}`;
      out.push(
        {
          type: 'UNIT_SUBMITTED',
          requestId,
          path: `agr_abcdef/round-1/${String(calls)}#1`,
          agentRunId: mainRun,
          unitRunId: `unr_${'b'.repeat(32)}`,
          unitRef: { kind: 'UNIT', id: 'file-read', version: 'v1.0.0', digest },
          inputSource: {
            kind: 'TOOL_CALL',
            modelTurnRequestId: `req_${'0'.repeat(32)}`,
            toolCallId: `call_${String(calls)}`,
            workflowFields: { path: each.path },
          },
        },
        {
          type: 'UNIT_COMPLETED',
          requestId,
          status: 'OK',
          output: { path: each.path, fileSha256: each.digit.repeat(64) },
          budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
        },
      );
    } else {
      out.push({ type: 'WORKSPACE_BOUND', repositoryRoot: each.root, previousRoot: root });
      root = each.root;
    }
  }
  void current;
  return out.map(
    (entry, index) => ({ workflowRunId: run, at, ...entry, seq: index + 1 }) as SessionLogRecord,
  );
}

const main = { kind: 'MAIN' } as const;
const instructionsOf = (records: readonly SessionLogRecord[]) =>
  projectHistory(records, main).filter((entry) => entry.kind === 'PROJECT_INSTRUCTIONS');
const noteTexts = (records: readonly SessionLogRecord[]) =>
  projectHistory(records, main).flatMap((entry) => (entry.kind === 'NOTE' ? [entry.text] : []));

describe('the folder a Session is worked on in', () => {
  it('is the folder it started in, until a binding says another, and then the last one', () => {
    expect(lastWorkspaceOf(logOf([]))).toBe('/a');
    expect(lastWorkspaceOf(logOf([{ op: 'bind', root: '/b' }]))).toBe('/b');
    expect(
      lastWorkspaceOf(
        logOf([
          { op: 'bind', root: '/b' },
          { op: 'bind', root: '/a' },
          { op: 'bind', root: '/c' },
        ]),
      ),
    ).toBe('/c');
    expect(lastWorkspaceOf([])).toBeUndefined();
  });

  it('is told to the model with both folders, short even when the paths are very long', () => {
    const note = workspaceChangedNote('/old', '/new');
    expect(note).toContain('/old');
    expect(note).toContain('/new');
    expect(note).toContain('can be undone');
    const long = workspaceChangedNote(`/${'x'.repeat(4000)}`, `/${'y'.repeat(4000)}`);
    expect(long.length).toBeLessThan(2000);
  });
});

describe('project instructions across a change of folder', () => {
  it('are dropped when the folder changes, and the model is told', () => {
    const records = logOf([
      { op: 'turn' },
      { op: 'load', path: 'AGENTS.md', digit: '1' },
      { op: 'load', path: 'sub/AGENTS.md', digit: '2' },
      { op: 'bind', root: '/b' },
    ]);
    expect(instructionsOf(records)).toEqual([]);
    expect(noteTexts(records).at(-1)).toContain('The working folder changed from /a to /b');
  });

  it('are read again from the new folder, and shown alone', () => {
    const records = logOf([
      { op: 'load', path: 'AGENTS.md', digit: '1' },
      { op: 'bind', root: '/b' },
      { op: 'load', path: 'AGENTS.md', digit: '3' },
    ]);
    expect(instructionsOf(records)).toMatchObject([{ path: 'AGENTS.md', ref: ref('3') }]);
  });

  it('are shown again when the new folder holds the very same file, since it is a new folder', () => {
    const records = logOf([
      { op: 'load', path: 'AGENTS.md', digit: '1' },
      { op: 'bind', root: '/b' },
      { op: 'load', path: 'AGENTS.md', digit: '1' },
    ]);
    expect(instructionsOf(records)).toHaveLength(1);
    // The one shown is the one loaded after the change: it follows the note.
    const entries = projectHistory(records, main);
    const note = entries.findIndex((entry) => entry.kind === 'NOTE');
    const shown = entries.findIndex((entry) => entry.kind === 'PROJECT_INSTRUCTIONS');
    expect(shown).toBeGreaterThan(note);
  });

  it('are none at all when the new folder has none', () => {
    const records = logOf([
      { op: 'load', path: 'AGENTS.md', digit: '1' },
      { op: 'bind', root: '/b' },
      { op: 'turn' },
    ]);
    expect(instructionsOf(records)).toEqual([]);
  });

  it('go back and forth: only what the folder of the moment holds is ever shown', () => {
    const steps: Op[] = [
      { op: 'load', path: 'AGENTS.md', digit: '1' },
      { op: 'bind', root: '/b' },
      { op: 'load', path: 'AGENTS.md', digit: '2' },
      { op: 'bind', root: '/a' },
      { op: 'load', path: 'AGENTS.md', digit: '1' },
      { op: 'bind', root: '/b' },
      { op: 'load', path: 'AGENTS.md', digit: '2' },
    ];
    for (let n = 1; n <= steps.length; n += 1) {
      const records = logOf(steps.slice(0, n));
      const bound = steps.slice(0, n).filter((each) => each.op === 'bind').length;
      const found = instructionsOf(records);
      expect(found.length).toBeLessThanOrEqual(1);
      expect(
        noteTexts(records).filter((text) => text.startsWith('The working folder')),
      ).toHaveLength(bound);
    }
    expect(instructionsOf(logOf(steps))).toMatchObject([{ ref: ref('2') }]);
  });

  it('take the place of an earlier version of the same file in the same folder', () => {
    const records = logOf([
      { op: 'load', path: 'AGENTS.md', digit: '1' },
      { op: 'load', path: 'AGENTS.md', digit: '2' },
      { op: 'load', path: 'AGENTS.md', digit: '1' },
    ]);
    expect(instructionsOf(records)).toMatchObject([{ ref: ref('1') }]);
  });

  it('keep the conversation: only what belongs to the folder goes', () => {
    const before = logOf([{ op: 'turn' }, { op: 'load', path: 'AGENTS.md', digit: '1' }]);
    const after = logOf([
      { op: 'turn' },
      { op: 'load', path: 'AGENTS.md', digit: '1' },
      { op: 'bind', root: '/b' },
    ]);
    const kinds = (records: readonly SessionLogRecord[]) =>
      projectHistory(records, main)
        .map((entry) => entry.kind)
        .filter((kind) => kind !== 'PROJECT_INSTRUCTIONS' && kind !== 'NOTE');
    expect(kinds(after)).toEqual(kinds(before));
  });

  it('survive an undo that names a Turn from before the change, which Kernel never asks for', () => {
    const records = [
      ...logOf([
        { op: 'turn' },
        { op: 'load', path: 'sub/AGENTS.md', digit: '1' },
        { op: 'bind', root: '/b' },
        { op: 'turn' },
        { op: 'load', path: 'AGENTS.md', digit: '3' },
      ]),
    ];
    const stale = {
      workflowRunId: run,
      at,
      type: 'WORKSPACE_REVERTED',
      revertedTurnIds: [`trn_${'1'.padStart(32, '0')}`],
      seq: records.length + 1,
    } as unknown as SessionLogRecord;
    const shown = instructionsOf([...records, stale]);
    expect(shown).toMatchObject([{ path: 'AGENTS.md', ref: ref('3') }]);
  });
});

describe('nested project instructions across a change of folder', () => {
  /** What the main Agent's next assembly must read, after the log of `ops` and a read that passed `passing`. */
  const wanted = (ops: readonly Op[], passing: readonly string[], limit = 20) => {
    const records = [
      ...logOf(ops),
      {
        workflowRunId: run,
        at,
        type: 'UNIT_SUBMITTED',
        requestId: `req_${'9'.padStart(32, '0')}`,
        agentRunId: mainRun,
      },
      {
        workflowRunId: run,
        at,
        type: 'UNIT_COMPLETED',
        requestId: `req_${'9'.padStart(32, '0')}`,
        status: 'OK',
        output: { nestedInstructions: passing },
        budget: { agentRun: 'NORMAL', turn: 'NORMAL', run: 'NORMAL' },
      },
    ].map((record, index) => ({ ...record, seq: index + 1 }) as unknown as SessionLogRecord);
    return instructionsToLoad(records, main, run, mainRun, limit);
  };

  it('are wanted again once the folder changed: nothing was loaded from the new one', () => {
    const loaded: Op[] = [{ op: 'turn' }, { op: 'load', path: 'sub/AGENTS.md', digit: '1' }];
    // Loaded in /a: a read of the same directory wants nothing.
    expect(wanted(loaded, ['sub/AGENTS.md'])).toEqual([]);
    // After the change the same read wants it again, in the new folder.
    expect(
      wanted([...loaded, { op: 'bind', root: '/b' }], ['sub/AGENTS.md']).map((each) => each.path),
    ).toEqual(['sub/AGENTS.md']);
  });

  it('count against the limit only in the folder they are in', () => {
    const two: Op[] = [
      { op: 'turn' },
      { op: 'load', path: 'one/AGENTS.md', digit: '1' },
      { op: 'load', path: 'two/AGENTS.md', digit: '2' },
    ];
    // The limit is two below the root: a third in the same folder is only noted.
    expect(wanted(two, ['three/AGENTS.md'], 2)).toEqual([{ path: 'three/AGENTS.md', skip: true }]);
    // In the new folder none is loaded yet, so the same one is loaded.
    expect(wanted([...two, { op: 'bind', root: '/b' }], ['three/AGENTS.md'], 2)).toEqual([
      { path: 'three/AGENTS.md', skip: false },
    ]);
  });

  it('forget what was left out for the limit in the old folder', () => {
    const skipped: Op[] = [{ op: 'turn' }, { op: 'skip', path: 'deep/AGENTS.md' }];
    expect(wanted(skipped, ['deep/AGENTS.md'])).toEqual([]);
    expect(wanted([...skipped, { op: 'bind', root: '/b' }], ['deep/AGENTS.md'])).toEqual([
      { path: 'deep/AGENTS.md', skip: false },
    ]);
  });
});

describe('the baselines of files read or written, across a change of folder', () => {
  const edit = (records: readonly SessionLogRecord[], path: string) =>
    toolInputOf('FILE_EDIT', { path, oldString: 'a', newString: 'b' }, records, main);

  it('are those of the folder of the moment: an edit needs a read in the new folder first', () => {
    const records = logOf([
      { op: 'read', path: 'src/a.ts', digit: '1' },
      { op: 'bind', root: '/b' },
    ]);
    expect(fileBaselines(records).size).toBe(0);
    expect(edit(records, 'src/a.ts')).toMatchObject({
      ok: false,
      message: expect.stringContaining('read the file') as string,
    });
  });

  it('are made again by a read after the change, and not mixed with the old folder', () => {
    const records = logOf([
      { op: 'read', path: 'src/a.ts', digit: '1' },
      { op: 'read', path: 'src/old.ts', digit: '2' },
      { op: 'bind', root: '/b' },
      { op: 'read', path: 'src/a.ts', digit: '3' },
    ]);
    const baselines = fileBaselines(records);
    expect([...baselines.keys()]).toEqual(['src/a.ts']);
    expect(baselines.get('src/a.ts')).toEqual({ kind: 'SHA', sha256: '3'.repeat(64) });
    expect(edit(records, 'src/a.ts')).toMatchObject({ ok: true });
    expect(edit(records, 'src/old.ts')).toMatchObject({ ok: false });
  });

  it('are cleared again by every change, however often the folder changes', () => {
    for (const times of [1, 2, 5]) {
      const ops: Op[] = [{ op: 'read', path: 'x.ts', digit: '1' }];
      for (let i = 0; i < times; i += 1) ops.push({ op: 'bind', root: i % 2 === 0 ? '/b' : '/a' });
      expect(fileBaselines(logOf(ops)).size).toBe(0);
    }
  });
});

describe('any order of reads, loads and changes (property)', () => {
  const paths = ['AGENTS.md', 'sub/AGENTS.md', 'src/a.ts', 'src/b.ts'];
  const roots = ['/a', '/b', '/c'];
  const operation: fc.Arbitrary<Op> = fc.oneof(
    fc.constant<Op>({ op: 'turn' }),
    fc.record({
      op: fc.constant('load' as const),
      path: fc.constantFrom('AGENTS.md', 'sub/AGENTS.md'),
      digit: fc.constantFrom('1', '2', '3'),
    }),
    fc.record({
      op: fc.constant('read' as const),
      path: fc.constantFrom(...paths.filter((path) => path.endsWith('.ts'))),
      digit: fc.constantFrom('1', '2', '3'),
    }),
    fc.record({ op: fc.constant('bind' as const), root: fc.constantFrom(...roots) }),
  );

  it('shows each instruction file once, as it was last loaded since the last change', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 40 }), (ops) => {
        const records = logOf(ops);
        const shown = instructionsOf(records);
        const lastBind = ops.map((each) => each.op).lastIndexOf('bind');
        const wanted = new Map<string, string>();
        for (const each of ops.slice(lastBind + 1))
          if (each.op === 'load') wanted.set(each.path, each.digit);
        expect(
          shown.map((entry) => (entry.kind === 'PROJECT_INSTRUCTIONS' ? entry.path : '')),
        ).toEqual(expect.arrayContaining([...wanted.keys()]));
        expect(
          new Set(shown.map((entry) => entry.kind === 'PROJECT_INSTRUCTIONS' && entry.path)).size,
        ).toBe(shown.length);
        for (const entry of shown)
          if (entry.kind === 'PROJECT_INSTRUCTIONS')
            expect(entry.ref).toEqual(ref(wanted.get(entry.path) ?? '?'));
        expect(shown).toHaveLength(wanted.size);
      }),
      { numRuns: 300 },
    );
  });

  it('knows a file only if it was read since the last change, with what that read saw', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 40 }), (ops) => {
        const baselines = fileBaselines(logOf(ops));
        const lastBind = ops.map((each) => each.op).lastIndexOf('bind');
        const wanted = new Map<string, string>();
        for (const each of ops.slice(lastBind + 1))
          if (each.op === 'read') wanted.set(each.path, each.digit);
        expect([...baselines.keys()].sort()).toEqual([...wanted.keys()].sort());
        for (const [path, digit] of wanted)
          expect(baselines.get(path)).toEqual({ kind: 'SHA', sha256: digit.repeat(64) });
      }),
      { numRuns: 300 },
    );
  });

  it('tells the model once per change, and never fails to project', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 40 }), (ops) => {
        const records = logOf(ops);
        const binds = ops.filter((each) => each.op === 'bind').length;
        const notes = noteTexts(records).filter((text) => text.startsWith('The working folder'));
        expect(notes).toHaveLength(binds);
        expect(lastWorkspaceOf(records)).toBe(
          [...ops].reverse().find((each) => each.op === 'bind')?.root ?? '/a',
        );
      }),
      { numRuns: 300 },
    );
  });
});
