import { MEDIA_TYPES, type Executor, type RepositoryListInput } from '@multiagentos/contracts';
import { completed, guarded, rejected, violation } from '../outcome/outcomes.js';
import { buildFileSet, type FileDigestCache } from '../repository-access/file-set.js';
import { resolveRepositoryScope } from '../repository-access/repository-scope.js';
import { previewLimitsOf } from '../retention/retention.js';
import { renderListing } from './listing.js';

/** Sees the same file set as the other repository Executors, so exclusions hold (ExecutorSet 5). */
export function createListExecutor(cache: FileDigestCache): Executor<'REPOSITORY_LIST'> {
  return {
    executionKind: 'REPOSITORY_LIST',
    execute: (input: RepositoryListInput, environment) =>
      guarded(async () => {
        const scope = await resolveRepositoryScope(environment.scope);
        if (scope === undefined) return violation('SCOPE_MISSING');
        const built = await buildFileSet(scope, { signal: environment.signal, cache });
        if (!built.ok) return rejected('LIMIT_EXCEEDED');
        const listing = renderListing(
          built.set.files.map((file) => file.path),
          input,
          previewLimitsOf(environment),
        );
        if (listing === undefined) return rejected('NOT_FOUND');
        return completed({
          output: listing.output,
          artifact: { mediaType: MEDIA_TYPES.fileText, text: listing.preview },
          ...(listing.full === undefined ? {} : { fullOutput: { text: listing.full } }),
        });
      }),
  };
}
