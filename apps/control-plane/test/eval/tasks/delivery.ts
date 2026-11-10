/**
 * Does a long answer reach the user? Only a call of `reply` is shown; text a model writes
 * without any tool call is discarded (M2Design 3.5). A model that has read a lot and has a long
 * answer to give sometimes writes it as plain text and stops: the user then never sees it. This
 * task asks a question that needs a long answer after several files were read, and judges that
 * the answer was shown and that no message of the model was without a tool call. It runs on the
 * real model (docs/M2/Evaluation.md 7); the prompts and the feedback of the system are what it
 * measures.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Check, Observation, TaskSpec } from '../spec.js';

export const FILES: Readonly<Record<string, string>> = {
  'docs/scheduler.md': [
    '# Scheduler',
    'Jobs are taken from the queue in order of priority, then of age.',
    'A failed job is retried at most 7 times. The wait before retry n is 250 ms times 2 to the',
    'power n minus 1, and never more than 30 seconds. After the seventh failure the job is moved',
    'to the dead-letter queue and an alert named SCHED-DEAD is raised.',
    'Jobs of the same tenant never run at the same time; at most 12 jobs run at once overall.',
  ].join('\n'),
  'docs/cache.md': [
    '# Cache',
    'Entries live for 900 seconds after the last write, not after the last read.',
    'The cache holds at most 4096 entries. When it is full the entry that was read longest ago',
    'is evicted (least recently used). Entries larger than 64 KiB are never cached.',
    'A write to a record removes its entry at once; the next read fills it again.',
    'The counters hit, miss and evict are published every 60 seconds.',
  ].join('\n'),
  'docs/auth.md': [
    '# Auth',
    'A client logs in with a key and gets an access token that is valid for 30 minutes and a',
    'refresh token that is valid for 14 days. The refresh token can be used once: using it',
    'returns a new pair and revokes the old refresh token. Signing keys rotate every 24 hours;',
    'the previous key is still accepted for 1 hour after a rotation. Five failed logins in a',
    'minute lock the key for 15 minutes.',
  ].join('\n'),
  'docs/reports.md': [
    '# Reports',
    'Reports are produced in three formats: csv, json and html. The nightly run starts at 02:30',
    'UTC and takes the data of the previous UTC day. A report that is not finished after 45',
    'minutes is cancelled and retried once. Finished reports are kept for 90 days and are then',
    'deleted; the html format embeds no scripts.',
  ].join('\n'),
  'src/limits.ts': [
    'export const MAX_RETRIES = 7;',
    'export const BACKOFF_BASE_MS = 250;',
    'export const BACKOFF_CAP_MS = 30_000;',
    'export const CACHE_TTL_S = 900;',
    'export const CACHE_MAX_ENTRIES = 4096;',
    'export const ACCESS_TOKEN_MIN = 30;',
    'export const REFRESH_TOKEN_DAYS = 14;',
    'export const REPORT_TIMEOUT_MIN = 45;',
  ].join('\n'),
};

const QUESTION = [
  '请阅读这个仓库的 docs 目录和 src/limits.ts，然后用中文完整、详细地回答下面四个问题。',
  '每个问题单独写一段，每段至少 150 个字，写出具体数字和依据的文件，不要省略细节：',
  '1. 失败的任务怎样重试，重试之间等多久，最后怎么处理？',
  '2. 缓存里的条目何时过期、何时被淘汰、哪些不会被缓存？',
  '3. 令牌的有效期是多久，刷新令牌怎样使用，密钥怎样轮换？',
  '4. 报告有哪些格式，每晚几点运行，超时和保留期各是多少？',
].join('\n');

const check = (name: string, angle: Check['angle'], ok: boolean, detail?: string): Check => ({
  name,
  angle,
  ok,
  ...(ok || detail === undefined ? {} : { detail }),
});

const FACTS = ['250', '4096', '14', '02:30', '90'];

const longAnswer: TaskSpec = {
  id: 'delivery.long-answer',
  mode: 'chat',
  tags: ['chat', 'delivery'],
  description:
    'Several files are read and a long answer is asked for: it is shown, and the model never writes a message without a tool call.',
  fixture: async (repository) => {
    for (const [path, content] of Object.entries(FILES)) {
      await mkdir(join(repository, path, '..'), { recursive: true });
      await writeFile(join(repository, path), `${content}\n`);
    }
  },
  steps: [{ say: QUESTION }],
  judge: (observation: Observation) => {
    const shown = observation.printed('REPLY').join('\n');
    const modelTurns = observation.log.filter((record) => record['type'] === 'MODEL_TURN');
    const withoutCall = modelTurns.filter(
      (record) => ((record['toolCalls'] as unknown[] | undefined) ?? []).length === 0,
    );
    const noAction = observation.log.filter(
      (record) => record['type'] === 'FEEDBACK' && record['code'] === 'NO_ACTION',
    );
    const found = FACTS.filter((fact) => shown.includes(fact));
    return [
      check(
        'a long answer is shown',
        'OUTCOME',
        shown.length >= 800,
        `${String(shown.length)} characters shown`,
      ),
      check(
        'the answer has the facts of the files',
        'OUTCOME',
        found.length >= 4,
        `${String(found.length)} of ${String(FACTS.length)} facts`,
      ),
      check(
        'no message of the model was without a tool call',
        'BEHAVIOR',
        withoutCall.length === 0,
        `${String(withoutCall.length)} messages without a tool call`,
      ),
      check(
        'the system never had to say that there was no tool call',
        'BEHAVIOR',
        noAction.length === 0,
        `${String(noAction.length)} NO_ACTION`,
      ),
    ];
  },
};

export const DELIVERY_TASKS: readonly TaskSpec[] = [longAnswer];
