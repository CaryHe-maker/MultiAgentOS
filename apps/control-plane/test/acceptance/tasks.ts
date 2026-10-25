/**
 * The fixed task set F1–F5 of docs/M1/M1Plan.md 6. Each task fixes the repository content, the
 * question, the expected sources, the forbidden paths, the forbidden side effects and the
 * acceptance assertions. Questions name no answer file. `script` drives the offline runs only;
 * a real-model run asks the same question and is judged by the same assertions.
 */
import type { AnalysisReport, RunSummary } from '@multiagentos/contracts';
import type { ModelScript, ScriptedCall, ScriptedTurn } from './scripted-provider.js';

/** A line range of the prepared repository; a source counts when it overlaps the range. */
export interface ExpectedSource {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** What a task's own check sees of a finished run. */
export interface RunEvidence {
  readonly calls: readonly {
    readonly kind: string;
    readonly input: unknown;
    readonly outcome: string;
  }[];
  readonly output: string;
  /** Request bodies the provider received. */
  readonly modelRequests: readonly string[];
  /** Every file the system stored under its data directory, as text. */
  readonly stored: readonly string[];
  readonly durationMs: number;
  readonly report?: AnalysisReport;
  readonly summary?: RunSummary;
}

export interface AcceptanceTask {
  readonly id: string;
  readonly title: string;
  /** Directory under `repos/`; the harness copies it before the run. */
  readonly repo: string;
  readonly question: string;
  /**
   * Every entry must be overlapped by a source of some conclusion; a list of ranges is
   * satisfied by any one of them, for facts that equally well-founded answers cite differently.
   */
  readonly expectedSources: readonly (ExpectedSource | readonly ExpectedSource[])[];
  /**
   * Paths that must never be read successfully nor cited; a trailing `/` matches a directory.
   * Writes, deletions and new files anywhere in the repository are forbidden for every task.
   */
  readonly forbiddenPaths: readonly string[];
  /** F5: the run must search at least this often before it finishes. */
  readonly minSearches?: number;
  /** The ending the task requires; by default exit code 0, COMPLETED and a normal report. */
  readonly expect?: {
    readonly exitCode?: number;
    readonly closeReason?: RunSummary['closeReason'];
    readonly degraded?: boolean;
  };
  /** Generates content that is not committed, such as very large or non-UTF-8 files. */
  readonly prepare?: (repository: string) => Promise<void>;
  /** Further assertions; each string returned is a failure. */
  readonly check?: (run: RunEvidence) => string[];
  readonly script: ModelScript;
}

/** Secrets of every repository: never read, never cited. */
const SECRETS = ['.env'];

const turn = (...calls: ScriptedCall[]): ScriptedTurn => ({ calls });
const handoff = (task: string, focusAreas: string[], openQuestions: string[]) =>
  turn({ name: 'handoff_to_code_viewer', arguments: { task, focusAreas, openQuestions } });
const search = (
  query: string,
  mode: 'AUTO' | 'SYMBOL' | 'TEXT' | 'PATH' = 'AUTO',
): ScriptedCall => ({
  name: 'search_repository',
  arguments: { query, mode },
});
const read = (path: string, startLine?: number, endLine?: number): ScriptedCall => ({
  name: 'read_file',
  arguments: {
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  },
});
const finish = (
  summary: string,
  conclusions: { statement: string; sources: ExpectedSource[] }[],
): ScriptedTurn =>
  turn({ name: 'finish_analysis', arguments: { summary, conclusions, unconfirmed: [] } });
const range = (path: string, startLine: number, endLine: number): ExpectedSource => ({
  path,
  startLine,
  endLine,
});

const LATE_FEE = range('src/billing/late-fee.ts', 10, 20);
const LATE_FEE_TEST = range('test/late-fee.test.ts', 9, 20);
const POLICY = range('src/loans/loan-policy.ts', 14, 23);
const POLICY_TEST = range('test/loan-policy.test.ts', 12, 16);
const ROUTE_RETURN = range('src/http/routes.ts', 20, 24);
const SERVICE_RETURN = range('src/loans/loan-service.ts', 39, 50);
const STORE_SAVE = range('src/storage/memory-store.ts', 25, 27);
const CONFIG_FEE = range('config/library.json', 3, 4);
const HOLD_EVENT = range('src/holds/hold-queue.ts', 36, 42);
const BUS_PUBLISH = range('src/events/event-bus.ts', 13, 15);
const SERVICE_PUBLISH = range('src/loans/loan-service.ts', 48, 48);

export const TASKS: readonly AcceptanceTask[] = [
  {
    id: 'F1',
    title: '解释已知函数的行为和边界',
    repo: 'bookshelf',
    question:
      '解释 calculateLateFee 的行为：什么情况下收费、费用怎么计算，' +
      '在到期当天、宽限期内和刚过宽限期时分别返回什么？',
    expectedSources: [LATE_FEE],
    forbiddenPaths: SECRETS,
    script: {
      planner: [
        handoff(
          '解释 calculateLateFee 的收费规则与边界情况',
          ['calculateLateFee'],
          ['何时不收费？', '费用从哪天开始计算？'],
        ),
      ],
      codeViewer: [
        turn(search('calculateLateFee', 'SYMBOL')),
        turn(read('src/billing/late-fee.ts')),
        finish('calculateLateFee 在宽限期内不收费，过了宽限期后从到期日起按天计费。', [
          {
            statement:
              '到期当天及以前返回 0；迟还天数向上取整，不超过 graceDays 时返回 0；' +
              '超过后返回迟还天数乘以 feeCentsPerDay，天数从到期日而不是宽限期结束算起。',
            sources: [LATE_FEE],
          },
        ]),
      ],
    },
  },
  {
    id: 'F2',
    title: '根据业务描述定位未知实现与测试',
    repo: 'bookshelf',
    question: '会员同时在借的图书数量上限是在哪里判断的？这个规则有没有测试覆盖？',
    expectedSources: [POLICY, POLICY_TEST],
    forbiddenPaths: SECRETS,
    script: {
      planner: [
        handoff(
          '找到在借数量上限的判断逻辑及其测试',
          ['在借数量上限'],
          ['上限在哪里判断？', '有没有测试？'],
        ),
      ],
      codeViewer: [
        turn(search('maxActiveLoans', 'TEXT')),
        turn(read('src/loans/loan-policy.ts'), read('test/loan-policy.test.ts')),
        finish('上限由 canBorrow 按会员等级判断，并有专门的测试覆盖。', [
          {
            statement:
              'canBorrow 在在借数量达到 maxActiveLoans[tier] 时拒绝，原因为 TOO_MANY_LOANS。',
            sources: [POLICY],
          },
          {
            statement: '测试验证了第 5 本被拒绝、第 4 本之后仍允许借阅。',
            sources: [POLICY_TEST],
          },
        ]),
      ],
    },
  },
  {
    id: 'F3',
    title: '跨两个以上文件解释接口与数据流',
    repo: 'bookshelf',
    question:
      '一次还书请求从 HTTP 入口到写入存储，依次经过哪些模块？数据在其间是怎样传递和变化的？',
    expectedSources: [ROUTE_RETURN, SERVICE_RETURN, STORE_SAVE],
    forbiddenPaths: SECRETS,
    script: {
      planner: [
        handoff(
          '追踪还书请求从入口到存储的调用链和数据变化',
          ['还书', 'HTTP 路由', '存储'],
          ['入口如何解析请求？', '还书时数据如何变化？', '最终如何写入？'],
        ),
      ],
      codeViewer: [
        turn(search('return', 'PATH'), search('returnBook', 'SYMBOL')),
        turn(
          read('src/http/routes.ts'),
          read('src/loans/loan-service.ts'),
          read('src/storage/memory-store.ts'),
        ),
        finish('还书经路由、LoanService 到 Store，途中计算罚金并发布事件。', [
          {
            statement: '路由匹配 POST /loans/:id/return，解码 loanId 后调用 returnBook。',
            sources: [ROUTE_RETURN],
          },
          {
            statement:
              'returnBook 取出借阅记录，补上 returnedAt 与 feeCents，保存后发布 BookReturned。',
            sources: [SERVICE_RETURN],
          },
          { statement: 'Store.saveLoan 以借阅 id 为键保存一份拷贝。', sources: [STORE_SAVE] },
        ]),
      ],
    },
  },
  {
    id: 'F4',
    title: '识别拟议功能涉及的实现、测试和配置位置',
    repo: 'bookshelf',
    question: '如果要给逾期罚金增加一个单笔上限，需要改动哪些实现、测试和配置？',
    expectedSources: [LATE_FEE, LATE_FEE_TEST, CONFIG_FEE],
    forbiddenPaths: SECRETS,
    script: {
      planner: [
        handoff(
          '列出为逾期罚金加单笔上限需要改动的实现、测试和配置',
          ['逾期罚金', '配置'],
          ['罚金在哪里计算？', '哪些测试覆盖罚金？', '罚金参数在哪里配置？'],
        ),
      ],
      codeViewer: [
        turn(search('feeCentsPerDay', 'TEXT')),
        turn(
          read('src/billing/late-fee.ts'),
          read('test/late-fee.test.ts'),
          read('config/library.json'),
        ),
        finish('需要改罚金计算函数、它的测试和图书馆配置。', [
          { statement: '在 calculateLateFee 的返回值上加上限。', sources: [LATE_FEE] },
          { statement: '在罚金测试中增加超过上限的用例。', sources: [LATE_FEE_TEST] },
          { statement: '在 config/library.json 的罚金参数旁增加上限配置。', sources: [CONFIG_FEE] },
        ]),
      ],
    },
  },
  {
    id: 'F5',
    title: '首次证据不足后补充查询并形成结论',
    repo: 'bookshelf',
    question: '一本被预约的书归还之后，系统是怎样通知预约者的？会通知所有人吗？',
    // How the notice is triggered: the bus's publish or the publishing call both show it.
    expectedSources: [HOLD_EVENT, [BUS_PUBLISH, SERVICE_PUBLISH]],
    forbiddenPaths: SECRETS,
    minSearches: 2,
    script: {
      planner: [
        handoff(
          '说明预约图书归还后通知预约者的机制',
          ['预约', '通知'],
          ['谁会收到通知？', '通知如何触发？'],
        ),
      ],
      codeViewer: [
        // The obvious query finds only the deprecated notifier, which nothing calls.
        turn(search('notify')),
        turn(read('src/legacy/notifier.ts')),
        turn(search('BookReturned', 'TEXT')),
        turn(read('src/holds/hold-queue.ts'), read('src/events/event-bus.ts')),
        finish('归还时发布 BookReturned，HoldQueue 只通知队首的预约者；旧的群发通知已废弃。', [
          {
            statement:
              'HoldQueue 收到 BookReturned 后只给该书队列的第一位预约者发邮件，并保留 holdPickupDays 天。',
            sources: [HOLD_EVENT],
          },
          { statement: 'EventBus.publish 同步依次调用所有订阅者。', sources: [BUS_PUBLISH] },
        ]),
      ],
    },
  },
];
