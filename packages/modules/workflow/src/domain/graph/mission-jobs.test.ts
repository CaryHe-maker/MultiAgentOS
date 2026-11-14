import type { SessionLogRecord } from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import {
  jobEndedNotice,
  jobListText,
  jobOfRequest,
  jobsOf,
  jobsOfMission,
  nextJobId,
  runningJobs,
} from './mission-jobs.js';

const at = '2026-11-12T00:00:00.000Z';
let seq = 0;
const record = (body: object, workflowRunId = 'wfr_a'): SessionLogRecord =>
  ({ at, workflowRunId, turnId: 'trn_a', seq: (seq += 1), ...body }) as SessionLogRecord;
const started = (missionId: string, jobId: string, jobKey: string, workflowRunId = 'wfr_a') =>
  record(
    {
      type: 'JOB_STARTED',
      missionId,
      jobId,
      jobKey,
      requestId: `req_${jobKey}`,
      command: `run ${jobId}`,
      promoted: false,
    },
    workflowRunId,
  );
const ended = (missionId: string, jobId: string, over: object = {}) =>
  record({
    type: 'JOB_ENDED',
    missionId,
    jobId,
    exit: { exitCode: 0, signal: null, stopped: false, timedOut: false, unconfirmed: false },
    durationMs: 12_400,
    totalBytes: 10,
    readUpTo: 0,
    tail: '0123456789',
    ...over,
  });

describe('the background commands of a task, from the log (Orchestration 6)', () => {
  it('names jobs per task, keeps where each was read, and knows which still run', () => {
    const records = [
      started('msc_root', 'job_1', 'exe_a'),
      started('msc_child', 'job_1', 'exe_b'),
      record({ type: 'JOB_READ', missionId: 'msc_root', jobId: 'job_1', nextOffset: 42 }),
      ended('msc_child', 'job_1'),
    ];
    expect(nextJobId(records, 'msc_root')).toBe('job_2');
    expect(nextJobId(records, 'msc_other')).toBe('job_1');
    const [root] = jobsOfMission(records, 'msc_root');
    expect(root).toMatchObject({ jobKey: 'exe_a', readOffset: 42, running: true });
    expect(runningJobs(records).map((job) => job.jobKey)).toEqual(['exe_a']);
    expect(jobOfRequest(records).get('req_exe_b')).toBe('job_1');
  });

  it('counts a job of a run that ended as no longer running', () => {
    const records = [
      started('msc_root', 'job_1', 'exe_old', 'wfr_old'),
      record({ type: 'WORKFLOW_RUN_ENDED', outcome: 'SUCCEEDED' }, 'wfr_old'),
      started('msc_root', 'job_2', 'exe_new', 'wfr_new'),
    ];
    expect(runningJobs(records).map((job) => job.jobId)).toEqual(['job_2']);
    expect(jobsOf(records, 'wfr_new')).toHaveLength(1);
    expect(jobListText(jobsOfMission(records, 'msc_root'))).toBe(
      '- job_1: run job_1 — stopped with its run\n- job_2: run job_2 — running',
    );
  });

  it('tells how a job ended and shows only what was not read yet', () => {
    expect(jobEndedNotice(ended('m', 'job_3', { readUpTo: 6 }) as never, 'npm test')).toBe(
      'Background command job_3 (npm test) has ended [exited(0), 12 s]. Unread output:\n6789',
    );
    expect(jobEndedNotice(ended('m', 'job_3', { readUpTo: 10 }) as never, 'x')).toContain(
      'Nothing unread.',
    );
    const long = jobEndedNotice(
      ended('m', 'job_4', {
        totalBytes: 5000,
        exit: {
          exitCode: null,
          signal: 'SIGTERM',
          stopped: true,
          timedOut: false,
          unconfirmed: false,
        },
      }) as never,
      'serve',
    );
    expect(long).toContain('[stopped (SIGTERM), 12 s]');
    expect(long).toContain('5000 bytes unread');
    expect(long).toContain('job_output job_4');
  });
});
