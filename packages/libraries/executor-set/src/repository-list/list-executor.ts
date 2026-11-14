import {
  MEDIA_TYPES,
  normalizeRequestPath,
  type Executor,
  type RepositoryListInput,
} from '@multiagentos/contracts';
import { completed, guarded, rejected, violation } from '../outcome/outcomes.js';
import { buildFileSet, type FileDigestCache } from '../repository-access/file-set.js';
import {
  isWithinScope,
  resolveRepositoryScope,
  shownPath,
} from '../repository-access/repository-scope.js';
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
        // An external call stays below the path it was allowed for.
        const base = normalizeRequestPath(input.path ?? '.');
        if (
          scope.external !== undefined &&
          (base === undefined || !isWithinScope(scope, base === '.' ? '' : base))
        )
          return rejected('NOT_FOUND');
        const built = await buildFileSet(scope, { signal: environment.signal, cache });
        const listing = renderListing(
          built.files.map((file) => file.path),
          input,
          previewLimitsOf(environment),
        );
        if (listing === undefined) return rejected('NOT_FOUND');
        // An external listing says where it is, in full, since its paths are read from there.
        const output =
          scope.external === undefined
            ? listing.output
            : {
                ...listing.output,
                path: shownPath(scope, listing.output.path === '.' ? '' : listing.output.path),
              };
        const preview =
          scope.external === undefined ? listing.preview : `${output.path}/\n${listing.preview}`;
        return completed({
          output,
          artifact: { mediaType: MEDIA_TYPES.fileText, text: preview },
          ...(listing.full === undefined ? {} : { fullOutput: { text: listing.full } }),
        });
      }),
  };
}
