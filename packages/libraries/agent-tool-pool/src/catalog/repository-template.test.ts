import { describe, expect, it } from 'vitest';
import { readRepositoryTemplate, type TemplateAgent } from './repository-template.js';

const agents = new Map<string, TemplateAgent>([
  ['main', { ref: { id: 'main', version: 'v0.1.0' }, writes: true }],
  ['worker', { ref: { id: 'worker', version: 'v0.1.0' }, writes: true }],
  ['explorer', { ref: { id: 'explorer', version: 'v0.1.0' }, writes: false }],
]);
const read = (text: string, id = 'review') => readRepositoryTemplate(text, id, agents);
const issuesOf = (text: string, id?: string) => {
  const result = read(text, id);
  return result.ok
    ? []
    : result.issues.map(({ rule, node }) => ({ rule, ...(node === undefined ? {} : { node }) }));
};

describe('a template of the repository (M2Design 3.8)', () => {
  it('reads a valid template, with its Agents named by id and resolved to the built-in versions', () => {
    const result = read(
      [
        'nodes:',
        '  - name: look',
        '    kind: AGENT',
        '    agent: explorer',
        '    goal: read the code',
        '  - name: fix',
        '    kind: AGENT',
        '    agent: main',
        '    goal: fix what was found',
        '    dependsOn: [look]',
        '    output: true',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template).toMatchObject({ id: 'review', origin: 'REPOSITORY', kind: 'TEMPLATE' });
    expect(result.template.nodes[1]).toMatchObject({ agent: { id: 'main', version: 'v0.1.0' } });
  });

  it('names the rule and the node of every problem', () => {
    expect(issuesOf('nodes: [unclosed')).toEqual([
      expect.objectContaining({ rule: 'YAML_INVALID' }),
    ]);
    expect(issuesOf('just: text')).toEqual([{ rule: 'NOT_A_TEMPLATE' }]);
    expect(
      issuesOf(
        'id: other\nnodes:\n  - name: a\n    kind: AGENT\n    agent: main\n    output: true',
      ),
    ).toEqual([{ rule: 'ID_MISMATCH' }]);
    expect(
      issuesOf('nodes:\n  - name: a\n    kind: AGENT\n    agent: wizard\n    output: true'),
    ).toEqual([{ rule: 'UNKNOWN_AGENT', node: 'a' }]);
    const schema = issuesOf(
      'nodes:\n  - name: Bad_Name\n    kind: AGENT\n    agent: main\n    output: true',
    );
    expect(schema.length).toBeGreaterThan(0);
    expect(
      schema.every((issue) => issue.rule === 'SCHEMA_INVALID' && issue.node === 'Bad_Name'),
    ).toBe(true);
  });

  it('finds what the shape does not show: duplicates, dependencies, cycles, the output', () => {
    const node = (name: string, extra = '') =>
      `  - name: ${name}\n    kind: AGENT\n    agent: explorer\n${extra}`;
    expect(issuesOf(`nodes:\n${node('a', '    output: true\n')}${node('a')}`)).toContainEqual({
      rule: 'DUPLICATE_NODE',
      node: 'a',
    });
    expect(
      issuesOf(`nodes:\n${node('a', '    dependsOn: [ghost]\n    output: true\n')}`),
    ).toContainEqual({
      rule: 'UNKNOWN_DEPENDENCY',
      node: 'a',
    });
    expect(
      issuesOf(
        `nodes:\n${node('a', '    dependsOn: [b]\n    output: true\n')}${node('b', '    dependsOn: [a]\n')}`,
      ),
    ).toContainEqual(expect.objectContaining({ rule: 'DEPENDENCY_CYCLE' }));
    expect(issuesOf(`nodes:\n${node('a')}`)).toEqual([{ rule: 'OUTPUT_REQUIRED' }]);
    expect(
      issuesOf(`nodes:\n${node('a', '    output: true\n')}${node('b', '    output: true\n')}`),
    ).toEqual([{ rule: 'OUTPUT_NOT_UNIQUE', node: 'b' }]);
    // Branches of a choice may each give the result: only one of them runs.
    expect(
      issuesOf(
        `nodes:\n${node('a', '    output: true\n')}${node(
          'b',
          '    dependsOn:\n      - node: a\n        when:\n          field: action\n          equals: HANDOFF\n    output: true\n',
        )}`,
      ),
    ).toEqual([]);
  });

  it('refuses two steps that change files and may run at once, and takes them one after the other', () => {
    const writer = (name: string, extra = '') =>
      `  - name: ${name}\n    kind: AGENT\n    agent: worker\n${extra}`;
    expect(issuesOf(`nodes:\n${writer('api', '    output: true\n')}${writer('ui')}`)).toEqual([
      { rule: 'PARALLEL_WRITERS', node: 'ui' },
    ]);
    expect(
      issuesOf(
        `nodes:\n${writer('api')}${writer('ui', '    dependsOn: [api]\n    output: true\n')}`,
      ),
    ).toEqual([]);
  });
});
