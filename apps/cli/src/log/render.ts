/**
 * Draws a Session time line as text for a terminal (docs/M2/Phase1Console.md 3). Every body that
 * comes from outside the system (what the model thought and said, tool results, web pages that
 * a result quotes) is cleaned of control characters first: it goes to a terminal, and an escape
 * sequence in it could rewrite the screen.
 */
import type { EntryView, InputView, SessionTimeline } from './timeline.js';

export interface RenderOptions {
  readonly sessionId?: string;
  /** Whole bodies instead of the first lines. */
  readonly full: boolean;
}

export interface SessionListItem {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly inputCount: number;
  readonly title?: string;
}

/**
 * Controls that can drive a terminal: C0 other than tab and line feed, DEL, C1, and the
 * characters that reorder text. Checked by code point; a regular expression for them trips lint.
 */
function unsafe(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}
const PREVIEW_LINES = 3;
const PREVIEW_LINE_CHARS = 160;
const PREVIEW_CHARS = 400;

/** Text safe to write to a terminal: no control characters other than line breaks and tabs. */
export function plain(text: string): string {
  let clean = '';
  for (const character of text.replace(/\r\n?/gu, '\n'))
    if (!unsafe(character.codePointAt(0) ?? 0)) clean += character;
  return clean;
}

/** The first lines of a body, with how much was left out. */
export function clip(text: string, full: boolean): string {
  const clean = plain(text).trimEnd();
  if (full) return clean;
  const lines = clean.split('\n');
  let shown = lines
    .slice(0, PREVIEW_LINES)
    .map((line) =>
      line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…` : line,
    )
    .join('\n');
  if (shown.length > PREVIEW_CHARS) shown = `${shown.slice(0, PREVIEW_CHARS)}…`;
  return shown.length < clean.length
    ? `${shown}\n…（共 ${String(clean.length)} 字，加 --full 看全文）`
    : shown;
}

const two = (value: number): string => String(value).padStart(2, '0');

function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function dateTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${String(Math.floor(seconds / 60))}m${two(Math.round(seconds % 60))}s`;
}

const number = (value: number): string => value.toLocaleString('en-US');

const INDENT = '          ';
const labelled = (label: string, body: string): string => {
  const [first = '', ...rest] = body.split('\n');
  return [`${INDENT}${label}：${first}`, ...rest.map((line) => `${INDENT}  ${line}`)].join('\n');
};

function renderEntry(entry: EntryView, options: RenderOptions): string {
  const head = `${clock(entry.at)}  `;
  switch (entry.kind) {
    case 'MODEL': {
      const parts = [
        `模型 ${plain(entry.agent)}`,
        ...(entry.durationMs === undefined ? [] : [duration(entry.durationMs)]),
        ...(entry.usage === undefined
          ? []
          : [
              `输入 ${number(entry.usage.inputTokens)}${
                entry.usage.inputCacheHitTokens === undefined
                  ? ''
                  : `（命中 ${number(entry.usage.inputCacheHitTokens)}）`
              } 输出 ${number(entry.usage.outputTokens)}`,
            ]),
        ...(entry.context === undefined
          ? []
          : [`上下文 ${number(entry.context.tokens)}/${number(entry.context.budget)}`]),
      ];
      const lines = [head + parts.join('  ')];
      if (entry.reasoning !== undefined)
        lines.push(labelled('思考', clip(entry.reasoning, options.full)));
      else if (entry.reasoningMissing) lines.push(`${INDENT}思考：（内容已过期或缺失）`);
      if (entry.text !== undefined && entry.text.length > 0)
        lines.push(labelled('回复', clip(entry.text, options.full)));
      for (const call of entry.toolCalls)
        lines.push(
          labelled(
            '调用',
            `${plain(call.toolName)} ${call.args === undefined ? '（参数已过期或缺失）' : clip(call.args, options.full)}`,
          ),
        );
      return lines.join('\n');
    }
    case 'TOOL': {
      const outcome =
        entry.status === 'OK'
          ? 'OK'
          : `${entry.status}${entry.reasonCode === undefined ? '' : `（${entry.reasonCode}）`}`;
      const first = `${head}工具 ${plain(entry.toolName)}  ${outcome}${
        entry.durationMs === undefined ? '' : `  ${duration(entry.durationMs)}`
      }`;
      const body =
        entry.output === undefined
          ? `${INDENT}结果：（内容已过期或缺失）`
          : labelled('结果', clip(entry.output, options.full));
      return [
        first,
        body,
        ...(entry.cut ? [`${INDENT}（预览已截断，完整输出 7 天内可由模型读取）`] : []),
      ].join('\n');
    }
    case 'AUTHORIZATION': {
      const answer =
        entry.resolution === undefined
          ? '没有回答'
          : { GRANTED: '允许', DECLINED: '拒绝', CANCELLED: '取消' }[entry.resolution];
      return `${head}授权 ${plain(entry.capability)}：${answer}`;
    }
    case 'HUMAN': {
      const who = { QUESTION: '问你', ANSWER: '你回答', STEER: '你插话' }[entry.role];
      const first = `${head}${who}（${entry.askKind}）`;
      return entry.text === undefined
        ? first
        : `${first}\n${labelled('内容', clip(entry.text, options.full))}`;
    }
    case 'EVENT':
      return `${head}· ${entry.label}${entry.detail === undefined ? '' : `：${plain(entry.detail)}`}`;
  }
}

function renderInput(turn: InputView, options: RenderOptions): string {
  const span =
    turn.endedAt === undefined
      ? '（没有结束记录）'
      : `→ ${clock(turn.endedAt)}（${duration(Math.max(0, Date.parse(turn.endedAt) - Date.parse(turn.startedAt)))}）· 结束：${turn.endReason ?? '未知'}`;
  const lines = [`━━ 第 ${String(turn.index)} 次输入  ${clock(turn.startedAt)} ${span}`];
  for (const text of turn.user)
    lines.push(text === undefined ? '你：（内容已过期或缺失）' : `你：${clip(text, options.full)}`);
  for (const entry of turn.entries) lines.push(renderEntry(entry, options));
  return lines.join('\n');
}

export function renderTimeline(timeline: SessionTimeline, options: RenderOptions): string {
  const { totals } = timeline;
  const lines = [
    `对话 ${options.sessionId ?? ''}`.trimEnd(),
    [
      ...(timeline.repositoryRoot === undefined ? [] : [`仓库：${plain(timeline.repositoryRoot)}`]),
      ...(timeline.startedAt === undefined ? [] : [`开始：${dateTime(timeline.startedAt)}`]),
      ...(timeline.sandbox === undefined ? [] : [`沙盒：${timeline.sandbox}`]),
    ].join('   '),
    `${String(timeline.inputs.length)} 次输入 · ${String(totals.modelCalls)} 次模型调用 · ${String(totals.toolCalls)} 次工具调用 · 输入 ${number(totals.inputTokens)}（命中 ${number(totals.cacheHitTokens)}）· 输出 ${number(totals.outputTokens)}`,
  ].filter((line) => line.length > 0);
  const body = [
    ...timeline.inputs.map((turn) => renderInput(turn, options)),
    ...(timeline.outside.length === 0
      ? []
      : [
          [
            '━━ 不属于任何一次输入',
            ...timeline.outside.map((entry) => renderEntry(entry, options)),
          ].join('\n'),
        ]),
  ];
  return `${[lines.join('\n'), ...body].join('\n\n')}\n`;
}

export function renderSessionList(items: readonly SessionListItem[]): string {
  if (items.length === 0) return '本仓库还没有对话。\n';
  return `${[
    '本仓库的对话（mas log <编号> 查看）：',
    ...items.map(
      (item, index) =>
        `  ${String(index + 1)}. ${dateTime(item.lastActiveAt)}  ${String(item.inputCount)} 次输入  ${
          item.title === undefined ? '（无标题）' : (clip(item.title, false).split('\n')[0] ?? '')
        }  ${item.sessionId}`,
    ),
  ].join('\n')}\n`;
}
