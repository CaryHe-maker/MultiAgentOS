import { afterEach, describe, it } from 'vitest';
import { conversation, expectEveryReplyOnce, mounted } from '../test-support/terminal-emulator.js';
import { setAmbiguousWidth } from './terminal-width.js';

// Its own file: Ink keeps what it measured and cut in a cache for the life of the process, and the
// ruler is set once, before anything is drawn. A process has one ruler; so does a test file.
afterEach(() => {
  mounted.unmount?.();
  setAmbiguousWidth('narrow');
});

describe('the conversation a terminal is left with, on a terminal that draws wide', () => {
  it('has every reply once, however long, when dashes and symbols take two columns', async () => {
    expectEveryReplyOnce(await conversation(76, 30, true));
  });
});
