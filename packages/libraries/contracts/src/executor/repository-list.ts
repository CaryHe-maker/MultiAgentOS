import { Type, type Static } from 'typebox';
import { closed, count, text } from '../platform-common/schema-helpers.js';

/** Also the parameters of the `list_files` tool (ExecutorSet 5). */
export const RepositoryListInputSchema = closed(
  {
    path: Type.Optional(text(1024)),
    depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    glob: Type.Optional(text(256)),
  },
  'executor.RepositoryListInput.v1',
);
export type RepositoryListInput = Static<typeof RepositoryListInputSchema>;

export const RepositoryListOutputSchema = closed(
  {
    path: text(1024),
    directoryCount: count(),
    fileCount: count(),
    omittedEntries: count(),
  },
  'executor.RepositoryListOutput.v1',
);
export type RepositoryListOutput = Static<typeof RepositoryListOutputSchema>;
