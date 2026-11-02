import {
  MEDIA_TYPES,
  SearchContextPackSchema,
  validate,
  type Executor,
  type ExecutorEnvironment,
  type ExecutorEnvironmentV1,
  type ExecutorOutcome,
  type ExecutorOutcomeV1,
  type ExecutorV1,
  type RepositoryListInput,
  type SearchContextPack,
} from '@multiagentos/contracts';
import { completed, guarded, rejected, violation } from '../outcome/outcomes.js';
import { buildFileSet, type FileDigestCache } from '../repository-access/file-set.js';
import { resolveRepositoryScope } from '../repository-access/repository-scope.js';
import { renderListing } from '../repository-list/listing.js';
import { retainItems, type PreviewLimits } from '../retention/retention.js';
import { numberLines, parseText } from '../text/text-document.js';

type ToolLimits = Extract<ExecutorEnvironmentV1['limits'], { preview: unknown }>;

function previewLimits(environment: ExecutorEnvironmentV1): PreviewLimits {
  const { limits } = environment;
  if (!('preview' in limits)) throw new Error('A tool Executor needs preview limits');
  return limits.preview;
}

/** Runs an M1 Executor up to the size of the full output; the preview is cut from that. */
function inner(environment: ExecutorEnvironmentV1, maxOutputBytes: number): ExecutorEnvironment {
  const { limits } = environment;
  const { deadline } = limits;
  return {
    ...environment,
    limits:
      'maxFiles' in limits
        ? { deadline, maxOutputBytes, maxFiles: limits.maxFiles }
        : { deadline, maxOutputBytes },
  };
}

const passThrough = (outcome: Exclude<ExecutorOutcome, { outcome: 'COMPLETED' }>) => outcome;

/** Its pack is a structure later calls read, not text for the model, and has a token budget. */
export function createOrientExecutorV1(
  executor: Executor<'REPOSITORY_ORIENT'>,
): ExecutorV1<'REPOSITORY_ORIENT'> {
  return {
    executionKind: 'REPOSITORY_ORIENT',
    execute: async (input, environment) => {
      const outcome = await executor.execute(
        input,
        inner(environment, environment.limits.maxOutputBytes),
      );
      return outcome.outcome === 'COMPLETED'
        ? ({ outcome: 'COMPLETED', result: outcome.result } as ExecutorOutcomeV1)
        : passThrough(outcome);
    },
  };
}

/** Numbered lines take room the raw text does not: at most 400 lines of 8 bytes, and the header. */
const FILE_RENDERING_BYTES = 4096;

export function createFileReadExecutorV1(executor: Executor<'FILE_READ'>): ExecutorV1<'FILE_READ'> {
  return {
    executionKind: 'FILE_READ',
    execute: async (input, environment) => {
      const room = Math.max(1, previewLimits(environment).maxBytes - FILE_RENDERING_BYTES);
      const outcome = await executor.execute(input, inner(environment, room));
      if (outcome.outcome !== 'COMPLETED') return passThrough(outcome);
      const { output, artifact } = outcome.result;
      if (!('startLine' in output)) throw new Error('FILE_READ gave another output');
      const { path, startLine, endLine, totalLines } = output;
      const rest =
        endLine < totalLines
          ? `\n[Lines ${String(endLine + 1)}-${String(totalLines)} not shown; call read_file with startLine ${String(endLine + 1)} to continue.]`
          : '';
      const text =
        totalLines === 0
          ? `${path} (empty file)`
          : `${path} (lines ${String(startLine)}-${String(endLine)} of ${String(totalLines)})\n${numberLines(parseText(artifact.text).lines, startLine)}${rest}`;
      return {
        outcome: 'COMPLETED',
        result: { output, artifact: { mediaType: MEDIA_TYPES.fileText, text } },
      };
    },
  };
}

const parsedPack = (text: string): SearchContextPack | undefined => {
  try {
    const parsed = validate<SearchContextPack>(SearchContextPackSchema, JSON.parse(text));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
};

export function createSearchExecutorV1(
  executor: Executor<'REPOSITORY_SEARCH'>,
): ExecutorV1<'REPOSITORY_SEARCH'> {
  return {
    executionKind: 'REPOSITORY_SEARCH',
    execute: async (input, environment) => {
      const { limits } = environment;
      const full =
        'maxFullOutputBytes' in limits ? limits.maxFullOutputBytes : limits.maxOutputBytes;
      const outcome = await executor.execute(input, inner(environment, full));
      if (outcome.outcome !== 'COMPLETED') return passThrough(outcome);
      const { output, artifact } = outcome.result;
      if (!('hits' in output)) throw new Error('REPOSITORY_SEARCH gave another output');
      const items = parsedPack(artifact.text)?.items.map((item) => item.content) ?? [];
      const mediaType = MEDIA_TYPES.fileText;
      if (items.length === 0)
        return {
          outcome: 'COMPLETED',
          result: {
            output,
            artifact: {
              mediaType,
              text: 'No matches. Try a shorter or different query, another mode (TEXT, PATH or SYMBOL), or a name you saw in a file.',
            },
          },
        };
      const retained = retainItems(items, previewLimits(environment));
      const header = `${String(items.length)} matches:\n\n`;
      const more = output.truncated
        ? '\n[More matches exist; refine the query or use read_file on the most relevant files.]'
        : '';
      const whole = `${header}${items.join('\n\n')}${more}`;
      if (retained.omittedItems === 0)
        return { outcome: 'COMPLETED', result: { output, artifact: { mediaType, text: whole } } };
      const notice = `\n[${String(retained.omittedItems)} more matches omitted; narrow the query. The full output is kept for 7 days.]`;
      return {
        outcome: 'COMPLETED',
        result: {
          output,
          artifact: { mediaType, text: `${header}${retained.kept.join('\n\n')}${notice}` },
          fullOutput: { text: whole },
        },
      };
    },
  };
}

/** Sees the same file set as the other repository Executors, so exclusions hold (ExecutorSet 5). */
export function createListExecutorV1(cache: FileDigestCache): ExecutorV1<'REPOSITORY_LIST'> {
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
          previewLimits(environment),
        );
        if (listing === undefined) return rejected('NOT_FOUND');
        return completed({
          output: listing.output,
          artifact: { mediaType: MEDIA_TYPES.fileText, text: listing.preview },
          ...(listing.full === undefined ? {} : { fullOutput: { text: listing.full } }),
        } as unknown as Parameters<typeof completed>[0]);
      }) as unknown as Promise<ExecutorOutcomeV1>,
  };
}

export type { ToolLimits };
