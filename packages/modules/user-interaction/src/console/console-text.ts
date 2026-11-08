import type {
  ActivityEvent,
  AuthorizationRequest,
  CloseReason,
  SessionFailed,
} from '@multiagentos/contracts';

export type CommandQuestion = Extract<AuthorizationRequest, { capability: 'command.exec' }>;

const UNREUSABLE_TEXT: Readonly<Record<string, string>> = {
  PARSE_ERROR: '命令无法完整解析',
  DYNAMIC_COMMAND_NAME: '命令名来自变量或替换',
  COMMAND_SUBSTITUTION: '含命令替换',
  PROCESS_SUBSTITUTION: '含进程替换',
  EVAL: '含 eval',
  SHELL_C: '含 sh -c / bash -c',
  PIPE_TO_SHELL: '管道通往 shell',
  HEREDOC_TO_SHELL: 'heredoc 作为 shell 的输入',
  NO_COMMAND: '没有可执行的命令',
  CRITICAL_COMMAND: '命中高风险命令名单',
  NETWORK: '需要联网',
  UNISOLATED: '沙盒不可用，命令未隔离',
};

/** A command longer than this is shown by its first lines; `v` shows all of it. */
const COMMAND_PREVIEW_LINES = 3;
const COMMAND_PREVIEW_CHARS = 240;

/** The command as the question shows it: all of it when short, else the head and a count. */
export function commandPreview(command: string): { readonly text: string; readonly cut: boolean } {
  const clean = terminalText(command);
  const lines = clean.split('\n');
  if (lines.length <= COMMAND_PREVIEW_LINES && clean.length <= COMMAND_PREVIEW_CHARS)
    return { text: clean, cut: false };
  const head = lines.slice(0, COMMAND_PREVIEW_LINES).join('\n');
  const shown = head.length > COMMAND_PREVIEW_CHARS ? head.slice(0, COMMAND_PREVIEW_CHARS) : head;
  return {
    text: `${shown}\n…（共 ${String(lines.length)} 行、${String(clean.length)} 个字符，输入 v 查看全文）`,
    cut: true,
  };
}

/** What the user is shown before a command runs: the command, where, and what it may do. */
function commandQuestionText(q: CommandQuestion): string {
  const preview = commandPreview(q.command);
  const lines = [
    q.matched !== undefined || q.network || q.unisolated
      ? '⚠ 高风险命令，请确认：'
      : '允许 Agent 运行这条命令吗？',
    '  ' + preview.text.split('\n').join('\n  '),
    '  工作目录：' + (q.workdir === '' ? '仓库根目录' : q.workdir),
    '  可写范围：' + q.writableRoots.map((root) => (root === '.' ? '整个仓库' : root)).join('、'),
    '  网络：' + (q.network ? '共享主机网络（命令可以联网）' : '无'),
    ...(q.unisolated ? ['  未隔离：沙盒不可用，命令以你的权限直接运行'] : []),
    ...(q.matched === undefined ? [] : ['  命中名单：' + q.matched]),
  ];
  const menu = [
    '1 / y  只允许这一次',
    ...(q.options.includes('COMMAND') ? ['2 / c  本次运行内，这条命令都允许'] : []),
    ...(q.options.includes('PREFIX')
      ? ['3 / p  本次运行内，这些命令前缀都允许：' + q.prefixes.join('、')]
      : []),
    ...(preview.cut ? ['v      查看完整命令'] : []),
    'n      拒绝',
  ];
  const why = q.unreusable.map((reason) => UNREUSABLE_TEXT[reason] ?? reason);
  return [
    ...lines,
    ...(why.length === 0 ? [] : ['  只能单次允许：' + why.join('；')]),
    ...menu,
  ].join('\n');
}

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
  PROVIDER_AUTH: '模型服务拒绝了 API 密钥，没能完成回复。',
  PROVIDER_RATE_LIMITED: '模型服务限流，重试后仍然失败，没能完成回复。',
  PROVIDER_UNREACHABLE: '连不上模型服务，没能完成回复。',
  PROVIDER_ERROR: '模型服务出错，没能完成回复。',
  UNIT_TIMEOUT: '模型调用超时，没能完成回复。',
  MEMORY_PRESSURE: '系统内存紧张，运行被中断，没能完成回复。',
  USER_ABORT: '已中止，没能完成回复。文件改动保留在工作区，需要撤销时用 /undo。',
  TURN_TIMEOUT: '这一轮用时太长，被中断了，没能完成回复。文件改动保留在工作区。',
  PAUSE_TIMEOUT: '暂停太久，运行被中断了，没能完成回复。文件改动保留在工作区。',
};

/** The reply above is complete as far as it goes, but the Turn stopped before the task did. */
const EARLY_END: Readonly<Record<string, string>> = {
  BUDGET_WRAP_UP: '额度接近用完，这一轮提前结束了。',
  TOOL_UNIT_LIMIT: '工具调用次数到了上限，这一轮提前结束了。',
  WALL_CLOCK_LIMIT: '运行时间到了上限，这一轮提前结束了。',
  ROUND_LIMIT:
    '轮次到了上限，这一轮提前结束了；上面的回复写明了已完成与未完成的部分，可以据此决定下一条提示词。',
  MEMORY_LIMIT: '系统内存紧张，这一轮提前结束了。',
  NO_PROGRESS: '连续几轮没有进展，这一轮提前结束了。',
  REPEATED_INTENT: '同一个调用重复太多次，这一轮提前结束了。',
  CONSECUTIVE_ERRORS: '工具连续出错，这一轮提前结束了。',
  CONTEXT_LIMIT: '上下文已满，这一轮提前结束了；可以用 /new 开始新对话继续。',
  REGENERATION_LIMIT: '模型的回复连续不合要求，这一轮提前结束了。',
};

const RUN_STATE: Readonly<Record<string, string>> = {
  RUNNING: '运行中',
  PAUSING: '暂停中…',
  PAUSED: '已暂停',
  INTERRUPTING: '正在中止…',
  AWAITING_INPUT: '等待输入',
  CONVERGING: '正在结束',
  CLOSED: '已结束',
  NONE: '未开始',
};

/** The words of the console; the logic never builds user text itself. */
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
  webSearch: (queries: readonly string[], provider: string) =>
    `允许 Agent 联网搜索吗？搜索词会发送至 ${provider}，本次运行内不再询问。
搜索词：${queries.join(' | ')}
[y/n]`,
  webFetch: (host: string, url: string) =>
    `允许 Agent 访问网站 ${host} 吗？页面内容会作为资料交给 Agent，本次运行内对这个网站不再询问。
地址：${url}
[y/n]`,
  writeRoot: (root: string) =>
    `允许 Agent 修改 ${root === '.' ? '仓库中' : `${root} 下`}的文件吗？本次运行内不再询问；.git、密钥等受保护的路径始终不能写入。[y/n]`,
  command: (q: CommandQuestion) => commandQuestionText(q),
  writeCritical: (path: string, text: string) =>
    `允许 Agent 写入 ${path} 吗？写入后它会作为可信的项目指令。只对这一次写入有效。\n${text}\n[y/n]`,
  undoConfirm: (files: readonly string[]) =>
    `这些文件在之后被别处改过：\n${files.join('\n')}\n仍要回退吗？被覆盖的内容会保留在快照中。[y/n]`,
  undoCancelled: {
    USER_CANCELLED: '已取消回退，没有修改任何文件。',
    NEW_INPUT: '已取消回退，没有修改任何文件。',
    SESSION_CLOSED: '已取消回退，没有修改任何文件。',
    FILE_CHANGED: '回退中途文件又被改动，已恢复，没有回退。',
  },
  /** One step line in the history, like a tool call: it happened here, and that is all it says. */
  compacted: (turns: number, pruned: number) =>
    turns > 0
      ? `✓ 已压缩较早的对话（${String(turns)} 个 Turn，修剪 ${String(pruned)} 个工具结果）`
      : `✓ 已修剪 ${String(pruned)} 个较大的工具结果`,
  compactionFailed: {
    NOTHING_TO_COMPACT: '没有可压缩的内容。',
    BUDGET_INSUFFICIENT: '额度不够，没有压缩。',
    SUMMARY_FAILED: '摘要没有生成，没有压缩。',
    NOT_RECORDED: '压缩没能记录，没有压缩。',
  } as const,
  undone: (turns: number) => `已回退 ${String(turns)} 轮的文件改动。`,
  noDiff: '没有可以显示的改动。',
  diverged: (files: number) => `自上次以来，工作区有 ${String(files)} 个文件被改动过。`,
  forkDraft: '下一条消息会开始一个分出的新对话，它带着到目前为止的全部内容。',
  granted: '已允许。',
  declined: '已拒绝。',
  continueAfterBudget: '本次运行的额度已用完。要在这个对话中继续吗？[y/n]',
  queued: (count: number) => `已排队 ${String(count)} 条`,
  pressAgain: '再按一次 Ctrl+C 退出',
  paused: '已暂停。/continue [说明] 继续（直接输入消息也行），Ctrl+C 中止。',
  resumed: '已继续。',
  steered: (waiting: boolean) =>
    waiting
      ? '已插入；对方正在等结果，收到结果后可见。'
      : '已插入；对方做完当前这一轮的工具之后可见。',
  steerNotNow: '只有运行中才能插话（暂停时请用 /continue）。',
  continueNotNow: '只有暂停时才能继续。',
  noSuchTask: (name: string) => `没有找到任务 @${name}；以活动区里的名字为准。`,
  ambiguousTask: (name: string) => `@${name} 对应不止一个任务，请写得更具体。`,
  aborting: '正在中止；已完成的结果和文件改动都保留。',
  questionCancelled: '问题已取消。',
  question: {
    from: (agent: string) => `${agent} 想问你：`,
    review: '请审阅下面的内容：',
    confirmMenu: 'y 同意 / n 不同意',
    field: (label: string, index: number, total: number) =>
      `（${String(index + 1)}/${String(total)}）${label}`,
    options: (options: readonly string[]) =>
      options.map((option, index) => `  ${String(index + 1)}. ${option}`).join('\n'),
    multi: '可多选，用逗号分隔编号。',
    skip: '可选项，输入 - 跳过。',
    invalid: '这个回答不符合要求，请重答。',
    review_note: '写下你的意见；同意可以只回答 y。',
  },
  truncated: (index: number) => `输出已截断（/output ${String(index)} 查看完整输出）`,
  fullOutputExpired: '完整输出已在 7 天后删除。',
  notNow: '当前不能使用这条指令。',
  unknownCommand: (name: string) => `没有这条指令：${name}。/help 查看指令。`,
  help: [
    '/new              开始新对话',
    '/fork             从当前对话分出一个新对话',
    '/sessions         列出本仓库的对话',
    '/resume <编号>    打开对话',
    '/delete <编号>    删除未打开的对话',
    '/status           当前运行与额度状态',
    '/output <编号>    查看被截断的工具输出',
    '/undo [all]       回退最近一轮（或全部）的文件改动',
    '/compact          压缩较早的对话，腾出上下文空间',
    '/diff [N]         查看倒数第 N 轮改动了什么',
    '/timeline         本次运行中每个 AgentRun 的起止时间',
    '/think [N]        列出思考内容；带编号则显示第 N 段思考的全文',
    '/continue [@任务] [说明]  暂停后继续，可附加一句说明',
    '/steer [@任务] <说明>     运行中插话（Alt+Enter 发送输入框里的内容），不暂停',
    'Ctrl+C 暂停，暂停后再按一次中止；退出用 /exit。',
    '/exit             退出',
    'Enter 发送，\\ 加 Enter 换行，Esc 清空，↑/↓ 浏览历史；运行中发送的消息会排队。',
    'Ctrl+O 折叠或展开正在显示的思考；折叠过的思考是一行，用 /think N 查看全文；思考只保存在这个进程的内存里。',
  ].join('\n'),
  thinkingNone: '还没有思考内容（只有开启思考的模型调用才有）。',
  thinkingMissing: (number: number, first: number | undefined, last: number | undefined) =>
    first === undefined || last === undefined
      ? `没有第 ${String(number)} 段思考：这个进程里还没有思考内容。`
      : `没有第 ${String(number)} 段思考；现有第 ${String(first)}–${String(last)} 段（编号每次启动从 1 开始，更早的已丢弃）。`,
  thinkingBlockLine: (number: number, label: string, seconds: string) =>
    `  第 ${String(number)} 段：${label} 思考 ${seconds}`,
  /** The label of an activity line that no AgentRun stands behind. */
  system: '系统',
  thinkingList: '思考内容（/think <N> 查看全文）：',
  /** While an agent writes its answer: the text itself comes whole, when it is published. */
  answering: (label: string, seconds: string) => `· ${label} 正在输出回答 ${seconds}`,
  /** The one line a block that is no longer in view leaves in the transcript. */
  thinkingFolded: (number: number, label: string, seconds: string) =>
    `✻ ${label} 思考 ${seconds}（/think ${String(number)} 展开）`,
  thinkingHeader: (label: string, seconds: string, state: 'OPEN' | 'DONE' | 'ABORTED') =>
    `✻ ${label} 思考 ${seconds}${state === 'ABORTED' ? '（已中止）' : ''}`,
  thinkingCut: '（内容太长，后面的没有保留）',
  timelineEmpty: '本次运行还没有 AgentRun。',
  timelineLine: (
    indent: string,
    label: string,
    from: string,
    to: string | undefined,
    duration: string,
  ) =>
    `${indent}${label}  ${from.slice(11, 19)} → ${to === undefined ? '进行中' : to.slice(11, 19)}（${duration}）`,
  status: (state: string, budget: string) => `运行：${state}；额度：${budget}`,
  degraded: DEGRADED,
  earlyEnd: EARLY_END,
  degradedOther: '没能完成回复。',
  /** What the user is told when memory runs short; the same event is on record in the Kernel. */
  memory: (source: 'PROCESS' | 'SYSTEM', level: 'WARNING' | 'DANGER', ratio: number): string => {
    const percent = `${(ratio * 100).toFixed(0)}%`;
    if (source === 'SYSTEM')
      return `⚠ 整机内存紧张（已用 ${percent}），多半是其他程序占用；本程序的运行不受影响，必要时请关闭其他程序。`;
    return level === 'DANGER'
      ? `⚠ 本程序的内存危险（${percent}），正在进行的运行会被中断；对话记录完整，可以随后重新输入。`
      : `⚠ 本程序的内存偏高（${percent}），当前一轮会提前收尾，新的任务暂缓，内存回落后即可继续。`;
  },
  finished: {
    COMPLETED: '',
    BUDGET: '本次运行因额度结束。',
    FAILED: '运行失败。',
    TIMEOUT: '运行超时。',
    VIOLATION: '运行因越权被终止。',
    CANCELLED: '运行已取消。',
    ENDED_BY_USER: '运行已结束。',
    SHUTDOWN: '已退出。',
    INTERRUPTED: '运行因内存紧张被中断，对话记录完整；可以直接重新输入，开始新的一轮。',
  } satisfies Record<CloseReason, string>,
  phase: {
    ASSEMBLING: '组织上下文',
    THINKING: '思考中',
    RETRYING: '重试中',
    CALLING_TOOL: '调用',
    AWAITING_AUTHORIZATION: '等待授权',
    QUEUED: '排队',
    WAITING_SUBTASKS: '等待子任务',
    AWAITING_ANSWER: '等待你的回答',
    PAUSED: '已暂停',
    COMPACTING: '正在压缩上下文',
    WRAPPING_UP: '收尾',
    ENDED: '结束',
  } satisfies Record<ActivityEvent['phase'], string>,
  runState: RUN_STATE,
});

/** Escapes C0, DEL and C1 controls, keeping line feeds. */
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
