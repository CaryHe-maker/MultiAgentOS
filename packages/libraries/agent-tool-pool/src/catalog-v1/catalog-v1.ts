import { createHash } from 'node:crypto';
import {
  DefinitionStatusFileSchema,
  type DefinitionStatus,
  type DefinitionStatusFile,
  CATALOG_ERROR_CODES,
  DEFINITION_DRAFT_SCHEMAS_V1,
  DEFINITION_KINDS_V1,
  DEFINITION_SCHEMAS_V1,
  REPOSITORY_KINDS_V1,
  canonicalJson,
  createM1ProtocolRegistry,
  validate,
  type BoundaryContextV1,
  type DefinitionByKindV1,
  type DefinitionKindV1,
  type DefinitionRef,
  type DefinitionV1,
  type ExecutionKindV1,
  type ModuleError,
  type PinnedDefinitionRefV1,
  type PinnedDefinitionSetV1,
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
 * The catalog of `v1` definitions (Library/AgentToolPool). It reads the same directory as the M1
 * catalog and takes only `schemaVersion: v1`, so the two live side by side until S1-IN-1 removes
 * M1. Everything that can be wrong is found at load; lookups only fail for unknown versions.
 */

type Body = { [K in DefinitionKindV1]: Omit<DefinitionByKindV1[K], 'digest'> }[DefinitionKindV1];
type BodyOf<K extends DefinitionKindV1> = Omit<DefinitionByKindV1[K], 'digest'>;

interface Reference {
  readonly field: string;
  readonly kind: DefinitionKindV1;
  readonly ref: DefinitionRef;
}

const key = (kind: DefinitionKindV1, id: string, version: string) => `${kind}:${id}@${version}`;
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
  return createHash('sha256')
    .update(canonicalJson(replace(body)), 'utf8')
    .digest('hex');
}

const ORDER: readonly DefinitionKindV1[] = ['TOOL', 'PROMPT', 'MODEL', 'UNIT', 'AGENT', 'TEMPLATE'];
const registry = createM1ProtocolRegistry();

/** The contracts of each kind's Unit; a v1 Unit must name exactly these. */
const UNIT_CONTRACTS: { readonly [K in ExecutionKindV1]?: readonly [string, string] } = {
  REPOSITORY_ORIENT: ['context.RepositoryOrientInput.v1', 'context.RepositoryOrientOutput.v0'],
  REPOSITORY_SEARCH: ['context.RepositorySearchInput.v0', 'context.RepositorySearchOutput.v0'],
  REPOSITORY_LIST: ['executor.RepositoryListInput.v1', 'executor.RepositoryListOutput.v1'],
  FILE_READ: ['executor.FileReadInput.v0', 'executor.FileReadOutput.v0'],
  CONTEXT_ASSEMBLE: ['context.ContextAssembleInput.v1', 'context.ContextAssembleOutput.v1'],
  MODEL: ['executor.ModelCallInput.v1', 'executor.ModelCallOutput.v1'],
  MESSAGE_PUBLISH: ['kernel.unit.MessagePublishInput.v1', 'kernel.unit.MessagePublishOutput.v1'],
  REPORT_PUBLISH: ['kernel.unit.ReportPublishInput.v1', 'kernel.unit.ReportPublishOutput.v0'],
};
/** The arguments of each end action, as the model writes them. */
const END_CONTRACTS = {
  PUBLISH_REPLY: 'workflow.ReplyArgs.v1',
  PUBLISH_REPORT: 'workflow.AnalysisReportDraft.v0',
  HANDOFF: 'workflow.HandoffBrief.v0',
} as const;
/** Kernel's refusals mean the same for every Unit, so no definition may change them. */
const FIXED_CODES = ['USER_DECLINED', 'QUOTA_EXHAUSTED'];
const EFFORTS = ['none', 'low', 'high', 'max'] as const;
const REPOSITORY_KINDS: ReadonlySet<string> = new Set(REPOSITORY_KINDS_V1);
const contractOf = (ref: { readonly id: string; readonly version: string }) =>
  `${ref.id}.${ref.version}`;

export interface CatalogIndexV1 {
  readonly definitions: ReadonlyMap<string, DefinitionV1>;
  /** `status.yaml`; a version without an entry is ACTIVE. */
  readonly statuses: ReadonlyMap<string, DefinitionStatus>;
}

interface Entry {
  readonly origin: string;
  readonly body: Body;
  readonly declared?: string;
}

/** Takes the `v1` documents of a snapshot, checks them all and computes every digest. */
export function buildCatalogIndexV1(
  snapshot: SourceSnapshot,
):
  | { readonly ok: true; readonly index: CatalogIndexV1 }
  | { readonly ok: false; readonly issues: readonly CatalogIssue[] } {
  return analyze(snapshot, false);
}

/** Which documents to seal; empty when the catalog has issues. */
export interface SealPlanV1 {
  readonly patches: readonly SealPatch[];
  readonly issues: readonly CatalogIssue[];
}

/**
 * Decides which unsealed published versions get their digest written. A document that already
 * has one is never touched (a published definition is immutable, so a mismatch is reported,
 * not "fixed"), and a draft never gets one: its digest is computed at load.
 */
export function planSealV1(snapshot: SourceSnapshot): SealPlanV1 {
  const result = analyze(snapshot, true);
  return result.ok
    ? { patches: result.unsealed, issues: [] }
    : { patches: [], issues: result.issues };
}

function analyze(
  snapshot: SourceSnapshot,
  sealing: boolean,
):
  | { readonly ok: true; readonly index: CatalogIndexV1; readonly unsealed: SealPatch[] }
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
  const definitions = new Map<string, DefinitionV1>();
  for (const [entryKey, entry] of entries)
    definitions.set(
      entryKey,
      deepFreeze(structuredClone({ ...entry.body, digest: digests.get(entryKey) ?? '' })),
    );
  return { ok: true, index: { definitions, statuses }, unsealed };
}

/** The status overrides of M1 AgentToolPool: each names a loaded version, at most once. */
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
  const kind = DEFINITION_KINDS_V1.find((candidate) => candidate === content['kind']);
  if (kind === undefined) {
    report(
      document.origin,
      'DEFINITION_INVALID',
      `kind must be one of ${DEFINITION_KINDS_V1.join(', ')}`,
    );
    return;
  }
  const declared = 'digest' in content ? String(content['digest']) : undefined;
  const result = validate<Body>(
    declared === undefined ? DEFINITION_DRAFT_SCHEMAS_V1[kind] : DEFINITION_SCHEMAS_V1[kind],
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
  const get = <K extends DefinitionKindV1>(kind: K, ref: DefinitionRef): BodyOf<K> | undefined =>
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
        const declaresRead = body.protectedCapabilities.includes('repo.read');
        // Kernel decides on the declaration alone, so it must agree with the kind (Kernel/Core 5).
        if (REPOSITORY_KINDS.has(body.executionKind) !== declaresRead)
          report(
            origin,
            'UNIT_INVALID',
            `${body.executionKind} ${declaresRead ? 'must not' : 'must'} declare repo.read`,
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
            (tool.purpose !== 'UNIT' || contractOf(tool.parametersContract) !== actual[0])
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
  get: <K extends DefinitionKindV1>(kind: K, ref: DefinitionRef) => BodyOf<K> | undefined,
  report: (origin: string, code: CatalogIssueCode, message: string) => void,
): void {
  const units = body.unitRefs.flatMap((ref) => get('UNIT', ref) ?? []);
  const count = (kind: ExecutionKindV1) =>
    units.filter((unit) => unit.executionKind === kind).length;
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
        contractOf(tool.parametersContract) !== END_CONTRACTS[end.then])
    )
      report(
        origin,
        'AGENT_INVALID',
        `end tool ${end.toolRef.id} must be CONTROL with ${END_CONTRACTS[end.then]}`,
      );
  }
  if (body.limits.maxToolCallsPerRound > 0 && !units.some((unit) => unit.toolRefs.length > 0))
    report(origin, 'AGENT_INVALID', 'maxToolCallsPerRound > 0 needs a unit with a tool');
}

function checkTemplate(
  origin: string,
  body: BodyOf<'TEMPLATE'>,
  get: <K extends DefinitionKindV1>(kind: K, ref: DefinitionRef) => BodyOf<K> | undefined,
  report: (origin: string, code: CatalogIssueCode, message: string) => void,
): void {
  const nodes = new Map(body.nodes.map((node) => [node.name, node]));
  if (nodes.size !== body.nodes.length)
    report(origin, 'TEMPLATE_INVALID', 'node names must be unique');
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

/** The v1 CatalogPort: lookups and run pinning over a validated, frozen index. */
export class DefinitionCatalogV1 {
  static async load(source: DefinitionSource): Promise<DefinitionCatalogV1> {
    const result = buildCatalogIndexV1(await source.load());
    if (!result.ok) throw new CatalogLoadError(result.issues);
    return new DefinitionCatalogV1(result.index);
  }

  public constructor(private readonly index: CatalogIndexV1) {}

  /** Every definition that can be looked up, in load order. */
  list(): readonly DefinitionV1[] {
    return [...this.index.definitions].flatMap(([entryKey, definition]) => {
      const status = this.index.statuses.get(entryKey);
      return status !== undefined && UNAVAILABLE.has(status) ? [] : [definition];
    });
  }

  /** The highest version of `id`, by its numeric parts; undefined when there is none. */
  latest<K extends DefinitionKindV1>(kind: K, id: string): DefinitionByKindV1[K] | undefined {
    const versions = this.list().filter((each) => each.kind === kind && each.id === id);
    const parts = (version: string) => version.slice(1).split('.').map(Number);
    const newer = (a: string, b: string) => {
      const [x, y] = [parts(a), parts(b)];
      for (let index = 0; index < 3; index += 1)
        if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) > (y[index] ?? 0);
      return false;
    };
    return versions.reduce<DefinitionV1 | undefined>(
      (best, each) => (best === undefined || newer(each.version, best.version) ? each : best),
      undefined,
    ) as DefinitionByKindV1[K] | undefined;
  }

  #find<K extends DefinitionKindV1>(
    kind: K,
    ref: DefinitionRef,
  ): DefinitionByKindV1[K] | undefined {
    const found = key(kind, ref.id, ref.version);
    const status = this.index.statuses.get(found);
    if (status !== undefined && UNAVAILABLE.has(status)) return undefined;
    return this.index.definitions.get(found) as DefinitionByKindV1[K] | undefined;
  }

  getDefinition<K extends DefinitionKindV1>(
    kind: K,
    ref: DefinitionRef,
    context: BoundaryContextV1,
  ): PortResult<DefinitionByKindV1[K]> {
    const found = this.#find(kind, ref);
    return found === undefined
      ? failure(`no ${kind} ${ref.id}@${ref.version}`, context)
      : { ok: true, value: found };
  }

  template(ref: DefinitionRef, context: BoundaryContextV1): PortResult<TemplateDefinition> {
    return this.getDefinition('TEMPLATE', ref, context);
  }

  /** Everything one AgentRun runs with, by exact version. */
  pinAgent(ref: DefinitionRef, context: BoundaryContextV1): PortResult<PinnedDefinitionSetV1> {
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
    ];
    const tools = toolRefs.flatMap((toolRef) => this.#find('TOOL', toolRef) ?? []);
    const members: DefinitionV1[] = [agent, model, prompt, ...pinnedUnits, ...tools];
    const refs: PinnedDefinitionRefV1[] = members.map(({ kind, id, version, digest }) => ({
      kind,
      id,
      version,
      digest,
    }));
    const pinned: PinnedDefinitionSetV1 = {
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
  context: BoundaryContextV1,
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
