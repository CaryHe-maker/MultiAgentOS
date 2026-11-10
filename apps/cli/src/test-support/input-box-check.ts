import { renderToString } from 'ink';
import { createElement as h } from 'react';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { InputBox } from '../presentation/ink-console.js';
import { viewBox, type InputState } from '../presentation/text-input.js';

/**
 * The box is drawn by Ink itself, and the cursor is placed from the same cut and measure. This
 * draws many boxes with Ink and finds the character under the cursor in what Ink drew: the row and
 * column must be the ones the view (`viewBox`) gives, and the rows must be as many as it counts.
 * If Ink ever cuts a line differently, this fails, and nothing else has to be guessed at.
 */

const ESCAPE = String.fromCharCode(27);
const strip = (text: string): string =>
  text.replace(new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, 'gu'), '');

const SENTINEL = '§';
const PIECES = [
  'a',
  'b',
  'x',
  ' ',
  ' ',
  '你',
  '好',
  'é',
  'Api',
  'key',
  '-',
  '😀',
  '，',
  '1.',
  '“',
  '”',
  '—',
  '…',
  '·',
  '\n',
  // A placeholder for a paste of three lines (the state below holds the text).
  String.fromCharCode(0xe000),
];

const PASTES = ['一\n二\n三'];

/** A small deterministic generator, so a failure can be run again. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/** The whole box (no window) drawn by Ink, and the view the cursor is placed from. */
function draw(state: InputState, columns: number) {
  const view = viewBox(state, '› ', '  ', columns, 10_000, 0);
  const rows = strip(renderToString(h(InputBox, { view }), { columns })).split('\n');
  return { rows, view };
}

/** Registers the checks in the test file that calls it: under the ruler that file has set. */
export function inputBoxAgreesWithInk(): void {
  describe('the input box is drawn and its cursor placed by one cut', () => {
    it('puts the character under the cursor where the view says, in any text and width', () => {
      const next = random(7);
      let checked = 0;
      for (let round = 0; round < 400; round += 1) {
        const columns = 8 + Math.floor(next() * 30);
        const length = 1 + Math.floor(next() * 40);
        let value = '';
        for (let index = 0; index < length; index += 1)
          value += PIECES[Math.floor(next() * PIECES.length)] ?? 'a';
        const cursor = Math.floor(next() * (value.length + 1));
        if (value.slice(cursor, cursor + 2).startsWith('\n') || cursor === value.length) continue;
        // A cursor inside a surrogate pair does not exist: the state keeps it between characters.
        const code = value.charCodeAt(cursor);
        if (code >= 0xdc00 && code <= 0xdfff) continue;
        const marked = `${value.slice(0, cursor)}${SENTINEL}${value.slice(cursor)}`;
        const state = { value: marked, cursor, pastes: PASTES };
        const { rows, view } = draw(state, columns);
        const row = rows.findIndex((each) => each.includes(SENTINEL));
        expect(row, `${JSON.stringify(marked)} at ${String(columns)}`).toBeGreaterThanOrEqual(0);
        const expected = { row: view.cursorRow, column: view.cursorColumn };
        const column = stringWidth((rows[row] ?? '').slice(0, (rows[row] ?? '').indexOf(SENTINEL)));
        expect({ row, column }, `${JSON.stringify(marked)} at ${String(columns)}`).toEqual(
          expected,
        );
        expect(rows.length, `${JSON.stringify(marked)} at ${String(columns)}`).toBe(view.shown);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(200);
    });

    it('counts the rows Ink draws when the cursor is at the end of the text', () => {
      const next = random(11);
      for (let round = 0; round < 300; round += 1) {
        const columns = 8 + Math.floor(next() * 30);
        const length = 1 + Math.floor(next() * 40);
        let value = '';
        for (let index = 0; index < length; index += 1)
          value += PIECES[Math.floor(next() * PIECES.length)] ?? 'a';
        const state = { value, cursor: value.length, pastes: PASTES };
        const { rows, view } = draw(state, columns);
        const label = `${JSON.stringify(value)} at ${String(columns)}`;
        expect(rows.length, label).toBe(view.shown);
        expect(view.cursorRow, label).toBeLessThan(rows.length);
      }
    });
  });
}
