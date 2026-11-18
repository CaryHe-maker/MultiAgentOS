import { Type, type Static } from 'typebox';
import { closed, count } from '../platform-common/schema-helpers.js';

/** How a preview was cut; the Executor words the notice shown to the model. */
export const RetentionNoticeSchema = closed(
  {
    strategy: Type.Enum(['HEAD', 'TAIL', 'BOTH', 'ITEMS']),
    unit: Type.Enum(['BYTES', 'ITEMS']),
    limit: count(),
    retained: count(),
    omitted: count(1),
    /** The full output itself went past `maxFullOutputBytes`. */
    fullOutputTruncated: Type.Boolean(),
  },
  'executor.RetentionNotice.v1',
);
export type RetentionNotice = Static<typeof RetentionNoticeSchema>;
