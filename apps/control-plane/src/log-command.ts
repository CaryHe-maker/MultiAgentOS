/**
 * `mas log` (docs/M2/Phase1Console.md 3): prints the time line of a Session from its log. It only
 * reads. It starts no module, takes neither the instance lock nor the Session lock, and calls no
 * model, so it works while another `mas` runs: a half-written last line of a live log is left out.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  buildTimeline,
  renderSessionList,
  renderTimeline,
  type MasCommand,
  type ReadText,
  type SessionListItem,
} from '@multiagentos/cli';
import { GlobalArtifactStore } from '@multiagentos/artifacts';
import {
  SessionIndexLineSchema,
  SessionLogRecordSchema,
  validate,
  type SessionIndexLine,
  type SessionLogRecord,
} from '@multiagentos/contracts';

export type LogCommand = Extract<MasCommand, { readonly kind: 'LOG' }>;

export interface LogCommandIo {
  readonly dataDir: string;
  /** The repository the process was started in, as a real path. */
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
}

export const EXIT_CODE_LOG_FAILED = 1;

class LogReadError extends Error {}

/** The complete lines of a JSONL file; a last line without its newline is still being written. */
async function completeLines(file: string): Promise<string[]> {
  let text: string;
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw new LogReadError(`${file} 是符号链接，不读取。`);
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const end = text.lastIndexOf('\n');
  return end < 0 ? [] : text.slice(0, end).split('\n');
}

/** The Sessions of the index, the last line of an id winning, the deleted ones left out. */
async function indexedSessions(dataDir: string): Promise<SessionIndexLine[]> {
  const latest = new Map<string, SessionIndexLine>();
  for (const line of await completeLines(join(dataDir, 'workflow', 'session-index.jsonl'))) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const checked = validate<SessionIndexLine>(SessionIndexLineSchema, value);
    if (checked.ok) latest.set(checked.value.sessionId, checked.value);
  }
  return [...latest.values()].filter((line) => line.status === 'ACTIVE');
}

async function readRecords(dataDir: string, sessionId: string): Promise<SessionLogRecord[]> {
  const file = join(dataDir, 'sessions', sessionId, 'workflow', 'log.v1.jsonl');
  const lines = await completeLines(file);
  if (lines.length === 0) throw new LogReadError('这个对话没有日志。');
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new LogReadError(`日志第 ${String(index + 1)} 行不是有效的 JSON。`);
    }
    const checked = validate<SessionLogRecord>(SessionLogRecordSchema, value);
    if (!checked.ok)
      throw new LogReadError(
        `日志第 ${String(index + 1)} 行无法识别（可能来自更新的版本）：${checked.issues[0] ?? ''}`,
      );
    return checked.value;
  });
}

function textReader(dataDir: string): ReadText {
  const store = new GlobalArtifactStore(dataDir);
  const cache = new Map<string, string | undefined>();
  return async (ref) => {
    if (cache.has(ref.artifactId)) return cache.get(ref.artifactId);
    let text: string | undefined;
    try {
      text = new TextDecoder().decode(await store.get(ref));
    } catch {
      // Expired, swept or damaged: the viewer says so instead of stopping.
      text = undefined;
    }
    cache.set(ref.artifactId, text);
    return text;
  };
}

/** Which Session the command means; a text is the reason when none does. */
function pick(
  command: LogCommand,
  here: readonly SessionIndexLine[],
  everywhere: readonly SessionIndexLine[],
): SessionIndexLine | string {
  const wanted = command.session;
  if (wanted === undefined) return here[0] ?? '本仓库还没有对话。';
  if (/^\d{1,6}$/u.test(wanted))
    return here[Number(wanted) - 1] ?? `列表里没有第 ${wanted} 个对话（mas log --list）。`;
  const exact = everywhere.find((line) => line.sessionId === wanted);
  if (exact !== undefined) return exact;
  const starts = everywhere.filter((line) => line.sessionId.startsWith(wanted));
  if (starts.length === 1 && starts[0] !== undefined) return starts[0];
  return starts.length === 0
    ? `没有这个对话：${wanted}。`
    : `开头为 ${wanted} 的对话不止一个，请多写几位。`;
}

export async function runLogCommand(command: LogCommand, io: LogCommandIo): Promise<number> {
  try {
    const repository = await realpath(resolve(command.repo ?? io.cwd));
    const everywhere = await indexedSessions(io.dataDir);
    const here = everywhere
      .filter((line) => line.repositoryRoot === repository)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    const read = textReader(io.dataDir);

    if (command.list) {
      const items: SessionListItem[] = [];
      for (const line of here) {
        const title = line.titleRef === undefined ? undefined : await read(line.titleRef);
        items.push({
          sessionId: line.sessionId,
          createdAt: line.createdAt,
          lastActiveAt: line.lastActiveAt,
          turnCount: line.turnCount,
          ...(title === undefined ? {} : { title }),
        });
      }
      io.write(renderSessionList(items));
      return 0;
    }

    const chosen = pick(command, here, everywhere);
    if (typeof chosen === 'string') {
      io.writeError(`${chosen}\n`);
      return EXIT_CODE_LOG_FAILED;
    }
    const timeline = await buildTimeline(await readRecords(io.dataDir, chosen.sessionId), read);
    const shown =
      command.turn === undefined
        ? timeline
        : {
            ...timeline,
            turns: timeline.turns.filter((turn) => turn.index === command.turn),
            outside: [],
          };
    if (command.turn !== undefined && shown.turns.length === 0) {
      io.writeError(
        `这个对话没有第 ${String(command.turn)} 轮（共 ${String(timeline.turns.length)} 轮）。\n`,
      );
      return EXIT_CODE_LOG_FAILED;
    }
    io.write(
      command.json
        ? `${JSON.stringify({ sessionId: chosen.sessionId, ...shown }, null, 2)}\n`
        : renderTimeline(shown, { sessionId: chosen.sessionId, full: command.full }),
    );
    return 0;
  } catch (error) {
    io.writeError(`${error instanceof LogReadError ? error.message : '无法读取日志。'}\n`);
    return EXIT_CODE_LOG_FAILED;
  }
}
