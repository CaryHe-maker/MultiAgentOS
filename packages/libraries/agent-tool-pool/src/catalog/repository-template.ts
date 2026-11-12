import { parseDocument } from 'yaml';
import {
  TemplateDefinitionSchema,
  sha256Hex,
  validate,
  type DefinitionRef,
  type TemplateDefinition,
} from '@multiagentos/contracts';

/**
 * A template the user keeps in the repository (`.multiagentos/workflows/<id>.yaml`, M2Design 3.8,
 * the strict mode of Phase2Plan 2): read, checked and turned into a definition the run compiles.
 * The file is repository material: it names built-in Agents only and carries no permission; the
 * Kernel narrows whatever its steps ask. Every problem names its rule and, when it has one, its node.
 */

/** A rule a repository template broke. */
export const REPOSITORY_TEMPLATE_RULES = [
  'YAML_INVALID',
  'NOT_A_TEMPLATE',
  'ID_MISMATCH',
  'SCHEMA_INVALID',
  'UNKNOWN_AGENT',
  'DUPLICATE_NODE',
  'UNKNOWN_DEPENDENCY',
  'DEPENDENCY_CYCLE',
  'OUTPUT_REQUIRED',
  'OUTPUT_NOT_UNIQUE',
  'PARALLEL_WRITERS',
] as const;
export type RepositoryTemplateRule = (typeof REPOSITORY_TEMPLATE_RULES)[number];

export interface RepositoryTemplateIssue {
  readonly rule: RepositoryTemplateRule;
  readonly node?: string;
  readonly message: string;
}

/** A built-in Agent a template may name, and whether it can change files. */
export interface TemplateAgent {
  readonly ref: DefinitionRef;
  readonly writes: boolean;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dependencyName = (dependency: unknown): string | undefined =>
  typeof dependency === 'string'
    ? dependency
    : isRecord(dependency) && typeof dependency['node'] === 'string'
      ? dependency['node']
      : undefined;

export function readRepositoryTemplate(
  text: string,
  id: string,
  agents: ReadonlyMap<string, TemplateAgent>,
):
  | { readonly ok: true; readonly template: TemplateDefinition }
  | { readonly ok: false; readonly issues: readonly RepositoryTemplateIssue[] } {
  const document = parseDocument(text);
  if (document.errors.length > 0)
    return {
      ok: false,
      issues: document.errors.map((error) => ({ rule: 'YAML_INVALID', message: error.message })),
    };
  const raw: unknown = document.toJS();
  if (!isRecord(raw) || !Array.isArray(raw['nodes']))
    return {
      ok: false,
      issues: [{ rule: 'NOT_A_TEMPLATE', message: 'a template is a mapping with a list of nodes' }],
    };
  const issues: RepositoryTemplateIssue[] = [];
  if (raw['id'] !== undefined && raw['id'] !== id)
    issues.push({
      rule: 'ID_MISMATCH',
      message: `the file is ${id}.yaml but its id is ${JSON.stringify(raw['id'])}`,
    });
  const nodes = raw['nodes'] as unknown[];
  const names = nodes.map((node) => (isRecord(node) ? String(node['name']) : ''));
  // Agents are named by their id; each is the built-in version.
  const resolved = nodes.map((node) => {
    if (!isRecord(node) || node['kind'] !== 'AGENT') return node;
    const named =
      typeof node['agent'] === 'string'
        ? node['agent']
        : isRecord(node['agent'])
          ? String(node['agent']['id'])
          : '';
    const agent = agents.get(named);
    if (agent === undefined) {
      issues.push({
        rule: 'UNKNOWN_AGENT',
        node: String(node['name']),
        message: `no built-in Agent is named ${named || '(none)'}; known: ${[...agents.keys()].join(', ')}`,
      });
      return node;
    }
    return { ...node, agent: { ...agent.ref } };
  });
  const ownerName = typeof raw['owner'] === 'string' ? raw['owner'] : undefined;
  const owner = ownerName === undefined ? undefined : agents.get(ownerName);
  if (ownerName !== undefined && owner === undefined)
    issues.push({
      rule: 'UNKNOWN_AGENT',
      message: `no built-in Agent is named ${ownerName} (owner)`,
    });
  const candidate = {
    schemaVersion: 'v1',
    kind: 'TEMPLATE',
    id,
    version: typeof raw['version'] === 'string' ? raw['version'] : 'v0.1.0',
    digest: sha256Hex(text),
    description:
      typeof raw['description'] === 'string' ? raw['description'] : `repository template ${id}`,
    origin: 'REPOSITORY',
    ...(owner === undefined ? {} : { owner: { agent: { ...owner.ref } } }),
    nodes: resolved,
  };
  if (issues.length > 0) return { ok: false, issues };
  const checked = validate<TemplateDefinition>(TemplateDefinitionSchema, candidate);
  if (!checked.ok)
    return {
      ok: false,
      issues: checked.issues.map((issue) => {
        const index = /^\/nodes\/(\d+)/u.exec(issue)?.[1];
        const node = index === undefined ? undefined : names[Number(index)];
        return {
          rule: 'SCHEMA_INVALID',
          ...(node === undefined || node === '' ? {} : { node }),
          message: issue,
        };
      }),
    };
  const graphIssues = graphProblems(checked.value, agents);
  return graphIssues.length > 0
    ? { ok: false, issues: graphIssues }
    : { ok: true, template: checked.value };
}

/** What the shape alone does not show: names, dependencies, the output, writers side by side. */
function graphProblems(
  template: TemplateDefinition,
  agents: ReadonlyMap<string, TemplateAgent>,
): RepositoryTemplateIssue[] {
  const issues: RepositoryTemplateIssue[] = [];
  const seen = new Set<string>();
  for (const node of template.nodes) {
    if (seen.has(node.name))
      issues.push({
        rule: 'DUPLICATE_NODE',
        node: node.name,
        message: 'another node has this name',
      });
    seen.add(node.name);
  }
  const before = new Map<string, string[]>();
  for (const node of template.nodes) {
    const deps = node.kind === 'AGENT' ? (node.dependsOn ?? []).map(dependencyName) : [];
    for (const dep of deps)
      if (dep === undefined || !seen.has(dep))
        issues.push({
          rule: 'UNKNOWN_DEPENDENCY',
          node: node.name,
          message: `it depends on ${dep ?? '(nothing)'}, which is no node of the template`,
        });
    before.set(
      node.name,
      deps.filter((dep): dep is string => dep !== undefined && seen.has(dep)),
    );
  }
  // What a node comes after, directly or not.
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const cyclic = new Set<string>();
  const above = (name: string): Set<string> => {
    const known = ancestors.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) {
      cyclic.add(name);
      return new Set();
    }
    visiting.add(name);
    const found = new Set<string>();
    for (const dep of before.get(name) ?? []) {
      found.add(dep);
      for (const each of above(dep)) found.add(each);
    }
    visiting.delete(name);
    ancestors.set(name, found);
    return found;
  };
  for (const node of template.nodes) above(node.name);
  for (const name of cyclic)
    issues.push({
      rule: 'DEPENDENCY_CYCLE',
      node: name,
      message: 'its dependencies lead back to it',
    });
  const outputs = template.nodes.filter((node) => node.kind === 'AGENT' && node.output === true);
  if (outputs.length === 0)
    issues.push({
      rule: 'OUTPUT_REQUIRED',
      message: 'one AGENT node must have output: true; its reply is the result of the run',
    });
  // Two outputs are fine when they are branches of a choice (like analyze: plan or view), so at
  // most one of them runs; two that may both run would give two results.
  const conditional = (node: (typeof outputs)[number]): boolean =>
    node.kind === 'AGENT' &&
    (node.dependsOn ?? []).some(
      (dependency) => isRecord(dependency) && dependency['when'] !== undefined,
    );
  const first = outputs[0];
  for (const extra of outputs.slice(1))
    if (!(first !== undefined && (conditional(extra) || conditional(first))))
      issues.push({
        rule: 'OUTPUT_NOT_UNIQUE',
        node: extra.name,
        message: `only one node gives the result; ${outputs[0]?.name ?? ''} already does`,
      });
  // Two steps that change files and may run at once would write the same workspace: the template
  // gives them no scopes of their own, so one must come after the other.
  const writers = template.nodes.filter(
    (node) => node.kind === 'AGENT' && agents.get(node.agent.id)?.writes === true,
  );
  for (const [index, first] of writers.entries())
    for (const second of writers.slice(index + 1)) {
      const ordered =
        ancestors.get(first.name)?.has(second.name) === true ||
        ancestors.get(second.name)?.has(first.name) === true;
      if (!ordered)
        issues.push({
          rule: 'PARALLEL_WRITERS',
          node: second.name,
          message: `it and ${first.name} can both change files and may run at the same time; make one depend on the other`,
        });
    }
  return issues;
}
