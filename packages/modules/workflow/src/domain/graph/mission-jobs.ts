import type { SessionLogRecord } from '@multiagentos/contracts';

/**
 * The background commands of the tasks (Orchestration 6): which a task has, which still run,
 * where a task last read each, and what it is told when one ends. All of it from the log.
 */

type RecordOf<T extends SessionLogRecord['type']> = Extract<SessionLogRecord, { type: T }>;

/** Jobs that may run at once in one run (`maxBackgroundJobs`, Orchestration 6.1). */
export const MAX_BACKGROUND_JOBS = 4;

export interface MissionJob {
  readonly workflowRunId: string;
  readonly missionId: string;
  readonly jobId: string;
  readonly jobKey: string;
  readonly command: string;
  readonly promoted: boolean;
  /** Where the next `job_output` starts. */
  readonly readOffset: number;
  readonly ended?: RecordOf<'JOB_ENDED'>;
  /** Neither ended nor gone with its run: a run that ended stopped its jobs (Orchestration 6.3). */
  readonly running: boolean;
}

const keyOf = (missionId: string, jobId: string): string => `${missionId}/${jobId}`;

/** Every job of the run (of every run without one), in the order they started. */
export function jobsOf(records: readonly SessionLogRecord[], workflowRunId?: string): MissionJob[] {
  const jobs = new Map<string, Omit<MissionJob, 'running'>>();
  const runsEnded = new Set<string>();
  for (const record of records) {
    if (
      workflowRunId !== undefined &&
      (!('workflowRunId' in record) || record.workflowRunId !== workflowRunId)
    )
      continue;
    if (record.type === 'WORKFLOW_RUN_ENDED') runsEnded.add(record.workflowRunId);
    else if (record.type === 'JOB_STARTED')
      jobs.set(keyOf(record.missionId, record.jobId), {
        workflowRunId: record.workflowRunId,
        missionId: record.missionId,
        jobId: record.jobId,
        jobKey: record.jobKey,
        command: record.command,
        promoted: record.promoted,
        readOffset: 0,
      });
    else if (record.type === 'JOB_READ' || record.type === 'JOB_ENDED') {
      const key = keyOf(record.missionId, record.jobId);
      const job = jobs.get(key);
      if (job === undefined) continue;
      jobs.set(
        key,
        record.type === 'JOB_READ'
          ? { ...job, readOffset: record.nextOffset }
          : { ...job, ended: record },
      );
    }
  }
  return [...jobs.values()].map((job) => ({
    ...job,
    running: job.ended === undefined && !runsEnded.has(job.workflowRunId),
  }));
}

/** A task's jobs: the root task of a chat keeps its names across runs. */
export const jobsOfMission = (
  records: readonly SessionLogRecord[],
  missionId: string,
): MissionJob[] => jobsOf(records).filter((job) => job.missionId === missionId);

export const runningJobs = (
  records: readonly SessionLogRecord[],
  workflowRunId?: string,
): MissionJob[] => jobsOf(records, workflowRunId).filter((job) => job.running);

/** The name the next job of a task gets: `job_<n>`, counted per task. */
export const nextJobId = (records: readonly SessionLogRecord[], missionId: string): string =>
  `job_${String(jobsOfMission(records, missionId).length + 1)}`;

/** Which job a Unit's result started, by the request, for the history (Orchestration 6.1). */
export function jobOfRequest(records: readonly SessionLogRecord[]): Map<string, string> {
  const jobs = new Map<string, string>();
  for (const record of records)
    if (record.type === 'JOB_STARTED') jobs.set(record.requestId, record.jobId);
  return jobs;
}

/** How a job ended, in a few words. */
export function exitText(ended: RecordOf<'JOB_ENDED'>): string {
  const { exit } = ended;
  if ('lost' in exit) return 'lost: the process that ran it stopped';
  if (exit.unconfirmed) return 'stopped, but its end could not be confirmed';
  if (exit.timedOut) return 'stopped: it ran as long as a background command may';
  if (exit.stopped) return `stopped${exit.signal === null ? '' : ` (${exit.signal})`}`;
  if (exit.exitCode !== null) return `exited(${String(exit.exitCode)})`;
  return `ended${exit.signal === null ? '' : ` (${exit.signal})`}`;
}

/** The notice of an ended job (Orchestration 6.4): how it ended, and the end of what is unread. */
export function jobEndedNotice(ended: RecordOf<'JOB_ENDED'>, command: string): string {
  const seconds = Math.round(ended.durationMs / 1000);
  const head = `Background command ${ended.jobId} (${command}) has ended [${exitText(ended)}, ${String(seconds)} s].`;
  const unread = Math.max(0, ended.totalBytes - ended.readUpTo);
  if (unread === 0) return `${head} Nothing unread.`;
  const tail = Buffer.from(ended.tail, 'utf8');
  if (unread <= tail.byteLength)
    return `${head} Unread output:\n${tail.subarray(tail.byteLength - unread).toString('utf8')}`;
  return `${head} ${String(unread)} bytes unread; the last of them:\n${ended.tail}\n[read the rest with job_output ${ended.jobId}]`;
}

/** What `job_list` shows: the task's jobs, each with its state. */
export function jobListText(jobs: readonly MissionJob[]): string {
  if (jobs.length === 0) return 'You have no background commands.';
  return jobs
    .map((job) => {
      const state =
        job.ended !== undefined
          ? exitText(job.ended)
          : job.running
            ? 'running'
            : 'stopped with its run';
      return `- ${job.jobId}: ${job.command} — ${state}`;
    })
    .join('\n');
}
