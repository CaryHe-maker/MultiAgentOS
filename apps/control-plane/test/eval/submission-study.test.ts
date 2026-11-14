/**
 * The judges of the submission study are checked before any run is spent on them: on every
 * repository as the model gets it the hidden tests fail, and on the reference solution they all
 * pass, and the judge says so (Phase2Plan 7).
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Observation } from './spec.js';
import { STUDY_FIXTURES, SUBMISSION_STUDY_TASKS, hidden } from './tasks/submission-study.js';

/** Python 3.11 or later (tomllib) is what the tasks are written for. */
function python(): boolean {
  try {
    const version = execFileSync(
      'python3',
      ['-c', 'import sys; print(sys.version_info >= (3, 11))'],
      {
        encoding: 'utf8',
      },
    );
    return version.trim() === 'True';
  } catch {
    return false;
  }
}

const withPython = python() ? describe : describe.skip;
const TIMEOUT = 180_000;

const observationOf = (repository: string): Observation => ({
  repository,
  dataDir: repository,
  printed: (kind) => (kind === 'REPLY' ? ['done'] : []),
  questions: [],
  requests: [],
  log: [],
  exitCode: 0,
});

withPython('the judges of the submission study', () => {
  for (const task of SUBMISSION_STUDY_TASKS) {
    const name = task.id.replace('study.', '');
    it(
      `${task.id}: the hidden tests fail on the given repository and pass on the reference`,
      async () => {
        const repository = await mkdtemp(join(tmpdir(), 'mas-study-'));
        try {
          await task.fixture(repository);
          const before = await hidden(name, repository);
          expect(before.failed.length, before.output).toBeGreaterThan(0);

          await cp(join(STUDY_FIXTURES, name, 'reference'), repository, { recursive: true });
          const after = await hidden(name, repository);
          expect(after.failed, after.output).toEqual([]);
          // The same tests ran, unless the package to test did not exist at all before.
          if (before.passed.length + before.failed.length > 1)
            expect(after.passed.length).toBe(before.passed.length + before.failed.length);

          const checks = await task.judge(observationOf(repository));
          const hiddenCheck = checks.find((each) => each.name.includes('hidden tests pass'));
          expect(hiddenCheck?.ok, hiddenCheck?.detail).toBe(true);
          const recorded = checks.find((each) => each.name === 'recorded: the shape of the run');
          expect(recorded?.ok).toBe(true);
          if (name === 'sales') {
            const fast = checks.find((each) => each.name.includes('under 2 seconds'));
            expect(fast?.ok, fast?.detail).toBe(true);
          }
        } finally {
          await rm(repository, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }

  it('never names a specialist, templates, subtasks or splitting in a goal', () => {
    for (const task of SUBMISSION_STUDY_TASKS)
      for (const step of task.steps)
        if ('run' in step)
          expect(step.run).not.toMatch(
            /fixer|reviewer|tester|integrator|researcher|subMission|模板|子任务|拆|并行|分给|worker|explorer/iu,
          );
  });
});
