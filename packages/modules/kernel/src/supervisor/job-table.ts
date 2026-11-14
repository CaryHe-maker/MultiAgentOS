import {
  JOB_READ_MAX_BYTES,
  JOB_TAIL_BYTES,
  type DetachedExit,
  type DetachedProcess,
  type JobControlRequest,
  type JobControlResult,
  type JobEndedFact,
  type JobExit,
} from '@multiagentos/contracts';

/**
 * The commands that run on after their execution ended (Orchestration 6.1, 6.3): background
 * commands, and commands moved to the background at their timeout. A job keeps the end of what it
 * printed for reading, runs at most `jobMaxMs`, ends with its run, and says when it has ended.
 */
export interface JobTableDeps {
  readonly report: (fact: JobEndedFact) => Promise<void>;
  /** The longest a job runs before it is stopped (`jobMaxSeconds`). */
  readonly jobMaxMs: number;
  /** What a job keeps of its output for reading; older bytes are dropped. */
  readonly keepBytes?: number;
  readonly now?: () => number;
  readonly schedule?: (ms: number, run: () => void) => () => void;
}

interface Job {
  readonly jobKey: string;
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly process: DetachedProcess;
  readonly startedAt: number;
  readonly chunks: Buffer[];
  /** Bytes dropped from the front of what it printed. */
  dropped: number;
  kept: number;
  timedOut: boolean;
  exit?: JobExit;
  cancelTimer: () => void;
}

const DEFAULT_KEEP_BYTES = 4 * 1024 * 1024;
/** Ended jobs stay readable; the oldest go once there are more than this. */
const MAX_ENDED = 64;

export class JobTable {
  readonly #deps: JobTableDeps;
  readonly #jobs = new Map<string, Job>();
  readonly #keep: number;
  readonly #now: () => number;
  readonly #schedule: (ms: number, run: () => void) => () => void;

  public constructor(deps: JobTableDeps) {
    this.#deps = deps;
    this.#keep = deps.keepBytes ?? DEFAULT_KEEP_BYTES;
    this.#now = deps.now ?? Date.now;
    this.#schedule =
      deps.schedule ??
      ((ms, run) => {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }

  /** Takes a detached command over, with what it printed before it detached. */
  adopt(
    owner: { readonly jobKey: string; readonly sessionId: string; readonly workflowRunId: string },
    process: DetachedProcess,
    printed: string,
  ): void {
    const job: Job = {
      ...owner,
      process,
      startedAt: this.#now(),
      chunks: [],
      dropped: 0,
      kept: 0,
      timedOut: false,
      cancelTimer: () => undefined,
    };
    this.#jobs.set(owner.jobKey, job);
    if (printed !== '') this.#append(job, Buffer.from(printed, 'utf8'));
    job.cancelTimer = this.#schedule(this.#deps.jobMaxMs, () => {
      if (job.exit !== undefined) return;
      job.timedOut = true;
      job.process.stop();
    });
    process.onOutput((chunk) => this.#append(job, chunk));
    process.onExit((exit) => this.#ended(job, exit));
  }

  control(request: JobControlRequest): JobControlResult {
    const job = this.#jobs.get(request.jobKey);
    if (job?.workflowRunId !== request.workflowRunId) return { found: false };
    if (request.action === 'STOP' && job.exit === undefined) job.process.stop();
    const total = job.dropped + job.kept;
    const asked = request.action === 'READ' ? (request.offset ?? 0) : total;
    const from = Math.min(Math.max(asked, job.dropped), total);
    const all = Buffer.concat(job.chunks);
    const max = request.maxBytes ?? JOB_READ_MAX_BYTES;
    const slice = all.subarray(from - job.dropped, from - job.dropped + max);
    return {
      found: true,
      text: slice.toString('utf8'),
      offset: from,
      nextOffset: from + slice.byteLength,
      skipped: Math.max(0, from - asked),
      totalBytes: total,
      ...(job.exit === undefined ? {} : { exit: job.exit }),
    };
  }

  /** The run has ended or was aborted: its jobs stop (Orchestration 6.3). */
  stopRun(workflowRunId: string): void {
    for (const job of this.#jobs.values())
      if (job.workflowRunId === workflowRunId && job.exit === undefined) job.process.stop();
  }

  running(): number {
    return [...this.#jobs.values()].filter((job) => job.exit === undefined).length;
  }

  #append(job: Job, chunk: Buffer): void {
    job.chunks.push(chunk);
    job.kept += chunk.byteLength;
    while (job.kept > this.#keep && job.chunks.length > 0) {
      const first = job.chunks[0]!;
      const over = job.kept - this.#keep;
      if (first.byteLength <= over) {
        job.chunks.shift();
        job.kept -= first.byteLength;
        job.dropped += first.byteLength;
      } else {
        job.chunks[0] = first.subarray(over);
        job.kept -= over;
        job.dropped += over;
      }
    }
  }

  #ended(job: Job, exit: DetachedExit): void {
    if (job.exit !== undefined) return;
    job.cancelTimer();
    job.exit = { ...exit, timedOut: job.timedOut };
    const all = Buffer.concat(job.chunks);
    const tail = all.subarray(Math.max(0, all.byteLength - JOB_TAIL_BYTES)).toString('utf8');
    this.#forgetOld();
    void this.#deps
      .report({
        sessionId: job.sessionId,
        workflowRunId: job.workflowRunId,
        jobKey: job.jobKey,
        exit: job.exit,
        durationMs: Math.max(0, this.#now() - job.startedAt),
        totalBytes: job.dropped + job.kept,
        tail,
      })
      .catch(() => undefined);
  }

  #forgetOld(): void {
    const ended = [...this.#jobs.values()].filter((job) => job.exit !== undefined);
    for (const job of ended.slice(0, Math.max(0, ended.length - MAX_ENDED)))
      this.#jobs.delete(job.jobKey);
  }
}
