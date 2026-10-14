import { AnalysisReportSchema, assertValid } from '@multiagentos/contracts';
import type { AnalysisReport, ReasonCode, RunFailure, WrapUpReason } from '@multiagentos/contracts';
import type { InvalidActionReason } from './analysis-action.js';
import { withEmptyFileNotice } from './report-sources.js';

const WRAP_UP_MESSAGES: Readonly<Record<WrapUpReason, string>> = {
  ROUND_LIMIT: '已达到本次分析的轮次上限，未形成可发布的分析结论。',
  BUDGET_WRAP_UP: '本次分析已进入额度收尾阶段，收尾调用未形成可发布的分析结论。',
  BUDGET_EXHAUSTED: '本次分析的额度已不足以继续调用模型，未形成可发布的分析结论。',
  USER_DECLINED: '仓库读取授权未获同意，未形成可发布的分析结论。',
  NO_PROGRESS: '本次分析连续多轮未取得新的有效结果，收尾调用未形成可发布的分析结论。',
  REGENERATION_LIMIT: '模型输出连续未满足要求，收尾调用未形成可发布的分析结论。',
};

const FAILURE_MESSAGES: Readonly<Record<ReasonCode, string>> = {
  INVALID_REQUEST: '请求不符合系统协议。',
  CALLER_FORBIDDEN: '调用方没有发起该请求的权限。',
  RUN_NOT_FOUND: '无法找到对应的运行。',
  RUN_BLOCKED: '运行已进入结束流程，无法开始新操作。',
  REQUEST_CONFLICT: '重复请求的内容发生冲突。',
  RUN_LIMIT: '当前进程无法创建新的运行。',
  REPOSITORY_INVALID: '仓库路径不符合运行要求。',
  DEFINITION_MISMATCH: '运行定义的版本摘要不一致。',
  DEFINITION_UNAVAILABLE: '所需运行定义不可用。',
  AGENT_RUN_ACTIVE: '当前已有另一个活动的代理运行。',
  AGENT_RUN_EXISTS: '代理运行已经登记。',
  AGENT_RUN_NOT_FOUND: '无法找到对应的代理运行。',
  AGENT_RUN_ENDED: '代理运行已经结束。',
  FORBIDDEN: '该操作不在当前代理的授权范围内。',
  UNSUPPORTED_CAPABILITY: '该操作使用了当前版本不支持的能力。',
  INVALID_INPUT: '操作输入不符合协议要求。',
  QUESTION_NOT_PENDING: '授权询问已经失效。',
  INVALID_ARTIFACT_REF: '所需产物引用无效。',
  USER_DECLINED: '仓库读取授权未获同意。',
  BUDGET_WRAP_UP: '模型调用会占用保留的收尾额度，未获执行。',
  BUDGET_EXHAUSTED: '剩余额度不足以执行模型调用。',
  FINAL_CALL_USED: '本次运行已经使用过最后一次收尾调用。',
  OUT_OF_SCOPE: '操作目标超出了允许访问的范围。',
  NOT_FOUND: '无法找到请求的文件。',
  UNSUPPORTED_FILE: '请求的文件类型不受支持。',
  INVALID_RANGE: '请求的文件行范围不合法。',
  INVALID_QUERY: '检索表达式不合法。',
  LIMIT_EXCEEDED: '操作超出了规定的资源或输出限制。',
  PROVIDER_UNREACHABLE: '无法连接模型服务。',
  PROVIDER_RATE_LIMITED: '模型服务限制了请求频率。',
  PROVIDER_AUTH: '模型服务的认证或访问权限校验失败，请检查调用凭据和权限设置。',
  PROVIDER_ERROR: '模型服务返回错误，或响应在传输中中断。',
  UNIT_TIMEOUT: '操作执行超时。',
  INTERNAL: '操作执行发生内部错误。',
  EXECUTION_CANCELLED: '操作执行已被取消。',
  SCOPE_MISSING: '执行所需的访问范围约束缺失或不合法。',
  PATH_ESCAPE: '实际访问路径超出了仓库范围。',
  GUARD_FAILURE: '执行点的安全防护失效。',
  EXECUTION_STOP_UNCONFIRMED: '无法确认执行已经停止。',
  PIN_FAILED: '代理定义固定失败，或交接目标的定义摘要不一致。',
  WORKFLOW_INTERNAL: '分析流程发生内部错误。',
  KERNEL_INTERNAL: '运行控制发生内部错误。',
};

const INVALID_MESSAGES: Readonly<Record<InvalidActionReason, string>> = {
  NO_ACTION: '模型没有返回可执行的动作。',
  OUTPUT_TRUNCATED: '模型输出被截断，没有返回可执行的动作。',
  CONTROL_MIXED: '模型把结束或交接动作与其他调用混合返回。',
  CONTROL_NOT_ALLOWED: '模型返回了当前代理或当前阶段不允许的控制动作。',
  CONTROL_ARGUMENTS_INVALID: '模型返回的控制动作参数不符合要求。',
};

export type LastReportIssue =
  | { readonly kind: 'FAILURE'; readonly failure: RunFailure }
  | { readonly kind: 'INVALID_OUTPUT'; readonly reason: InvalidActionReason }
  | { readonly kind: 'NO_FINISH' };

export interface DegradedReportInput {
  readonly workflowRunId: string;
  readonly goal: string;
  readonly reason: WrapUpReason;
  readonly readSources: readonly AnalysisReport['readSources'][number][];
  readonly agentRounds: readonly AnalysisReport['agentRounds'][number][];
  readonly snapshotId?: string;
  readonly createdAt: string;
  readonly lastIssue?: LastReportIssue;
  readonly emptyFileCount?: number;
}

/** Builds a report from known facts; exception detail and raw model content are never included. */
export function createDegradedReport(input: DegradedReportInput): AnalysisReport {
  let summary = WRAP_UP_MESSAGES[input.reason];
  if (input.lastIssue?.kind === 'FAILURE') {
    summary += ` 最后一次操作失败：${FAILURE_MESSAGES[input.lastIssue.failure.code]}`;
  } else if (input.lastIssue?.kind === 'INVALID_OUTPUT') {
    summary += ` 最后一次模型输出不合格：${INVALID_MESSAGES[input.lastIssue.reason]}`;
  } else if (input.lastIssue?.kind === 'NO_FINISH') {
    summary += ' 最后一次收尾调用没有返回合法的结束结果。';
  }
  return assertValid<AnalysisReport>(AnalysisReportSchema, {
    workflowRunId: input.workflowRunId,
    goal: input.goal,
    summary: withEmptyFileNotice(summary, input.emptyFileCount ?? 0),
    degraded: true,
    wrapUp: { reason: input.reason },
    conclusions: [],
    unconfirmed: [],
    readSources: input.readSources.map((source) => ({ ...source })),
    agentRounds: input.agentRounds.map((agent) => ({ ...agent })),
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    createdAt: input.createdAt,
  });
}
