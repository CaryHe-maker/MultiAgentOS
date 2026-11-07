/**
 * The inventory of the frozen system tests (docs/M2/M2FrozenTests.md) is itself tested: every
 * invariant of M2Design 12 and every release blocker of 14.1 names the tests that hold it, and
 * each of those tests is still where the inventory says. A frozen test cannot be renamed or
 * removed without this test failing, so freezing is not a matter of remembering.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Entry {
  readonly id: string;
  readonly kind: 'invariant' | 'blocker' | 'group';
  readonly statement: string;
  readonly tests: readonly { readonly file: string; readonly title?: string }[];
  readonly deferred?: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const manifest = JSON.parse(
  await readFile(join(root, 'apps/control-plane/test/system/frozen.json'), 'utf8'),
) as Entry[];

describe('the inventory of frozen tests', () => {
  it('has every invariant of M2Design 12 and every release blocker of 14.1', () => {
    const ids = new Set(manifest.map((entry) => entry.id));
    for (let number = 1; number <= 30; number += 1)
      expect(ids.has(`I${String(number)}`)).toBe(true);
    for (let number = 1; number <= 8; number += 1) expect(ids.has(`B${String(number)}`)).toBe(true);
    expect(manifest.filter((entry) => entry.kind === 'invariant')).toHaveLength(30);
    expect(manifest.filter((entry) => entry.kind === 'blocker')).toHaveLength(8);
  });

  it('names at least one test for every entry, unless it says why not yet', () => {
    const empty = manifest.filter(
      (entry) => entry.tests.length === 0 && entry.deferred === undefined,
    );
    expect(empty.map((entry) => entry.id)).toEqual([]);
  });

  it('gives every deferred entry a reason that names where it will be done', () => {
    for (const entry of manifest.filter((each) => each.deferred !== undefined))
      expect(entry.deferred).toMatch(/phase \d/u);
  });

  for (const entry of manifest)
    it(`${entry.id}: every test it names is still there`, async () => {
      const missing: string[] = [];
      for (const test of entry.tests) {
        const source = await readFile(join(root, test.file), 'utf8').catch(() => undefined);
        if (source === undefined) missing.push(`${test.file} (no such file)`);
        else if (test.title !== undefined && !source.includes(test.title))
          missing.push(`${test.file}: "${test.title}"`);
      }
      expect(missing).toEqual([]);
    });
});
