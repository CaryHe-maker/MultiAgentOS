/**
 * Does the result of a SubAgent reach the main Agent? A SubAgent ends with `finish_subagent`:
 * a short summary and then the report in full (M2Design 3.7). This task has three explorers
 * each read part of a repository and write a long report, and judges that every one of them
 * ended with a result that was accepted, that no call of `finish_subagent` was refused, that the
 * summary stayed short and the report was written, and that the answer of the main Agent has the
 * facts. It runs on the real model (docs/M2/Evaluation.md 7); the prompts and the shape of the
 * result are what it measures.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Check, Observation, TaskSpec } from '../spec.js';
import { FILES } from './delivery.js';

const QUESTION = [
  '请用 run_subagents 同时启动三个 explorer 子 Agent，各读一部分，然后你汇总成一份中文回答：',
  '甲：读 docs/scheduler.md 和 src/limits.ts，调研任务重试、退避和死信队列。',
  '乙：读 docs/cache.md 和 docs/auth.md，调研缓存的过期与淘汰、令牌与密钥轮换。',
  '丙：读 docs/reports.md 和 src/limits.ts，调研报告的格式、运行时间、超时与保留期。',
  '要求每个子 Agent 的报告写得详细（至少 600 字，逐条写出数字和依据的文件），摘要只写两三句，并在 references 里列出你们读文件的那几次调用的 toolCallId。',
  '汇总之后，请再用 read_output 读取一个子 Agent 交出的工具结果（名字形如 ref_N/toolCallId），核对其中一个数字。',
].join('\n');

const FACTS = ['250', '4096', '14', '02:30', '90'];

const check = (name: string, angle: Check['angle'], ok: boolean, detail?: string): Check => ({
  name,
  angle,
  ok,
  ...(detail === undefined ? {} : { detail }),
});

/** The context packs of the Session by the last line of their registration: how many, and how many were not released. */
async function contextPacks(
  observation: Observation,
): Promise<{ readonly total: number; readonly unreleased: number; readonly bytes: number }> {
  const sessions = join(observation.dataDir, 'sessions');
  const ids = await readdir(sessions).catch(() => [] as string[]);
  const last = new Map<string, { mediaType?: string; releasedAt?: string; size?: number }>();
  for (const id of ids) {
    const text = await readFile(
      join(sessions, id, 'kernel-execution', 'artifact-owners.jsonl'),
      'utf8',
    ).catch(() => '');
    for (const line of text.split('\n').filter(Boolean)) {
      const each = JSON.parse(line) as {
        artifactId: string;
        mediaType?: string;
        releasedAt?: string;
        size?: number;
      };
      last.set(each.artifactId, each);
    }
  }
  const packs = [...last.values()].filter((each) =>
    String(each.mediaType).includes('context-pack'),
  );
  return {
    total: packs.length,
    unreleased: packs.filter((each) => each.releasedAt === undefined).length,
    bytes: packs.reduce((sum, each) => sum + (each.size ?? 0), 0),
  };
}

interface Finish {
  readonly summary?: string;
  readonly report?: string;
}

/** The arguments of every finish_subagent call, read from the model outputs the log points at. */
async function finishCalls(observation: Observation): Promise<readonly Finish[]> {
  const found: Finish[] = [];
  for (const record of observation.log) {
    if (record['type'] !== 'MODEL_TURN') continue;
    const calls = (record['toolCalls'] as { toolName: string; toolCallId: string }[]) ?? [];
    const finishing = calls.find((call) => call.toolName === 'finish_subagent');
    const ref = record['outputRef'] as { artifactId?: string } | undefined;
    if (finishing === undefined || ref?.artifactId === undefined) continue;
    const raw = await readFile(
      join(observation.dataDir, 'artifacts', ref.artifactId.replace(/^art_/u, '')),
      'utf8',
    ).catch(() => undefined);
    if (raw === undefined) continue;
    const output = JSON.parse(raw) as {
      toolCalls: { toolCallId: string; argumentsText: string }[];
    };
    const call = output.toolCalls.find((each) => each.toolCallId === finishing.toolCallId);
    if (call !== undefined) found.push(JSON.parse(call.argumentsText) as Finish);
  }
  return found;
}

const report: TaskSpec = {
  id: 'subagents.report',
  mode: 'chat',
  tags: ['chat', 'subagents'],
  description:
    'Three explorers each write a long report: every result is accepted, the summary is short, the report is written, and the main Agent answers with the facts.',
  fixture: async (repository) => {
    for (const [path, content] of Object.entries(FILES)) {
      await mkdir(join(repository, path, '..'), { recursive: true });
      await writeFile(join(repository, path), `${content}\n`);
    }
  },
  steps: [{ say: QUESTION }],
  judge: async (observation) => {
    const ended = observation.log.filter(
      (record) =>
        record['type'] === 'NODE_ENDED' &&
        (record['result'] as { action?: string } | undefined)?.action === 'FINISH_SUBAGENT',
    );
    const done = ended.filter(
      (record) => (record['result'] as { status?: string }).status === 'DONE',
    );
    const refused = observation.log.filter(
      (record) => record['type'] === 'FEEDBACK' && record['code'] === 'CONTROL_ARGUMENTS_INVALID',
    );
    const finishes = await finishCalls(observation);
    const shown = observation.printed('REPLY').join('\n');
    const found = FACTS.filter((fact) => shown.includes(fact));
    const packs = await contextPacks(observation);
    // A call of read_output by main that named what a task handed over (ref_N/toolCallId) and succeeded.
    const readCalls = observation.log.flatMap((record) =>
      record['type'] === 'MODEL_TURN'
        ? ((record['toolCalls'] as { toolName: string; toolCallId: string }[]) ?? []).filter(
            (call) => call.toolName === 'read_output',
          )
        : [],
    );
    const submittedFor = (id: string) =>
      observation.log.find(
        (record) =>
          record['type'] === 'UNIT_SUBMITTED' &&
          (record['inputSource'] as { toolCallId?: string }).toolCallId === id,
      )?.['requestId'];
    const readOk = readCalls.filter((call) =>
      observation.log.some(
        (record) =>
          record['type'] === 'UNIT_COMPLETED' &&
          record['requestId'] === submittedFor(call.toolCallId) &&
          record['status'] === 'OK',
      ),
    );
    // Of each handover the first item is the result of the task; the others are what it listed.
    const listed = observation.log
      .filter((record) => record['type'] === 'REFERENCES_REGISTERED')
      .map((record) => String(((record['items'] as unknown[]) ?? []).length - 1))
      .join(',');
    return [
      check(
        'three subagents ended with a result that was accepted',
        'OUTCOME',
        done.length >= 3,
        `${String(done.length)} of ${String(ended.length)} ended DONE`,
      ),
      check(
        'no call of finish_subagent was refused',
        'BEHAVIOR',
        refused.length === 0,
        `${String(finishes.length)} calls, ${String(refused.length)} refused: ${refused.map((record) => String(record['message']).slice(0, 80)).join(' | ')}`,
      ),
      check(
        'every summary is short and every report is written',
        'BEHAVIOR',
        finishes.length >= 3 &&
          finishes.every(
            (finish) =>
              (finish.summary?.length ?? 99_999) <= 2000 && (finish.report?.length ?? 0) >= 300,
          ),
        finishes
          .map(
            (finish) =>
              `summary ${String(finish.summary?.length)} report ${String(finish.report?.length)}`,
          )
          .join('; '),
      ),
      check(
        'the tasks passed on tool results, and main read one of them',
        'BEHAVIOR',
        readOk.length >= 1,
        'tool results handed over per task: ' +
          listed +
          '; read_output calls ' +
          String(readCalls.length) +
          ', succeeded ' +
          String(readOk.length),
      ),
      check(
        'every context pack was released when its model call was over',
        'BEHAVIOR',
        packs.total > 0 && packs.unreleased === 0,
        String(packs.total) +
          ' packs of ' +
          String(packs.bytes) +
          ' bytes, ' +
          String(packs.unreleased) +
          ' not released',
      ),
      check(
        'the answer has the facts of the files',
        'OUTCOME',
        found.length >= 4,
        `${String(found.length)} of ${String(FACTS.length)} facts`,
      ),
    ];
  },
};

export const SUBAGENT_TASKS: readonly TaskSpec[] = [report];
