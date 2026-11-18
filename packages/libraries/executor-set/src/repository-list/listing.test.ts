import { describe, expect, it } from 'vitest';
import { globMatcher, renderListing } from './listing.js';

const paths = ['README.md', 'src/a.ts', 'src/deep/b.ts', 'src/deep/more/c.ts', 'test/d.test.ts'];
const wide = { maxBytes: 10_000, maxLines: 100 };

describe('renderListing (ExecutorSet 5)', () => {
  it('lists two levels by default, directories first, with file counts', () => {
    expect(renderListing(paths, {}, wide)).toEqual({
      output: { path: '.', directoryCount: 4, fileCount: 5, omittedEntries: 0 },
      preview: [
        'src/ [3 files]',
        '  deep/ [2 files]',
        '  a.ts',
        'test/ [1 files]',
        '  d.test.ts',
        'README.md',
      ].join('\n'),
    });
  });

  it('honours depth and a sub-path', () => {
    expect(renderListing(paths, { depth: 1 }, wide)?.preview.split('\n')).toEqual([
      'src/ [3 files]',
      'test/ [1 files]',
      'README.md',
    ]);
    expect(renderListing(paths, { path: 'src/deep', depth: 3 }, wide)?.preview.split('\n')).toEqual(
      ['more/ [1 files]', '  c.ts', 'b.ts'],
    );
  });

  it('filters by glob relative to the path', () => {
    expect(renderListing(paths, { glob: '**/*.test.ts' }, wide)?.output.fileCount).toBe(1);
    expect(renderListing(paths, { path: 'src', glob: '*.ts' }, wide)?.output.fileCount).toBe(1);
  });

  it.each(['missing', '../outside', '/etc'])('answers nothing for %s', (path) => {
    expect(renderListing(paths, { path }, wide)).toBeUndefined();
  });

  it('lists an empty repository', () => {
    expect(renderListing([], {}, wide)?.output).toMatchObject({ fileCount: 0 });
  });

  it('keeps a full output and counts what the preview left out', () => {
    const listing = renderListing(paths, {}, { maxBytes: 10_000, maxLines: 2 });
    expect(listing?.output.omittedEntries).toBe(4);
    expect(listing?.preview).toContain('4 more entries omitted');
    expect(listing?.preview).toContain('read_output');
    expect(listing?.full?.split('\n')).toHaveLength(6);
  });

  it('gives the same bytes for the same input', () => {
    expect(renderListing(paths, {}, wide)).toEqual(renderListing([...paths].reverse(), {}, wide));
  });
});

describe('globMatcher', () => {
  it('keeps * and ? inside a segment and lets ** cross them', () => {
    expect(globMatcher('*.ts')('a.ts')).toBe(true);
    expect(globMatcher('*.ts')('src/a.ts')).toBe(false);
    expect(globMatcher('src/**/*.ts')('src/a.ts')).toBe(true);
    expect(globMatcher('src/**/*.ts')('src/x/y/a.ts')).toBe(true);
    expect(globMatcher('a?.ts')('ab.ts')).toBe(true);
    expect(globMatcher('a.b')('axb')).toBe(false);
  });
});
