import { afterAll } from 'vitest';
import { inputBoxAgreesWithInk } from '../test-support/input-box-check.js';
import { setAmbiguousWidth } from './terminal-width.js';

// Its own file, as the ruler is one for a process: what Ink measured is kept for the life of it.
setAmbiguousWidth('wide');
afterAll(() => setAmbiguousWidth('narrow'));

inputBoxAgreesWithInk();
