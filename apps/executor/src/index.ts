import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ArtifactRef,
  BoundaryContext,
  ModuleError,
  UnitIntent,
  UnitResult,
} from '@multiagentos/contracts';
import { unsupported } from '@multiagentos/contracts';

export interface ExecutorArtifactSink {
  put(content: Uint8Array, mediaType: string): Promise<ArtifactRef>;
}
export interface LocalReadExecutorOptions {
  readonly maxOutputBytes: number;
}
const defaults: LocalReadExecutorOptions = { maxOutputBytes: 1_000_000 };
type FileReadInput = { readonly path: string };
const attemptId = (): string => `una_${randomUUID().replaceAll('-', '')}`;

export class LocalReadExecutor {
  public constructor(
    private readonly artifacts: ExecutorArtifactSink,
    private readonly options: LocalReadExecutorOptions = defaults,
  ) {}
  async execute(intent: UnitIntent, context: BoundaryContext): Promise<UnitResult> {
    const started = Date.now();
    if (intent.executionKind !== 'FILE_READ') {
      return this.#failed(
        intent,
        unsupported(
          `executor.${intent.executionKind.toLowerCase()}`,
          'kernel.unit.UnitIntent.v0',
          context.correlationId,
        ),
        started,
      );
    }
    try {
      const input = this.#fileReadInput(intent.input);
      const path = await this.#safePath(intent, input.path);
      const remainingMs = Math.min(intent.timeoutMs, Date.parse(intent.deadline) - Date.now());
      if (remainingMs <= 0) throw new ExecutorFailure('UNIT_DEADLINE_EXCEEDED', 'TIMEOUT');
      const file = await stat(path);
      if (!file.isFile()) throw new ExecutorFailure('FILE_READ_NOT_FILE', 'VALIDATION');
      if (file.size > this.options.maxOutputBytes)
        throw new ExecutorFailure('FILE_READ_OUTPUT_LIMIT', 'RESOURCE');
      const content = await readFile(path, {
        encoding: 'utf8',
        signal: AbortSignal.timeout(remainingMs),
      });
      const output = JSON.stringify({ path: input.path, content });
      if (Buffer.byteLength(output) > this.options.maxOutputBytes)
        throw new ExecutorFailure('FILE_READ_OUTPUT_LIMIT', 'RESOURCE');
      const outputRef = await this.artifacts.put(
        Buffer.from(output),
        'application/vnd.multiagentos.file-read+json',
      );
      return Object.freeze({
        schemaVersion: 'v0',
        unitIntentId: intent.unitIntentId,
        unitAttemptId: attemptId(),
        status: 'SUCCEEDED',
        outputRef,
        evidenceRefs: [outputRef],
        usage: { inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started },
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      return this.#failed(intent, this.#toFailure(error, context.correlationId), started);
    }
  }
  #fileReadInput(value: unknown): FileReadInput {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as FileReadInput).path !== 'string'
    )
      throw new ExecutorFailure('INVALID_FILE_READ_INPUT', 'VALIDATION');
    return value as FileReadInput;
  }
  async #safePath(intent: UnitIntent, requested: string): Promise<string> {
    if (isAbsolute(requested) || requested.split(/[\\/]/u).includes('..'))
      throw new ExecutorFailure('PATH_OUTSIDE_WORKSPACE', 'POLICY');
    const root = await realpath(intent.workspace.rootPath);
    const target = resolve(root, requested);
    const targetStats = await lstat(target);
    if (targetStats.isSymbolicLink()) throw new ExecutorFailure('PATH_OUTSIDE_WORKSPACE', 'POLICY');
    const canonical = await realpath(target);
    if (
      (canonical !== root && !canonical.startsWith(`${root}${sep}`)) ||
      relative(root, canonical).startsWith('..')
    )
      throw new ExecutorFailure('PATH_OUTSIDE_WORKSPACE', 'POLICY');
    return canonical;
  }
  #toFailure(error: unknown, correlationId: string): ModuleError {
    if (error instanceof ExecutorFailure)
      return {
        code: error.code,
        category: error.category,
        message: error.code,
        retryable: false,
        correlationId,
      };
    if (error instanceof Error && error.name === 'TimeoutError')
      return {
        code: 'FILE_READ_TIMEOUT',
        category: 'TIMEOUT',
        message: 'FILE_READ_TIMEOUT',
        retryable: false,
        correlationId,
      };
    return {
      code: 'FILE_READ_FAILED',
      category: 'EXECUTION',
      message: 'FILE_READ_FAILED',
      retryable: false,
      correlationId,
    };
  }
  #failed(intent: UnitIntent, error: ModuleError, started: number): UnitResult {
    return Object.freeze({
      schemaVersion: 'v0',
      unitIntentId: intent.unitIntentId,
      unitAttemptId: attemptId(),
      status: error.category === 'TIMEOUT' ? 'TIMED_OUT' : 'FAILED',
      evidenceRefs: [],
      usage: { inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started },
      error,
      completedAt: new Date().toISOString(),
    });
  }
}

class ExecutorFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly category: ModuleError['category'],
  ) {
    super(code);
  }
}
