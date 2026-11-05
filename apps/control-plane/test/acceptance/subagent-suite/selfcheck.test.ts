import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CASES, REFERENCES } from './fixtures.js';

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })));
});

async function materialize(files: Readonly<Record<string, string>>): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'mas-selfcheck-'));
  made.push(repository);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  return repository;
}

describe('the suite checks', () => {
  for (const def of CASES.filter((each) => REFERENCES[each.id] !== undefined)) {
    it(`${def.id}: fail on the fixture, pass on the reference solution`, async () => {
      const before = await def.check(await materialize(def.files), []);
      expect(Object.values(before).every(Boolean)).toBe(false);
      const solved = await materialize(def.files);
      await REFERENCES[def.id]?.(solved);
      const after = await def.check(solved, []);
      expect(after).toEqual(Object.fromEntries(Object.keys(after).map((key) => [key, true])));
    }, 60_000);
  }

  it('K2 wants the file and the empty object in the answer', async () => {
    const def = CASES.find((each) => each.id === 'K2-question');
    const repository = await materialize(def?.files ?? {});
    expect(Object.values((await def?.check(repository, ['not sure'])) ?? {}).every(Boolean)).toBe(
      false,
    );
    expect(
      Object.values(
        (await def?.check(repository, ['src/config/parse.js returns an empty object {}'])) ?? {},
      ).every(Boolean),
    ).toBe(true);
  });
});
