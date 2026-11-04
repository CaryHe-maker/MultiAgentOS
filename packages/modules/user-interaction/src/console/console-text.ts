import type { ActivityEvent, CloseReason, SessionFailed } from '@multiagentos/contracts';

const DEGRADED: Readonly<Record<string, string>> = {
  BUDGET_EXHAUSTED: '额度已用完，没能完成回复。',
  BUDGET_WRAP_UP: '额度接近用完，没能完成回复。',
  TOOL_UNIT_LIMIT: '工具调用次数已到上限，没能完成回复。',
  WALL_CLOCK_LIMIT: '运行时间已到上限，没能完成回复。',
  ROUND_LIMIT: '轮次已到上限，没能完成回复。',
  NO_PROGRESS: '连续几轮没有进展，没能完成回复。',
  REPEATED_INTENT: '同一个调用重复太多次，没能完成回复。',
  CONSECUTIVE_ERRORS: '工具连续出错，没能完成回复。',
  CONTEXT_LIMIT: '上下文太长，没能完成回复；可以用 /new 开始新对话。',
  REGENERATION_LIMIT: '模型的回复连续不合要求，没能完成回复。',
};

const RUN_STATE: Readonly<Record<string, string>> = {
  RUNNING: '运行中',
  AWAITING_INPUT: '等待输入',
  CONVERGING: '正在结束',
  CLOSED: '已结束',
  NONE: '未开始',
};

/** The words of the console; the logic never builds user text itself (M1 InteractionMessages). */
export const ConsoleText = Object.freeze({
  welcome: '新对话。输入问题后按 Enter 开始；/help 查看指令。',
  recentSessions: '本仓库最近的对话（/resume <编号> 打开）：',
  noSessions: '本仓库还没有对话。',
  sessionLine: (index: number, title: string, turns: number) =>
    `  ${String(index)}. ${title}（${String(turns)} 轮）`,
  untitled: '（无标题）',
  sessionOpened: (title: string, turns: number) => `已打开：${title}（${String(turns)} 轮）`,
  sessionFailed: {
    SESSION_LOCKED: '这个对话正被另一个进程打开。',
    SESSION_LOG_CORRUPT: '这个对话的记录已损坏，无法打开。',
    SESSION_FORMAT_UNSUPPORTED: '这个对话的记录格式不受支持。',
    SESSION_STORAGE_FAILED: '对话记录无法写入。',
  } satisfies Record<SessionFailed['code'], string>,
  sessionDeleted: (ok: boolean) => (ok ? '已删除。' : '已删除，但部分记录未能清理。'),
  repoRead: (path: string, provider: string, exclusions: number) =>
    `允许读取仓库 ${path} 吗？读取的内容会发送至 ${provider}；${String(exclusions)} 条排除规则内的文件不会读取。[y/n]`,
  instructions: (path: string, truncated: boolean, text: string) =>
    `是否信任这份 ${path}？信任后它作为项目指令交给 Agent；不信任则只作为仓库材料。${truncated ? '（只展示开头）' : ''}\n${text}\n[y/n]`,
  granted: '已允许。',
  declined: '已拒绝。',
  continueAfterBudget: '本次运行的额度已用完。要在这个对话中继续吗？[y/n]',
  queued: (count: number) => `已排队 ${String(count)} 条`,
  pressAgain: '再按一次 Ctrl+C 退出',
  truncated: (index: number) => `输出已截断（/output ${String(index)} 查看完整输出）`,
  fullOutputExpired: '完整输出已在 7 天后删除。',
  notNow: '当前不能使用这条指令。',
  unknownCommand: (name: string) => `没有这条指令：${name}。/help 查看指令。`,
  help: [
    '/new              开始新对话',
    '/sessions         列出本仓库的对话',
    '/resume <编号>    打开对话',
    '/delete <编号>    删除未打开的对话',
    '/status           当前运行与额度状态',
    '/output <编号>    查看被截断的工具输出',
    '/exit             退出',
    'Enter 发送，\\ 加 Enter 换行，Esc 清空，↑/↓ 浏览历史；运行中发送的消息会排队。',
  ].join('\n'),
  status: (state: string, budget: string) => `运行：${state}；额度：${budget}`,
  degraded: DEGRADED,
  degradedOther: '没能完成回复。',
  finished: {
    COMPLETED: '',
    BUDGET: '本次运行因额度结束。',
    FAILED: '运行失败。',
    TIMEOUT: '运行超时。',
    VIOLATION: '运行因越权被终止。',
    CANCELLED: '运行已取消。',
    ENDED_BY_USER: '运行已结束。',
    SHUTDOWN: '已退出。',
  } satisfies Record<CloseReason, string>,
  phase: {
    ASSEMBLING: '组织上下文',
    THINKING: '思考中',
    RETRYING: '重试中',
    CALLING_TOOL: '调用',
    AWAITING_AUTHORIZATION: '等待授权',
    QUEUED: '排队',
    WRAPPING_UP: '收尾',
    ENDED: '结束',
  } satisfies Record<ActivityEvent['phase'], string>,
  runState: RUN_STATE,
});

/** Escapes C0, DEL and C1 controls, keeping line feeds (M1 UserInteraction 5). */
export function terminalText(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code !== 10 && (code < 32 || (code >= 127 && code <= 159))
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character;
    })
    .join('');
}
