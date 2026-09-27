import {
  DEFINITION_DRAFT_SCHEMAS,
  DEFINITION_KINDS,
  DEFINITION_SCHEMAS,
  DefinitionStatusFileSchema,
  validate,
  type Definition,
  type DefinitionKind,
  type DefinitionStatus,
  type DefinitionStatusFile,
  type PromptDefinition,
  type ToolDefinition,
  type UnitDefinition,
} from '@multiagentos/contracts';
import type { SealPatch, SourceDocument, SourceSnapshot } from '../ports/definition-source.js';
import type { CatalogIssue, CatalogIssueCode } from './catalog-issue.js';
import { deepFreeze } from './deep-freeze.js';
import {
  computeDefinitionDigest,
  definitionKey,
  outgoingReferences,
  type DefinitionBody,
} from './definition-digest.js';

/** Validated, sealed, frozen catalog content. Built once at startup and never changed. */
export interface CatalogIndex {
  /** Keyed by `definitionKey(kind, id, version)`. */
  readonly definitions: ReadonlyMap<string, Definition>;
  /** Only non-ACTIVE entries; a missing key means ACTIVE. */
  readonly statuses: ReadonlyMap<string, DefinitionStatus>;
}

export type CatalogBuildResult =
  | { readonly ok: true; readonly index: CatalogIndex }
  | { readonly ok: false; readonly issues: readonly CatalogIssue[] };

export interface SealPlan {
  readonly patches: readonly SealPatch[];
  /** Non-empty means nothing may be written. */
  readonly issues: readonly CatalogIssue[];
}

/** Builds the runtime index; fails on any issue, including unsealed drafts. */
export function buildCatalogIndex(snapshot: SourceSnapshot): CatalogBuildResult {
  const analysis = analyze(snapshot);
  const unsealed = analysis.entries
    .filter((entry) => entry.declaredDigest === undefined)
    .map((entry) =>
      issue(
        entry.origin,
        'DEFINITION_UNSEALED',
        `missing digest (computed ${entry.computedDigest}); run \`pnpm run catalog:seal\``,
      ),
    );
  const issues = [...analysis.issues, ...unsealed];
  if (issues.length > 0) return { ok: false, issues };
  const definitions = new Map<string, Definition>();
  for (const entry of analysis.entries)
    definitions.set(
      entry.key,
      deepFreeze(structuredClone({ ...entry.body, digest: entry.computedDigest })),
    );
  return { ok: true, index: { definitions, statuses: analysis.statuses } };
}

/**
 * Decides which drafts get a digest. Never touches a document that already has one: a
 * published definition is immutable, so a mismatch is reported, not "fixed".
 */
export function planSeal(snapshot: SourceSnapshot): SealPlan {
  const analysis = analyze(snapshot);
  if (analysis.issues.length > 0) return { patches: [], issues: analysis.issues };
  const patches = analysis.entries
    .filter((entry) => entry.declaredDigest === undefined)
    .map((entry) => ({ origin: entry.origin, digest: entry.computedDigest }));
  return { patches, issues: [] };
}

interface AnalyzedEntry {
  readonly origin: string;
  readonly key: string;
  readonly body: DefinitionBody;
  readonly declaredDigest: string | undefined;
  readonly computedDigest: string;
}

interface Analysis {
  readonly entries: readonly AnalyzedEntry[];
  readonly statuses: ReadonlyMap<string, DefinitionStatus>;
  readonly issues: readonly CatalogIssue[];
}

interface ParsedDocument {
  readonly origin: string;
  readonly key: string;
  readonly body: DefinitionBody;
  readonly declaredDigest: string | undefined;
}

/**
 * Kinds in dependency order: a kind only references kinds earlier in this list, so one pass
 * computes every digest (and no reference cycle is possible).
 */
const DIGEST_ORDER: readonly DefinitionKind[] = ['TOOL', 'PROMPT', 'MODEL', 'UNIT', 'AGENT'];

function analyze(snapshot: SourceSnapshot): Analysis {
  const issues: CatalogIssue[] = [...snapshot.issues];
  const parsed = parseDocuments(snapshot.documents, issues);

  const computed = new Map<string, string>();
  const failed = new Set<string>();
  const entries: AnalyzedEntry[] = [];
  for (const kind of DIGEST_ORDER) {
    for (const document of parsed.filter((candidate) => candidate.body.kind === kind)) {
      const referenceIssues = checkReferences(document, parsed, failed);
      if (referenceIssues.length > 0) {
        issues.push(...referenceIssues);
        failed.add(document.key);
        continue;
      }
      const computedDigest = computeDefinitionDigest(document.body, (refKind, ref) =>
        computed.get(definitionKey(refKind, ref.id, ref.version)),
      );
      if (computedDigest === undefined) {
        failed.add(document.key);
        continue;
      }
      if (document.declaredDigest !== undefined && document.declaredDigest !== computedDigest) {
        issues.push(
          issue(
            document.origin,
            'DIGEST_MISMATCH',
            `declared ${document.declaredDigest} but content hashes to ${computedDigest}; ` +
              'published definitions are immutable, so restore the file and publish the ' +
              'change as a new version',
          ),
        );
        failed.add(document.key);
        continue;
      }
      computed.set(document.key, computedDigest);
      entries.push({ ...document, computedDigest });
    }
  }

  const bodies = new Map(entries.map((entry) => [entry.key, entry.body]));
  issues.push(...checkPromptVariables(entries), ...checkUnitEffects(entries, bodies));
  issues.push(...checkToolNames(entries, bodies));
  const statuses = parseStatuses(snapshot.statusDocument, bodies, issues);
  return { entries, statuses, issues };
}

function parseDocuments(
  documents: readonly SourceDocument[],
  issues: CatalogIssue[],
): ParsedDocument[] {
  const parsed: ParsedDocument[] = [];
  const seen = new Map<string, string>();
  for (const document of documents) {
    const kind = readKind(document.content);
    if (kind === undefined) {
      issues.push(
        issue(
          document.origin,
          'DEFINITION_INVALID',
          `kind must be one of ${DEFINITION_KINDS.join(', ')}`,
        ),
      );
      continue;
    }
    const hasDigest = isRecord(document.content) && 'digest' in document.content;
    const schema = hasDigest ? DEFINITION_SCHEMAS[kind] : DEFINITION_DRAFT_SCHEMAS[kind];
    const result = validate<Definition | DefinitionBody>(schema, document.content);
    if (!result.ok) {
      issues.push(issue(document.origin, 'DEFINITION_INVALID', result.issues.join('; ')));
      continue;
    }
    const value = result.value;
    const key = definitionKey(value.kind, value.id, value.version);
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push(
        issue(document.origin, 'DEFINITION_DUPLICATE', `${key} is also defined in ${previous}`),
      );
      continue;
    }
    seen.set(key, document.origin);
    const declaredDigest = 'digest' in value ? value.digest : undefined;
    parsed.push({ origin: document.origin, key, body: stripDigest(value), declaredDigest });
  }
  return parsed;
}

function checkReferences(
  document: ParsedDocument,
  parsed: readonly ParsedDocument[],
  failed: ReadonlySet<string>,
): CatalogIssue[] {
  const known = new Set(parsed.map((candidate) => candidate.key));
  const found: CatalogIssue[] = [];
  for (const { field, kind, ref } of outgoingReferences(document.body)) {
    const key = definitionKey(kind, ref.id, ref.version);
    if (!known.has(key))
      found.push(issue(document.origin, 'REFERENCE_MISSING', `${field} points to unknown ${key}`));
    else if (failed.has(key))
      found.push(
        issue(document.origin, 'REFERENCE_INVALID', `${field} points to ${key}, which has issues`),
      );
  }
  return found;
}

const TEMPLATE_SLOT = /\{\{\s*([^{}]*?)\s*\}\}/gu;

function checkPromptVariables(entries: readonly AnalyzedEntry[]): CatalogIssue[] {
  const found: CatalogIssue[] = [];
  for (const entry of entries) {
    if (entry.body.kind !== 'PROMPT') continue;
    const prompt: Omit<PromptDefinition, 'digest'> = entry.body;
    const declared = prompt.variables.map((variable) => variable.name);
    const used = new Set(
      [...prompt.template.matchAll(TEMPLATE_SLOT)].map((match) => match[1] ?? ''),
    );
    const duplicates = declared.filter((name, index) => declared.indexOf(name) !== index);
    const undeclared = [...used].filter((name) => !declared.includes(name));
    const unused = declared.filter((name) => !used.has(name));
    const problems = [
      ...duplicates.map((name) => `variable ${name} is declared twice`),
      ...undeclared.map((name) => `slot {{${name}}} is not declared`),
      ...unused.map((name) => `variable ${name} is declared but never used`),
    ];
    if (problems.length > 0)
      found.push(issue(entry.origin, 'PROMPT_VARIABLES_MISMATCH', problems.join('; ')));
  }
  return found;
}

/** A READ_ONLY unit may only contain tools that have no side effect and READ_ONLY risk. */
function checkUnitEffects(
  entries: readonly AnalyzedEntry[],
  bodies: ReadonlyMap<string, DefinitionBody>,
): CatalogIssue[] {
  const found: CatalogIssue[] = [];
  for (const entry of entries) {
    if (entry.body.kind !== 'UNIT' || entry.body.effect !== 'READ_ONLY') continue;
    for (const tool of toolsOf(entry.body, bodies)) {
      if (tool.sideEffect !== 'NONE' || tool.riskClass !== 'READ_ONLY')
        found.push(
          issue(
            entry.origin,
            'EFFECT_MISMATCH',
            `READ_ONLY unit contains tool ${tool.id}@${tool.version} ` +
              `(sideEffect ${tool.sideEffect}, riskClass ${tool.riskClass})`,
          ),
        );
    }
  }
  return found;
}

/** Tool calling identifies tools by name, so names must be unique within one agent. */
function checkToolNames(
  entries: readonly AnalyzedEntry[],
  bodies: ReadonlyMap<string, DefinitionBody>,
): CatalogIssue[] {
  const found: CatalogIssue[] = [];
  for (const entry of entries) {
    if (entry.body.kind !== 'AGENT') continue;
    const owners = new Map<string, string>();
    for (const ref of entry.body.unitRefs) {
      const unit = bodies.get(definitionKey('UNIT', ref.id, ref.version));
      if (unit?.kind !== 'UNIT') continue;
      for (const tool of toolsOf(unit, bodies)) {
        const owner = `${tool.id}@${tool.version}`;
        const previous = owners.get(tool.modelName);
        if (previous !== undefined && previous !== owner)
          found.push(
            issue(
              entry.origin,
              'TOOL_NAME_CONFLICT',
              `${previous} and ${owner} are both named ${tool.modelName}`,
            ),
          );
        owners.set(tool.modelName, owner);
      }
    }
  }
  return found;
}

function toolsOf(
  unit: Omit<UnitDefinition, 'digest'>,
  bodies: ReadonlyMap<string, DefinitionBody>,
): Omit<ToolDefinition, 'digest'>[] {
  const tools: Omit<ToolDefinition, 'digest'>[] = [];
  for (const ref of unit.toolRefs) {
    const tool = bodies.get(definitionKey('TOOL', ref.id, ref.version));
    if (tool?.kind === 'TOOL') tools.push(tool);
  }
  return tools;
}

function parseStatuses(
  document: SourceDocument | undefined,
  bodies: ReadonlyMap<string, DefinitionBody>,
  issues: CatalogIssue[],
): ReadonlyMap<string, DefinitionStatus> {
  const statuses = new Map<string, DefinitionStatus>();
  if (document === undefined) return statuses;
  const result = validate<DefinitionStatusFile>(DefinitionStatusFileSchema, document.content);
  if (!result.ok) {
    issues.push(issue(document.origin, 'STATUS_INVALID', result.issues.join('; ')));
    return statuses;
  }
  for (const entry of result.value.entries) {
    const key = definitionKey(entry.kind, entry.id, entry.version);
    if (!bodies.has(key))
      issues.push(issue(document.origin, 'STATUS_INVALID', `status set for unknown ${key}`));
    else if (statuses.has(key))
      issues.push(issue(document.origin, 'STATUS_INVALID', `status set twice for ${key}`));
    else statuses.set(key, entry.status);
  }
  return statuses;
}

function readKind(content: unknown): DefinitionKind | undefined {
  if (!isRecord(content)) return undefined;
  const kind = content['kind'];
  return DEFINITION_KINDS.find((candidate) => candidate === kind);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripDigest(value: Definition | DefinitionBody): DefinitionBody {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'digest'),
  ) as DefinitionBody;
}

function issue(origin: string, code: CatalogIssueCode, message: string): CatalogIssue {
  return { origin, code, message };
}
