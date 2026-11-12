import {
  DefinitionStatusFileSchema,
  type DefinitionStatus,
  type DefinitionStatusFile,
  CATALOG_ERROR_CODES,
  DEFINITION_DRAFT_SCHEMAS,
  DEFINITION_KINDS,
  DEFINITION_SCHEMAS,
  COMMAND_KINDS,
  EXTERNAL_READ_KINDS,
  REPOSITORY_KINDS,
  WRITE_KINDS,
  agentMinShare,
  canonicalJson,
  createProtocolRegistry,
  sha256Hex,
  validate,
  type BoundaryContext,
  type DefinitionByKind,
  type DefinitionKind,
  type DefinitionRef,
  type Definition,
  type ExecutionKind,
  type ModuleError,
  type PinnedDefinitionRef,
  type PinnedDefinitionSet,
  type PortResult,
  type TemplateDefinition,
} from '@multiagentos/contracts';
import type { CatalogIssue, CatalogIssueCode } from '../domain/catalog-issue.js';
import { CatalogLoadError } from '../domain/catalog-issue.js';
import { deepFreeze } from '../domain/deep-freeze.js';
import type {
  DefinitionSource,
  SealPatch,
  SourceDocument,
  SourceSnapshot,
} from '../ports/definition-source.js';

/**
 * The catalog of definitions (Library/AgentToolPool). Everything that can be wrong is found at
 * load; lookups only fail for unknown versions.
 */

type Body = { [K in DefinitionKind]: Omit<DefinitionByKind[K], 'digest'> }[DefinitionKind];
type BodyOf<K extends DefinitionKind> = Omit<DefinitionByKind[K], 'digest'>;

interface Reference {
  readonly field: string;
  readonly kind: DefinitionKind;
  readonly ref: DefinitionRef;
}

const key = (kind: DefinitionKind, id: string, version: string) => `${kind}:${id}@${version}`;
const isDraft = (version: string) => version.startsWith('v0.');

/** Where references live, in a fixed order; the digest covers each target's digest. */
function referencesOf(body: Body): readonly Reference[] {
  switch (body.kind) {
    case 'AGENT':
      return [
        { field: 'modelRef', kind: 'MODEL', ref: body.modelRef },
        { field: 'promptRef', kind: 'PROMPT', ref: body.promptRef },
        ...body.unitRefs.map((ref, index) => ({
          field: `unitRefs[${String(index)}]`,
          kind: 'UNIT' as const,
          ref,
        })),
        ...body.actions.end.map((end, index) => ({
          field: `actions.end[${String(index)}].toolRef`,
          kind: 'TOOL' as const,
          ref: end.toolRef,
        })),
        ...(
          ['todos', 'spawn', 'askUser', 'sleep', 'message', 'viewTasks', 'stop'] as const
        ).flatMap((action) => {
          const declared = body.actions[action];
          return declared === undefined
            ? []
            : [
                {
                  field: `actions.${action}.toolRef`,
                  kind: 'TOOL' as const,
                  ref: declared.toolRef,
                },
              ];
        }),
      ];
    case 'UNIT':
      return body.toolRefs.map((ref, index) => ({
        field: `toolRefs[${String(index)}]`,
        kind: 'TOOL' as const,
        ref,
      }));
    case 'TEMPLATE':
      return body.nodes.flatMap((node, index) =>
        node.kind === 'AGENT'
          ? [{ field: `nodes[${String(index)}].agent`, kind: 'AGENT' as const, ref: node.agent }]
          : [],
      );
    default:
      return [];
  }
}

/** SHA-256 of the canonical JSON, with each reference replaced by its target's digest. */
function digestOf(body: Body, digests: ReadonlyMap<string, string>): string | undefined {
  const pinned = new Map<string, string>();
  for (const { kind, ref } of referencesOf(body)) {
    const digest = digests.get(key(kind, ref.id, ref.version));
    if (digest === undefined) return undefined;
    pinned.set(`${ref.id}@${ref.version}`, digest);
  }
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    const ref = `${String(record['id'])}@${String(record['version'])}`;
    if (Object.keys(record).length === 2 && pinned.has(ref))
      return { ...record, digest: pinned.get(ref) };
    return Object.fromEntries(
      Object.entries(record).map(([field, inner]) => [field, replace(inner)]),
    );
  };
  return sha256Hex(canonicalJson(replace(body)));
}

const ORDER: readonly DefinitionKind[] = ['TOOL', 'PROMPT', 'MODEL', 'UNIT', 'AGENT', 'TEMPLATE'];
const registry = createProtocolRegistry();

/** The contracts of each kind's Unit; a Unit must name exactly these. */
const UNIT_CONTRACTS: { readonly [K in ExecutionKind]?: readonly [string, string] } = {
  REPOSITORY_ORIENT: ['context.RepositoryOrientInput.v1', 'context.RepositoryOrientOutput.v1'],
  REPOSITORY_SEARCH: ['context.RepositorySearchInput.v1', 'context.RepositorySearchOutput.v1'],
  REPOSITORY_LIST: ['executor.RepositoryListInput.v1', 'executor.RepositoryListOutput.v1'],
  FILE_READ: ['executor.FileReadInput.v1', 'executor.FileReadOutput.v1'],
  FILE_WRITE: ['executor.FileWriteInput.v1', 'executor.FileWriteOutput.v1'],
  FILE_EDIT: ['executor.FileEditInput.v1', 'executor.FileWriteOutput.v1'],
  OUTPUT_READ: ['executor.OutputReadInput.v1', 'executor.OutputReadOutput.v1'],
  COMMAND: ['executor.CommandInput.v1', 'executor.CommandOutput.v1'],
  GIT_INSPECT: ['executor.GitInspectInput.v1', 'executor.GitInspectOutput.v1'],
  WEB_SEARCH: ['executor.WebSearchInput.v1', 'executor.WebSearchOutput.v1'],
  WEB_FETCH: ['executor.WebFetchInput.v1', 'executor.WebFetchOutput.v1'],
  CONTEXT_ASSEMBLE: ['context.ContextAssembleInput.v1', 'context.ContextAssembleOutput.v1'],
  MODEL: ['executor.ModelCallInput.v1', 'executor.ModelCallOutput.v1'],
  MESSAGE_PUBLISH: ['kernel.unit.MessagePublishInput.v1', 'kernel.unit.MessagePublishOutput.v1'],
  REPORT_PUBLISH: ['kernel.unit.ReportPublishInput.v1', 'kernel.unit.ReportPublishOutput.v1'],
};
/** Where Workflow fills in part of the input, the tool's parameters are the rest (AgentToolPool 5). */
const TOOL_ARGUMENTS: { readonly [K in ExecutionKind]?: string } = {
  FILE_WRITE: 'executor.FileWriteArgs.v1',
  FILE_EDIT: 'executor.FileEditArgs.v1',
  OUTPUT_READ: 'executor.OutputReadArgs.v1',
  COMMAND: 'executor.RunCommandArgs.v1',
};
/** The arguments of each end action, as the model writes them. */
const END_CONTRACTS: Readonly<
  Record<'PUBLISH_REPLY' | 'PUBLISH_REPORT' | 'HANDOFF' | 'FINISH_SUBAGENT', readonly string[]>
> = {
  PUBLISH_REPLY: ['workflow.ReplyArgs.v1'],
  PUBLISH_REPORT: ['workflow.AnalysisReportDraft.v1'],
  HANDOFF: ['workflow.HandoffBrief.v1'],
  // Each spawnable Agent declares the result it returns (M2Design 3.7).
  FINISH_SUBAGENT: ['workflow.ExplorerResult.v1', 'workflow.WorkerResult.v1'],
};
/** Kernel's refusals mean the same for every Unit, so no definition may change them. */
const FIXED_CODES = [
  'USER_DECLINED',
  'QUOTA_EXHAUSTED',
  'CAPABILITY_NOT_GRANTED',
  'ADMISSION_CHECK_FAILED',
];
const EFFORTS = ['none', 'low', 'high', 'max'] as const;
const READS_REPOSITORY: ReadonlySet<string> = new Set(REPOSITORY_KINDS);
const EXTERNAL_KINDS: ReadonlySet<string> = new Set(EXTERNAL_READ_KINDS);
const WRITES_WORKSPACE: ReadonlySet<string> = new Set(WRITE_KINDS);
const RUNS_COMMANDS: ReadonlySet<string> = new Set(COMMAND_KINDS);
const contractOf = (ref: { readonly id: string; readonly version: string }) =>
  `${ref.id}.${ref.version}`;

export interface CatalogIndex {
  readonly definitions: ReadonlyMap<string, Definition>;
  /** `status.yaml`; a version without an entry is ACTIVE. */
  readonly statuses: ReadonlyMap<string, DefinitionStatus>;
}

interface Entry {
  readonly origin: string;
  readonly body: Body;
  readonly declared?: string;
}

/** Checks every document of a snapshot and computes every digest. */
export function buildCatalogIndex(
  snapshot: SourceSnapshot,
):
  | { readonly ok: true; readonly index: CatalogIndex }
  | { readonly ok: false; readonly issues: readonly CatalogIssue[] } {
  return analyze(snapshot, false);
}

/** Which documents to seal; empty when the catalog has issues. */
export interface SealPlan {
  readonly patches: readonly SealPatch[];
  readonly issues: readonly CatalogIssue[];
}

/**
 * Decides which unsealed published versions get their digest written. A document that already
 * has one is never touched (a published definition is immutable, so a mismatch is reported,
 * not "fixed"), and a draft never gets one: its digest is computed at load.
 */
export function planSeal(snapshot: SourceSnapshot): SealPlan {
  const result = analyze(snapshot, true);
  return result.ok
    ? { patches: result.unsealed, issues: [] }
    : { patches: [], issues: result.issues };
}

function analyze(
  snapshot: SourceSnapshot,
  sealing: boolean,
):
  | { readonly ok: true; readonly index: CatalogIndex; readonly unsealed: SealPatch[] }
  | { readonly ok: false; readonly issues: readonly CatalogIssue[] } {
  const unsealed: SealPatch[] = [];
  const issues: CatalogIssue[] = [];
  const report = (origin: string, code: CatalogIssueCode, message: string) =>
    issues.push({ origin, code, message });
  const entries = new Map<string, Entry>();
  for (const document of snapshot.documents) parse(document, entries, report);

  const digests = new Map<string, string>();
  const failed = new Set<string>();
  for (const kind of ORDER)
    for (const [entryKey, entry] of entries) {
      if (entry.body.kind !== kind) continue;
      let broken = false;
      for (const { field, kind: target, ref } of referencesOf(entry.body)) {
        const targetKey = key(target, ref.id, ref.version);
        if (!entries.has(targetKey))
          report(entry.origin, 'REFERENCE_MISSING', `${field} points to unknown ${targetKey}`);
        else if (!isDraft(entry.body.version) && isDraft(ref.version))
          report(entry.origin, 'REFERENCE_UNSTABLE', `${field} points to draft ${targetKey}`);
        else if (failed.has(targetKey))
          report(
            entry.origin,
            'REFERENCE_INVALID',
            `${field} points to ${targetKey}, which has issues`,
          );
        else continue;
        broken = true;
      }
      const digest = broken ? undefined : digestOf(entry.body, digests);
      if (digest === undefined) {
        failed.add(entryKey);
        continue;
      }
      if (entry.declared !== undefined && entry.declared !== digest) {
        report(
          entry.origin,
          'DIGEST_MISMATCH',
          `declared ${entry.declared} but content hashes to ${digest}`,
        );
        failed.add(entryKey);
        continue;
      }
      if (entry.declared === undefined && !isDraft(entry.body.version)) {
        if (sealing) unsealed.push({ origin: entry.origin, digest });
        else report(entry.origin, 'DEFINITION_UNSEALED', `missing digest (computed ${digest})`);
      }
      digests.set(entryKey, digest);
    }
  if (failed.size === 0) checkRules(entries, report);
  const statuses = parseStatuses(snapshot.statusDocument, entries, report);
  if (issues.length > 0) return { ok: false, issues };
  const definitions = new Map<string, Definition>();
  for (const [entryKey, entry] of entries)
    definitions.set(
      entryKey,
      deepFreeze(structuredClone({ ...entry.body, digest: digests.get(entryKey) ?? '' })),
    );
  return { ok: true, index: { definitions, statuses }, unsealed };
}

/** The status overrides: each names a loaded version, at most once. */
function parseStatuses(
  document: SourceDocument | undefined,
  entries: ReadonlyMap<string, Entry>,
  report: (origin: string, code: CatalogIssueCode, message: string) => void,
): ReadonlyMap<string, DefinitionStatus> {
  const statuses = new Map<string, DefinitionStatus>();
  if (document === undefined) return statuses;
  const result = validate<DefinitionStatusFile>(DefinitionStatusFileSchema, document.content);
  if (!result.ok) {
    report(document.origin, 'STATUS_INVALID', result.issues.join('; '));
    return statuses;
  }
  for (const entry of result.value.entries) {
    const entryKey = key(entry.kind, entry.id, entry.version);
    if (!entries.has(entryKey))
      report(document.origin, 'STATUS_INVALID', `status set for unknown ${entryKey}`);
    else if (statuses.has(entryKey))
      report(document.origin, 'STATUS_INVALID', `status set twice for ${entryKey}`);
    else statuses.set(entryKey, entry.status);
  }
  return statuses;
}

/** A QUARANTINED or REVOKED version can be neither looked up nor pinned. */
const UNAVAILABLE: ReadonlySet<DefinitionStatus> = new Set(['QUARANTINED', 'REVOKED']);

function parse(
  document: SourceDocument,
  entries: Map<string, Entry>,
  report: (origin: string, code: CatalogIssueCode, message: string) => void,
): void {
  const content = document.content as Readonly<Record<string, unknown>> | null;
  if (typeof content !== 'object' || content === null || content['schemaVersion'] !== 'v1') return;
  const kind = DEFINITION_KINDS.find((candidate) => candidate === content['kind']);
  if (kind === undefined) {
    report(
      document.origin,
      'DEFINITION_INVALID',
      `kind must be one of ${DEFINITION_KINDS.join(', ')}`,
    );
    return;
  }
  const declared = 'digest' in content ? String(content['digest']) : undefined;
  const result = validate<Body>(
    declared === undefined ? DEFINITION_DRAFT_SCHEMAS[kind] : DEFINITION_SCHEMAS[kind],
    content,
  );
  if (!result.ok) {
    report(document.origin, 'DEFINITION_INVALID', result.issues.join('; '));
    return;
  }
  const body = Object.fromEntries(
    Object.entries(result.value).filter(([field]) => field !== 'digest'),
  ) as Body;
  if (declared !== undefined && isDraft(body.version)) {
    report(
      document.origin,
      'DEFINITION_INVALID',
      `${body.version} is a draft version: remove \`digest\``,
    );
    return;
  }
  const entryKey = key(body.kind, body.id, body.version);
  const previous = entries.get(entryKey);
  if (previous !== undefined) {
    report(
      document.origin,
      'DEFINITION_DUPLICATE',
      `${entryKey} is also defined in ${previous.origin}`,
    );
    return;
  }
  entries.set(entryKey, {
    origin: document.origin,
    body,
    ...(declared === undefined ? {} : { declared }),
  });
}

/** The rules of AgentToolPool 4 that a Schema cannot express. */
function checkRules(
  entries: ReadonlyMap<string, Entry>,
  report: (origin: string, code: CatalogIssueCode, message: string) => void,
): void {
  const get = <K extends DefinitionKind>(kind: K, ref: DefinitionRef): BodyOf<K> | undefined =>
    entries.get(key(kind, ref.id, ref.version))?.body as BodyOf<K> | undefined;
  const owners = new Map<string, number>();
  for (const { body } of entries.values())
    if (body.kind === 'UNIT')
      for (const ref of body.toolRefs) {
        const toolKey = key('TOOL', ref.id, ref.version);
        owners.set(toolKey, (owners.get(toolKey) ?? 0) + 1);
      }

  for (const { origin, body } of entries.values()) {
    switch (body.kind) {
      case 'TOOL': {
        if (!registry.has(contractOf(body.parametersContract)))
          report(
            origin,
            'CONTRACT_UNKNOWN',
            `parametersContract ${contractOf(body.parametersContract)} is not registered`,
          );
        const count = owners.get(key('TOOL', body.id, body.version)) ?? 0;
        if (body.purpose === 'UNIT' && count !== 1)
          report(
            origin,
            'TOOL_INVALID',
            `a UNIT tool must belong to exactly one unit, found ${String(count)}`,
          );
        if (body.purpose === 'CONTROL' && count > 0)
          report(origin, 'TOOL_INVALID', 'a CONTROL tool must not be referenced by a unit');
        break;
      }
      case 'UNIT': {
        const expected = UNIT_CONTRACTS[body.executionKind];
        const actual = [contractOf(body.inputContract), contractOf(body.outputContract)];
        if (expected !== undefined && (actual[0] !== expected[0] || actual[1] !== expected[1]))
          report(
            origin,
            'UNIT_INVALID',
            `${body.executionKind} must use ${expected.join(' and ')}`,
          );
        const declaresRepoRead = body.protectedCapabilities.includes('repo.read');
        const declaresExternal = body.protectedCapabilities.includes('external.read');
        // Kernel decides on the declaration alone, so it must agree with the kind (Kernel/Core 5).
        // Three kinds also read outside the workspace, with `external.read` in place of `repo.read`.
        const declaresRead = declaresRepoRead || declaresExternal;
        if (READS_REPOSITORY.has(body.executionKind) !== declaresRead)
          report(
            origin,
            'UNIT_INVALID',
            `${body.executionKind} ${declaresRead ? 'must not' : 'must'} declare repo.read`,
          );
        if (declaresRepoRead && declaresExternal)
          report(origin, 'UNIT_INVALID', 'a unit declares repo.read or external.read, not both');
        if (declaresExternal && !EXTERNAL_KINDS.has(body.executionKind))
          report(origin, 'UNIT_INVALID', `${body.executionKind} cannot declare external.read`);
        const declaresWrite = body.protectedCapabilities.includes('workspace.write');
        if (WRITES_WORKSPACE.has(body.executionKind) !== declaresWrite)
          report(
            origin,
            'UNIT_INVALID',
            `${body.executionKind} ${declaresWrite ? 'must not' : 'must'} declare workspace.write`,
          );
        const declaresCommand = body.protectedCapabilities.includes('command.exec');
        if (RUNS_COMMANDS.has(body.executionKind) !== declaresCommand)
          report(
            origin,
            'UNIT_INVALID',
            `${body.executionKind} ${declaresCommand ? 'must not' : 'must'} declare command.exec`,
          );
        if (body.toolRefs.length > 1) report(origin, 'UNIT_INVALID', 'a unit has at most one tool');
        if (
          body.executionKind === 'MESSAGE_PUBLISH' &&
          (body.toolRefs.length > 0 || body.protectedCapabilities.length > 0)
        )
          report(origin, 'UNIT_INVALID', 'MESSAGE_PUBLISH has no tool and no protected capability');
        for (const ref of body.toolRefs) {
          const tool = get('TOOL', ref);
          if (
            tool !== undefined &&
            (tool.purpose !== 'UNIT' ||
              contractOf(tool.parametersContract) !==
                (TOOL_ARGUMENTS[body.executionKind] ?? actual[0]))
          )
            report(
              origin,
              'UNIT_INVALID',
              `tool ${ref.id} must be a UNIT tool with the unit input as parameters`,
            );
        }
        for (const code of FIXED_CODES)
          if (code in body.failurePolicy)
            report(
              origin,
              'UNIT_INVALID',
              `failurePolicy must not list ${code}: Workflow handles it the same for every unit`,
            );
        break;
      }
      case 'MODEL': {
        const efforts = body.features.thinking.effortMapping.map((entry) => entry.effort);
        if (
          efforts.length !== EFFORTS.length ||
          EFFORTS.some((effort) => !efforts.includes(effort))
        )
          report(
            origin,
            'MODEL_SETTINGS_INVALID',
            'effortMapping must cover none, low, high and max once each',
          );
        break;
      }
      case 'AGENT':
        checkAgent(origin, body, get, report);
        break;
      case 'TEMPLATE':
        checkTemplate(origin, body, get, report);
        break;
      default:
        break;
    }
  }
}

function checkAgent(
  origin: string,
  body: BodyOf<'AGENT'>,
  get: <K extends DefinitionKind>(kind: K, ref: DefinitionRef) => BodyOf<K> | undefined,
  report: (origin: string, code: CatalogIssueCode, message: string) => void,
): void {
  const units = body.unitRefs.flatMap((ref) => get('UNIT', ref) ?? []);
  const count = (kind: ExecutionKind) => units.filter((unit) => unit.executionKind === kind).length;
  for (const kind of ['CONTEXT_ASSEMBLE', 'MODEL'] as const)
    if (count(kind) !== 1)
      report(
        origin,
        'AGENT_INVALID',
        `needs exactly one ${kind} unit, found ${String(count(kind))}`,
      );
  const thens = new Set(body.actions.end.map((end) => end.then));
  const needsMessage = thens.has('PUBLISH_REPLY') || body.actions.onDegraded === 'PUBLISH_NOTICE';
  const needsReport = thens.has('PUBLISH_REPORT') || body.actions.onDegraded === 'PUBLISH_REPORT';
  if (count('MESSAGE_PUBLISH') !== (needsMessage ? 1 : 0))
    report(
      origin,
      'AGENT_INVALID',
      `needs ${needsMessage ? 'exactly one' : 'no'} MESSAGE_PUBLISH unit`,
    );
  if (count('REPORT_PUBLISH') !== (needsReport ? 1 : 0))
    report(
      origin,
      'AGENT_INVALID',
      `needs ${needsReport ? 'exactly one' : 'no'} REPORT_PUBLISH unit`,
    );
  const unitKeys = new Set(body.unitRefs.map((ref) => `${ref.id}@${ref.version}`));
  for (const ref of body.startUnitRefs)
    if (
      !unitKeys.has(`${ref.id}@${ref.version}`) ||
      get('UNIT', ref)?.executionKind !== 'REPOSITORY_ORIENT'
    )
      report(
        origin,
        'AGENT_INVALID',
        `start unit ${ref.id} must be a REPOSITORY_ORIENT unit of this agent`,
      );

  const { allowedEfforts, defaultEffort } = body.thinking;
  if (!allowedEfforts.includes(defaultEffort))
    report(origin, 'AGENT_INVALID', 'allowedEfforts must contain defaultEffort');
  const model = get('MODEL', body.modelRef);
  if (model !== undefined) {
    if (
      !model.features.thinking.isSupported &&
      (allowedEfforts.length !== 1 || allowedEfforts[0] !== 'none')
    )
      report(
        origin,
        'MODEL_SETTINGS_INVALID',
        `${model.id} does not support thinking: allowedEfforts must be [none]`,
      );
    const mapped = new Set(model.features.thinking.effortMapping.map((entry) => entry.effort));
    for (const effort of allowedEfforts)
      if (!mapped.has(effort))
        report(origin, 'MODEL_SETTINGS_INVALID', `${model.id} has no mapping for ${effort}`);
  }

  const names = new Map<string, string>();
  const tools = [
    ...units.flatMap((unit) => unit.toolRefs.flatMap((ref) => get('TOOL', ref) ?? [])),
    ...[
      body.actions.todos,
      body.actions.spawn,
      body.actions.askUser,
      body.actions.sleep,
      body.actions.message,
      body.actions.viewTasks,
      body.actions.stop,
    ].flatMap((action) => (action === undefined ? [] : (get('TOOL', action.toolRef) ?? []))),
    ...body.actions.end.flatMap((end) => get('TOOL', end.toolRef) ?? []),
  ];
  for (const tool of tools) {
    const owner = `${tool.id}@${tool.version}`;
    const previous = names.get(tool.modelName);
    if (previous !== undefined && previous !== owner)
      report(
        origin,
        'TOOL_NAME_CONFLICT',
        `${previous} and ${owner} are both named ${tool.modelName}`,
      );
    names.set(tool.modelName, owner);
  }
  const endTools = new Set<string>();
  for (const end of body.actions.end) {
    const toolKey = `${end.toolRef.id}@${end.toolRef.version}`;
    if (endTools.has(toolKey))
      report(origin, 'AGENT_INVALID', `end tool ${end.toolRef.id} is declared twice`);
    endTools.add(toolKey);
    const tool = get('TOOL', end.toolRef);
    if (
      tool !== undefined &&
      (tool.purpose !== 'CONTROL' ||
        !END_CONTRACTS[end.then].includes(contractOf(tool.parametersContract)))
    )
      report(
        origin,
        'AGENT_INVALID',
        `end tool ${end.toolRef.id} must be CONTROL with ${END_CONTRACTS[end.then].join(' or ')}`,
      );
  }
  if (body.actions.todos !== undefined) {
    const tool = get('TOOL', body.actions.todos.toolRef);
    if (
      tool !== undefined &&
      (tool.purpose !== 'CONTROL' ||
        contractOf(tool.parametersContract) !== 'workflow.UpdateTodosArgs.v1')
    )
      report(origin, 'AGENT_INVALID', 'the todos tool must be CONTROL with UpdateTodosArgs');
  }
  if (body.actions.askUser !== undefined) {
    const tool = get('TOOL', body.actions.askUser.toolRef);
    if (
      tool !== undefined &&
      (tool.purpose !== 'CONTROL' ||
        contractOf(tool.parametersContract) !== 'workflow.AskUserArgs.v1')
    )
      report(origin, 'AGENT_INVALID', 'the ask_user tool must be CONTROL with AskUserArgs');
  }
  const controls = [
    ['sleep', 'workflow.SleepArgs.v1'],
    ['message', 'workflow.SendMessageArgs.v1'],
    ['viewTasks', 'workflow.ViewTasksArgs.v1'],
    ['stop', 'workflow.StopSubagentsArgs.v1'],
  ] as const;
  for (const [action, contract] of controls) {
    const declared = body.actions[action];
    if (declared === undefined) continue;
    const tool = get('TOOL', declared.toolRef);
    if (
      tool !== undefined &&
      (tool.purpose !== 'CONTROL' || contractOf(tool.parametersContract) !== contract)
    )
      report(origin, 'AGENT_INVALID', `the ${action} tool must be CONTROL with ${contract}`);
  }
  checkSpawn(origin, body, get, report);
  for (const unit of units)
    for (const capability of unit.protectedCapabilities)
      if (!body.capabilities.includes(capability))
        report(
          origin,
          'AGENT_INVALID',
          `unit ${unit.id} needs ${capability}, which is not declared`,
        );
  if (body.limits.maxToolCallsPerRound > 0 && !units.some((unit) => unit.toolRefs.length > 0))
    report(origin, 'AGENT_INVALID', 'maxToolCallsPerRound > 0 needs a unit with a tool');
}

/** The two sides of spawning: an Agent that starts SubAgents, and an Agent that is one (M2Design 3.6, 3.7). */
function checkSpawn(
  origin: string,
  body: BodyOf<'AGENT'>,
  get: <K extends DefinitionKind>(kind: K, ref: DefinitionRef) => BodyOf<K> | undefined,
  report: (origin: string, code: CatalogIssueCode, message: string) => void,
): void {
  const spawns = body.capabilities.includes('agent.spawn');
  if (spawns !== (body.actions.spawn !== undefined))
    report(origin, 'AGENT_INVALID', 'agent.spawn and actions.spawn go together');
  if (body.actions.spawn !== undefined) {
    const tool = get('TOOL', body.actions.spawn.toolRef);
    if (
      tool !== undefined &&
      (tool.purpose !== 'CONTROL' ||
        contractOf(tool.parametersContract) !== 'workflow.RunSubagentsArgs.v1')
    )
      report(origin, 'AGENT_INVALID', 'the spawn tool must be CONTROL with RunSubagentsArgs');
  }
  const finishes = body.actions.end.some((end) => end.then === 'FINISH_SUBAGENT');
  if (finishes !== (body.spawnable !== undefined))
    report(origin, 'AGENT_INVALID', 'spawnable and the FINISH_SUBAGENT end go together');
  if (body.spawnable === undefined) return;
  if (body.actions.end.some((end) => end.then !== 'FINISH_SUBAGENT'))
    report(origin, 'AGENT_INVALID', 'a spawnable Agent ends only with FINISH_SUBAGENT');
  if (body.actions.onDegraded !== 'RETURN_PARTIAL')
    report(origin, 'AGENT_INVALID', 'a spawnable Agent degrades with RETURN_PARTIAL');
  const least = agentMinShare(body.budget);
  if (body.spawnable.defaultShare < least)
    report(
      origin,
      'AGENT_INVALID',
      `defaultShare ${String(body.spawnable.defaultShare)} is below the least share ${String(least)}`,
    );
}

function checkTemplate(
  origin: string,
  body: BodyOf<'TEMPLATE'>,
  get: <K extends DefinitionKind>(kind: K, ref: DefinitionRef) => BodyOf<K> | undefined,
  report: (origin: string, code: CatalogIssueCode, message: string) => void,
): void {
  const nodes = new Map(body.nodes.map((node) => [node.name, node]));
  if (nodes.size !== body.nodes.length)
    report(origin, 'TEMPLATE_INVALID', 'node names must be unique');
  // The owner of a template is one Agent, whose steps are the nodes marked owner; its last step
  // is the output (Orchestration 3.5).
  const { owner } = body;
  const steps = body.nodes.filter((node) => node.kind === 'AGENT' && node.role === 'owner');
  if (owner === undefined && steps.length > 0)
    report(origin, 'TEMPLATE_INVALID', 'role owner needs the template to name its owner');
  if (owner !== undefined) {
    if (steps.length === 0) report(origin, 'TEMPLATE_INVALID', 'an owner needs at least one step');
    for (const step of steps)
      if (
        step.kind === 'AGENT' &&
        (step.agent.id !== owner.agent.id || step.agent.version !== owner.agent.version)
      )
        report(origin, 'TEMPLATE_INVALID', `${step.name} is a step of the owner, not of its Agent`);
    const outputs = body.nodes.filter((node) => node.kind === 'AGENT' && node.output === true);
    if (outputs.length !== 1 || outputs[0]?.kind !== 'AGENT' || outputs[0].role !== 'owner')
      report(origin, 'TEMPLATE_INVALID', 'exactly one output, and it is a step of the owner');
  }
  const edges = new Map<
    string,
    readonly { readonly node: string; readonly conditional: boolean }[]
  >();
  for (const node of body.nodes) {
    if (node.kind !== 'AGENT') continue;
    const dependencies = (node.dependsOn ?? []).map((dependency) =>
      typeof dependency === 'string'
        ? { node: dependency, conditional: false }
        : { node: dependency.node, conditional: true },
    );
    edges.set(node.name, dependencies);
    for (const dependency of dependencies) {
      if (!nodes.has(dependency.node))
        report(origin, 'TEMPLATE_INVALID', `${node.name} depends on unknown ${dependency.node}`);
      if (dependency.conditional && body.origin !== 'BUILTIN')
        report(
          origin,
          'TEMPLATE_INVALID',
          `${node.name}: conditional edges are for built-in templates only`,
        );
    }
    if (node.inputFrom === 'HANDOFF') {
      const source = dependencies.find((dependency) => {
        const before = nodes.get(dependency.node);
        if (!dependency.conditional || before?.kind !== 'AGENT') return false;
        return (
          get('AGENT', before.agent)?.actions.end.some((end) => end.then === 'HANDOFF') === true
        );
      });
      if (source === undefined)
        report(
          origin,
          'TEMPLATE_INVALID',
          `${node.name} takes a handoff, so it must depend conditionally on an agent that can hand off`,
        );
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (name: string): boolean => {
    if (done.has(name)) return false;
    if (visiting.has(name)) return true;
    visiting.add(name);
    const found = (edges.get(name) ?? []).some((dependency) => cyclic(dependency.node));
    visiting.delete(name);
    done.add(name);
    return found;
  };
  if (body.nodes.some((node) => cyclic(node.name)))
    report(origin, 'TEMPLATE_INVALID', 'dependencies form a cycle');
}

/** The CatalogPort: lookups and run pinning over a validated, frozen index. */
export class DefinitionCatalog {
  static async load(source: DefinitionSource): Promise<DefinitionCatalog> {
    const result = buildCatalogIndex(await source.load());
    if (!result.ok) throw new CatalogLoadError(result.issues);
    return new DefinitionCatalog(result.index);
  }

  public constructor(private readonly index: CatalogIndex) {}

  /** Every definition that can be looked up, in load order. */
  list(): readonly Definition[] {
    return [...this.index.definitions].flatMap(([entryKey, definition]) => {
      const status = this.index.statuses.get(entryKey);
      return status !== undefined && UNAVAILABLE.has(status) ? [] : [definition];
    });
  }

  /** The highest version of `id`, by its numeric parts; undefined when there is none. */
  latest<K extends DefinitionKind>(kind: K, id: string): DefinitionByKind[K] | undefined {
    const versions = this.list().filter((each) => each.kind === kind && each.id === id);
    const parts = (version: string) => version.slice(1).split('.').map(Number);
    const newer = (a: string, b: string) => {
      const [x, y] = [parts(a), parts(b)];
      for (let index = 0; index < 3; index += 1)
        if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) > (y[index] ?? 0);
      return false;
    };
    return versions.reduce<Definition | undefined>(
      (best, each) => (best === undefined || newer(each.version, best.version) ? each : best),
      undefined,
    ) as DefinitionByKind[K] | undefined;
  }

  #find<K extends DefinitionKind>(kind: K, ref: DefinitionRef): DefinitionByKind[K] | undefined {
    const found = key(kind, ref.id, ref.version);
    const status = this.index.statuses.get(found);
    if (status !== undefined && UNAVAILABLE.has(status)) return undefined;
    return this.index.definitions.get(found) as DefinitionByKind[K] | undefined;
  }

  getDefinition<K extends DefinitionKind>(
    kind: K,
    ref: DefinitionRef,
    context: BoundaryContext,
  ): PortResult<DefinitionByKind[K]> {
    const found = this.#find(kind, ref);
    return found === undefined
      ? failure(`no ${kind} ${ref.id}@${ref.version}`, context)
      : { ok: true, value: found };
  }

  template(ref: DefinitionRef, context: BoundaryContext): PortResult<TemplateDefinition> {
    return this.getDefinition('TEMPLATE', ref, context);
  }

  /** Everything one AgentRun runs with, by exact version. */
  pinAgent(ref: DefinitionRef, context: BoundaryContext): PortResult<PinnedDefinitionSet> {
    const agent = this.#find('AGENT', ref);
    if (agent === undefined) return failure(`no AGENT ${ref.id}@${ref.version}`, context);
    const model = this.#find('MODEL', agent.modelRef);
    const prompt = this.#find('PROMPT', agent.promptRef);
    const units = agent.unitRefs.map((unitRef) => this.#find('UNIT', unitRef));
    if (model === undefined || prompt === undefined || units.some((unit) => unit === undefined))
      return failure(`cannot pin ${ref.id}@${ref.version}`, context);
    const pinnedUnits = units.flatMap((unit) => (unit === undefined ? [] : [unit]));
    const toolRefs = [
      ...pinnedUnits.flatMap((unit) => unit.toolRefs),
      ...agent.actions.end.map((end) => end.toolRef),
      ...(agent.actions.todos === undefined ? [] : [agent.actions.todos.toolRef]),
      ...(agent.actions.spawn === undefined ? [] : [agent.actions.spawn.toolRef]),
      ...(agent.actions.askUser === undefined ? [] : [agent.actions.askUser.toolRef]),
      ...(agent.actions.sleep === undefined ? [] : [agent.actions.sleep.toolRef]),
      ...(agent.actions.message === undefined ? [] : [agent.actions.message.toolRef]),
      ...(agent.actions.viewTasks === undefined ? [] : [agent.actions.viewTasks.toolRef]),
      ...(agent.actions.stop === undefined ? [] : [agent.actions.stop.toolRef]),
    ];
    const tools = toolRefs.flatMap((toolRef) => this.#find('TOOL', toolRef) ?? []);
    const members: Definition[] = [agent, model, prompt, ...pinnedUnits, ...tools];
    const refs: PinnedDefinitionRef[] = members.map(({ kind, id, version, digest }) => ({
      kind,
      id,
      version,
      digest,
    }));
    const pinned: PinnedDefinitionSet = {
      schemaVersion: 'v1',
      agent: agent,
      model,
      prompt,
      units: pinnedUnits,
      tools,
      refs,
    };
    return { ok: true, value: deepFreeze(pinned) };
  }
}

function failure(
  message: string,
  context: BoundaryContext,
): { readonly ok: false; readonly error: ModuleError } {
  return {
    ok: false,
    error: {
      code: CATALOG_ERROR_CODES.versionNotFound,
      category: 'VALIDATION',
      message,
      retryable: false,
      correlationId: context.correlationId,
    },
  };
}
