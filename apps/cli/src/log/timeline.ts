/**
 * The time line of a Session, read from its log (docs/M2/Phase1Console.md 3). The log holds
 * structured fields and references; the bodies (what the user wrote, what the model thought and
 * said, the arguments and results of tools) are in the artifact store, so the builder asks for
 * them through `readText`. It only reads: nothing here writes, and no model or network is needed.
 *
 * A record type this version does not know is skipped, not an error: the viewer is for finding
 * out what happened, and a log written by a newer system should still show most of it.
 */
import {
  ModelRawOutputSchema,
  validate,
  type ArtifactRef,
  type ModelRawOutput,
  type SessionLogRecord,
  type TokenUsage,
} from '@multiagentos/contracts';

/** The body of an artifact as text; `undefined` when it expired or is missing. */
export type ReadText = (ref: ArtifactRef) => Promise<string | undefined>;

export interface ToolCallView {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: string | undefined;
}

interface EntryBase {
  readonly seq: number;
  readonly at: string;
}

export type EntryView =
  | (EntryBase & {
      readonly kind: 'MODEL';
      readonly agent: string;
      readonly requestId: string;
      readonly durationMs?: number;
      readonly usage?: TokenUsage;
      readonly context?: { readonly tokens: number; readonly budget: number };
      readonly providerFinishReason?: string;
      readonly reasoning: string | undefined;
      /** True when the model returned thinking but its artifact is gone. */
      readonly reasoningMissing: boolean;
      readonly text: string | undefined;
      readonly toolCalls: readonly ToolCallView[];
    })
  | (EntryBase & {
      readonly kind: 'TOOL';
      readonly agent: string;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly status: 'OK' | 'REJECTED' | 'FAILED';
      readonly reasonCode?: string;
      readonly durationMs?: number;
      readonly args: string | undefined;
      readonly output: string | undefined;
      /** The preview was cut; the whole output lives in a reference that expires. */
      readonly cut: boolean;
    })
  | (EntryBase & {
      readonly kind: 'AUTHORIZATION';
      readonly capability: string;
      readonly resolution: 'GRANTED' | 'DECLINED' | 'CANCELLED' | undefined;
    })
  | (EntryBase & {
      readonly kind: 'HUMAN';
      readonly role: 'QUESTION' | 'ANSWER' | 'STEER';
      readonly askKind: string;
      readonly text: string | undefined;
    })
  | (EntryBase & {
      readonly kind: 'EVENT';
      readonly label: string;
      readonly detail?: string;
    });

export interface TurnView {
  readonly turnId: string;
  readonly index: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly endReason?: string;
  readonly usage?: unknown;
  /** What the user wrote to start the Turn. */
  readonly user: readonly (string | undefined)[];
  readonly entries: readonly EntryView[];
}

export interface SessionTimeline {
  readonly startedAt?: string;
  readonly repositoryRoot?: string;
  readonly sandbox?: string;
  readonly records: number;
  readonly turns: readonly TurnView[];
  /** Records that belong to no Turn (before the first, or after an exit). */
  readonly outside: readonly EntryView[];
  readonly totals: {
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheHitTokens: number;
  };
}

interface MutableTurn {
  turnId: string;
  index: number;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  usage?: unknown;
  user: (string | undefined)[];
  entries: EntryView[];
}

const decode = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** A short sentence for what a structured value says, for records that carry no body. */
const jsonText = (value: unknown): string | undefined =>
  value === undefined ? undefined : (decode(value) ?? JSON.stringify(value));

export async function buildTimeline(
  records: readonly SessionLogRecord[],
  readText: ReadText,
): Promise<SessionTimeline> {
  const turns: MutableTurn[] = [];
  const turnById = new Map<string, MutableTurn>();
  const outside: EntryView[] = [];
  const agents = new Map<string, string>();
  const calls = new Map<string, { toolName: string; args: string | undefined }>();
  const submitted = new Map<string, { at: string; toolCallId?: string; agentRunId: string }>();
  const contexts = new Map<string, { tokens: number; budget: number }>();
  const authorizations = new Map<string, { turn: MutableTurn | undefined; index: number }>();
  const pendingPrompts: (string | undefined)[] = [];
  let current: MutableTurn | undefined;
  let startedAt: string | undefined;
  let repositoryRoot: string | undefined;
  let sandbox: string | undefined;
  let modelCalls = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheHitTokens = 0;

  const turnOf = (turnId: string | undefined): MutableTurn | undefined =>
    turnId === undefined ? current : (turnById.get(turnId) ?? current);
  const place = (turn: MutableTurn | undefined, entry: EntryView): number => {
    const list = turn === undefined ? outside : turn.entries;
    list.push(entry);
    return list.length - 1;
  };
  const event = (
    record: SessionLogRecord,
    turn: MutableTurn | undefined,
    label: string,
    detail?: string,
  ): void => {
    place(turn, {
      kind: 'EVENT',
      seq: record.seq,
      at: record.at,
      label,
      ...(detail === undefined ? {} : { detail }),
    });
  };
  const agentOf = (agentRunId: string): string => agents.get(agentRunId) ?? agentRunId;
  const millisBetween = (from: string | undefined, to: string): number | undefined => {
    if (from === undefined) return undefined;
    const span = Date.parse(to) - Date.parse(from);
    return Number.isNaN(span) ? undefined : Math.max(0, span);
  };

  for (const record of records) {
    const inTurn = 'turnId' in record ? turnOf(record.turnId) : current;
    switch (record.type) {
      case 'SESSION_STARTED':
        startedAt = record.at;
        repositoryRoot = record.repositoryRoot;
        sandbox = record.sandbox?.state;
        break;
      case 'TURN_STARTED': {
        const turn: MutableTurn = {
          turnId: record.turnId ?? `turn-${String(turns.length + 1)}`,
          index: turns.length + 1,
          startedAt: record.at,
          user: pendingPrompts.splice(0),
          entries: [],
        };
        turns.push(turn);
        turnById.set(turn.turnId, turn);
        current = turn;
        break;
      }
      case 'TURN_ENDED': {
        const turn = inTurn;
        if (turn !== undefined) {
          turn.endedAt = record.at;
          turn.endReason = record.reason;
          if (record.usage !== undefined) turn.usage = record.usage;
        }
        break;
      }
      case 'HUMAN_ANSWERED': {
        const body = await readText(record.contentRef);
        const turn = record.turnId === undefined ? undefined : turnById.get(record.turnId);
        if (record.kind === 'prompt') {
          if (turn === undefined) pendingPrompts.push(body);
          else turn.user.push(body);
        } else {
          place(inTurn, {
            kind: 'HUMAN',
            seq: record.seq,
            at: record.at,
            role: record.kind === 'steer' ? 'STEER' : 'ANSWER',
            askKind: record.kind,
            text: body,
          });
        }
        break;
      }
      case 'HUMAN_REQUESTED':
        if (record.kind !== 'prompt')
          place(inTurn, {
            kind: 'HUMAN',
            seq: record.seq,
            at: record.at,
            role: 'QUESTION',
            askKind: record.kind,
            text: record.question,
          });
        break;
      case 'AGENT_RUN_REGISTERED':
        agents.set(
          record.agentRunId,
          record.parentAgentRunId === undefined
            ? record.agentRef.id
            : `${record.agentRef.id}（子 Agent）`,
        );
        break;
      case 'AGENT_RUN_ENDED':
        event(record, inTurn, `${agentOf(record.agentRunId)} 结束`, record.outcome);
        break;
      case 'AGENT_WRAP_UP':
        event(
          record,
          inTurn,
          `${agentOf(record.agentRunId)} 进入收尾`,
          `${record.reason}，第 ${String(record.round)} 轮`,
        );
        break;
      case 'CONTEXT_ASSEMBLED':
        contexts.set(record.requestId, { tokens: record.tokenCount, budget: record.tokenBudget });
        break;
      case 'UNIT_SUBMITTED':
        submitted.set(record.requestId, {
          at: record.at,
          agentRunId: record.agentRunId,
          ...(record.inputSource.kind === 'TOOL_CALL'
            ? { toolCallId: record.inputSource.toolCallId }
            : {}),
        });
        break;
      case 'MODEL_TURN': {
        modelCalls += 1;
        const raw = await readText(record.outputRef);
        let parsed: ModelRawOutput | undefined;
        if (raw !== undefined) {
          try {
            const checked = validate<ModelRawOutput>(ModelRawOutputSchema, JSON.parse(raw));
            if (checked.ok) parsed = checked.value;
          } catch {
            parsed = undefined;
          }
        }
        const argsOf = new Map(
          (parsed?.toolCalls ?? []).map((call) => [call.toolCallId, call.argumentsText]),
        );
        const views = record.toolCalls.map((call) => {
          const args = argsOf.get(call.toolCallId);
          calls.set(call.toolCallId, { toolName: call.toolName, args });
          return { toolCallId: call.toolCallId, toolName: call.toolName, args };
        });
        const reasoning =
          record.reasoningRef === undefined ? undefined : await readText(record.reasoningRef);
        // The record has a usage field, but what the provider reported is kept with the output.
        const usage = record.usage ?? parsed?.usage;
        if (usage !== undefined) {
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          cacheHitTokens += usage.inputCacheHitTokens ?? 0;
        }
        const durationMs = millisBetween(submitted.get(record.requestId)?.at, record.at);
        const context = contexts.get(record.requestId);
        place(inTurn, {
          kind: 'MODEL',
          seq: record.seq,
          at: record.at,
          agent: agentOf(record.agentRunId),
          requestId: record.requestId,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(usage === undefined ? {} : { usage }),
          ...(context === undefined ? {} : { context }),
          ...(parsed === undefined ? {} : { providerFinishReason: parsed.providerFinishReason }),
          reasoning,
          reasoningMissing: record.reasoningRef !== undefined && reasoning === undefined,
          text: parsed?.text,
          toolCalls: views,
        });
        break;
      }
      case 'UNIT_COMPLETED': {
        const request = submitted.get(record.requestId);
        if (request?.toolCallId === undefined) break;
        toolCalls += 1;
        const call = calls.get(request.toolCallId);
        const output =
          record.outputRef === undefined
            ? jsonText(record.output)
            : await readText(record.outputRef);
        const durationMs = millisBetween(request.at, record.at);
        place(inTurn, {
          kind: 'TOOL',
          seq: record.seq,
          at: record.at,
          agent: agentOf(request.agentRunId),
          toolName: call?.toolName ?? '未知工具',
          toolCallId: request.toolCallId,
          status: record.status,
          ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
          ...(durationMs === undefined ? {} : { durationMs }),
          args: call?.args,
          output,
          cut: record.fullRef !== undefined,
        });
        break;
      }
      case 'UNIT_INTERRUPTED':
        event(record, inTurn, '工具调用被打断', record.reason);
        break;
      case 'MODEL_ATTEMPT_FAILED':
        event(record, inTurn, '模型调用失败', String(record.reasonCode));
        break;
      case 'FEEDBACK':
        event(record, inTurn, `反馈给模型（${record.code}）`, record.message);
        break;
      case 'AUTHORIZATION_REQUESTED': {
        const index = place(inTurn, {
          kind: 'AUTHORIZATION',
          seq: record.seq,
          at: record.at,
          capability: record.capability,
          resolution: undefined,
        });
        authorizations.set(record.questionId, { turn: inTurn, index });
        break;
      }
      case 'AUTHORIZATION_DECIDED': {
        const asked = authorizations.get(record.questionId);
        const list = asked === undefined ? undefined : (asked.turn?.entries ?? outside);
        const before = asked === undefined ? undefined : list?.[asked.index];
        if (asked !== undefined && list !== undefined && before?.kind === 'AUTHORIZATION')
          list[asked.index] = { ...before, resolution: record.resolution };
        else
          place(inTurn, {
            kind: 'AUTHORIZATION',
            seq: record.seq,
            at: record.at,
            capability: record.capability,
            resolution: record.resolution,
          });
        break;
      }
      case 'RUN_PAUSED':
        event(record, inTurn, '暂停');
        break;
      case 'RUN_RESUMED':
        event(record, inTurn, '继续');
        break;
      case 'RUN_INTERRUPTED':
        event(record, inTurn, '运行被中断', record.reason);
        break;
      case 'WORKFLOW_RUN_ENDED':
        event(record, inTurn, '运行结束', record.closeReason);
        break;
      case 'TODOS_UPDATED':
        event(
          record,
          inTurn,
          `${agentOf(record.agentRunId)} 更新待办`,
          `共 ${String(record.counts.total)}，完成 ${String(record.counts.completed)}，进行中 ${String(record.counts.inProgress)}`,
        );
        break;
      case 'TOOL_RESULTS_PRUNED':
        event(record, inTurn, '修剪较大的工具结果', `${String(record.items.length)} 个`);
        break;
      case 'CONTEXT_COMPACTED':
        event(
          record,
          inTurn,
          '压缩上下文',
          `记录 ${String(record.fromSeq)} 至 ${String(record.toSeq)}`,
        );
        break;
      case 'CONTEXT_COMPACTION_REVOKED':
        event(record, inTurn, '撤销一次压缩', record.reason);
        break;
      case 'WORKSPACE_REVERTED':
        event(
          record,
          inTurn,
          '回退工作区',
          `${String(record.revertedTurnIds.length)} 轮${record.forced ? '，强制' : ''}`,
        );
        break;
      case 'WORKSPACE_DIVERGED':
        event(record, inTurn, '工作区被别处改动', `${String(record.files.length)} 个文件`);
        break;
      case 'PROJECT_FILE_LOADED':
        event(record, inTurn, '加载项目文件', record.path);
        break;
      case 'SESSION_FORKED':
        event(record, undefined, '从别的对话分出', record.fromSessionId);
        break;
      case 'LOG_TAIL_REPAIRED':
        event(record, undefined, '日志末尾被修复', `${String(record.truncatedBytes)} 字节`);
        break;
      case 'STALE_UNITS_SETTLED':
        event(
          record,
          undefined,
          '打开时结算了过期的调用',
          `${String(record.requestIds.length)} 个`,
        );
        break;
      default:
        break;
    }
  }

  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    ...(sandbox === undefined ? {} : { sandbox }),
    records: records.length,
    turns,
    outside,
    totals: { modelCalls, toolCalls, inputTokens, outputTokens, cacheHitTokens },
  };
}
