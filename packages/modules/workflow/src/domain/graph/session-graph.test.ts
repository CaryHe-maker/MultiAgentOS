import { newId, type SessionLogRecord, type TemplateDefinition } from '@multiagentos/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  advanceGraph,
  chatGrowthPoint,
  chatGrowthRevision,
  compileTemplate,
  initialChatRevision,
  projectGraph,
  type GraphRevision,
} from './session-graph.js';

const run = newId('wfr');
const main = { id: 'main', version: 'v1.0.0' };
const ROOT = 'msc_rootmission';
const at = '2026-10-31T00:00:00.000Z';

type Spread<T> = T extends unknown ? Omit<T, 'seq' | 'at' | 'workflowRunId'> : never;
function logOf(entries: readonly Spread<SessionLogRecord>[]): SessionLogRecord[] {
  return entries.map(
    (entry, index) =>
      ({ ...entry, seq: index + 1, at, workflowRunId: run }) as unknown as SessionLogRecord,
  );
}
const extended = (revision: number, content: GraphRevision): Spread<SessionLogRecord> => ({
  type: 'GRAPH_EXTENDED',
  revision,
  source: revision === 1 ? 'TEMPLATE' : 'CHAT_GROWTH',
  nodes: [...content.nodes],
  edges: [...content.edges],
});
const ended = (
  nodeId: string,
  status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED',
): Spread<SessionLogRecord> => ({ type: 'NODE_ENDED', nodeId, status });
const names = (nodes: readonly { name: string }[]): string[] => nodes.map((node) => node.name);

const pipeline: TemplateDefinition = {
  schemaVersion: 'v1',
  kind: 'TEMPLATE',
  id: 'pipeline',
  version: 'v1.0.0',
  digest: 'a'.repeat(64),
  description: 'pipeline',
  nodes: [
    { name: 'explore', kind: 'AGENT', agent: { id: 'explorer', version: 'v0.1.0' } },
    {
      name: 'build',
      kind: 'AGENT',
      agent: { id: 'worker', version: 'v0.1.0' },
      dependsOn: ['explore'],
      output: true,
    },
  ],
};

describe('chat', () => {
  const first = initialChatRevision(run, main, ROOT);
  const [firstPrompt, firstMain] = first.nodes;
  if (firstPrompt === undefined || firstMain === undefined) throw new Error('no nodes');

  it('derives the same IDs on replay and valid paths', () => {
    expect(initialChatRevision(run, main, ROOT)).toEqual(first);
    expect(firstPrompt.path).toBe(`${run}/1/prompt`);
  });

  it('starts main once the prompt is answered', () => {
    const projected = projectGraph(
      logOf([extended(1, first), ended(firstPrompt.nodeId, 'SUCCEEDED')]),
      run,
    );
    expect(names(advanceGraph(projected.graph, projected.view).ready)).toEqual(['main']);
  });

  it.each(['SUCCEEDED', 'FAILED', 'INTERRUPTED'] as const)(
    'keeps the conversation going after main %s',
    (status) => {
      const before = projectGraph(
        logOf([
          extended(1, first),
          ended(firstPrompt.nodeId, 'SUCCEEDED'),
          ended(firstMain.nodeId, status),
        ]),
        run,
      );
      expect(chatGrowthPoint(before)).toBe(firstMain.nodeId);
      const growth = chatGrowthRevision(run, 2, firstMain.nodeId, main, ROOT);
      const after = projectGraph(
        logOf([
          extended(1, first),
          ended(firstPrompt.nodeId, 'SUCCEEDED'),
          ended(firstMain.nodeId, status),
          extended(2, growth),
        ]),
        run,
      );
      expect(chatGrowthPoint(after)).toBeUndefined();
      expect(after.lastRevision).toBe(2);
      expect(advanceGraph(after.graph, after.view).ready.map((n) => n.nodeId)).toEqual([
        growth.nodes[0]?.nodeId,
      ]);
    },
  );

  it('does not grow while main runs', () => {
    const projected = projectGraph(
      logOf([
        extended(1, first),
        { type: 'NODE_STARTED', nodeId: firstMain.nodeId, path: firstMain.path },
      ]),
      run,
    );
    expect(chatGrowthPoint(projected)).toBeUndefined();
  });

  it('ignores the records of another run', () => {
    const other = logOf([extended(1, first)]).map((record) => ({
      ...record,
      workflowRunId: newId('wfr'),
    }));
    expect(projectGraph(other as SessionLogRecord[], run).graph.nodes).toEqual([]);
  });
});

describe('a template', () => {
  const { revision, errors } = compileTemplate(run, pipeline, ROOT);
  const [prompt, explore, build] = revision.nodes;
  if (prompt === undefined || explore === undefined || build === undefined)
    throw new Error('no nodes');

  it('adds the root prompt and an edge for each dependency', () => {
    expect(errors).toEqual([]);
    expect(names(revision.nodes)).toEqual(['prompt', 'explore', 'build']);
    expect(revision.edges).toEqual([
      { from: prompt.nodeId, to: explore.nodeId, kind: 'DEPENDS' },
      { from: explore.nodeId, to: build.nodeId, kind: 'DEPENDS' },
    ]);
    expect(build).toMatchObject({ output: true });
  });

  it('runs a step once the one it depends on succeeded', () => {
    const projected = projectGraph(
      logOf([
        extended(1, revision),
        ended(prompt.nodeId, 'SUCCEEDED'),
        ended(explore.nodeId, 'SUCCEEDED'),
      ]),
      run,
    );
    expect(names(advanceGraph(projected.graph, projected.view).ready)).toEqual(['build']);
  });

  it('skips a step as failed when the one it depends on fails', () => {
    const projected = projectGraph(
      logOf([
        extended(1, revision),
        ended(prompt.nodeId, 'SUCCEEDED'),
        ended(explore.nodeId, 'FAILED'),
      ]),
      run,
    );
    expect(advanceGraph(projected.graph, projected.view).skipped[0]?.reason).toBe(
      'DEPENDENCY_FAILED',
    );
  });

  it('reports a dependency on a node that does not exist', () => {
    const broken: TemplateDefinition = {
      ...pipeline,
      nodes: [
        {
          name: 'build',
          kind: 'AGENT',
          agent: { id: 'worker', version: 'v0.1.0' },
          dependsOn: ['missing'],
        },
      ],
    };
    expect(compileTemplate(run, broken, ROOT).errors).toEqual([
      { code: 'UNKNOWN_DEPENDENCY', node: 'build' },
    ]);
  });
});

describe('replay', () => {
  it('gives the same ready set from any prefix of a chat log', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('SUCCEEDED', 'FAILED', 'INTERRUPTED'), { maxLength: 6 }),
        (outcomes) => {
          const entries: Spread<SessionLogRecord>[] = [];
          let current = initialChatRevision(run, main, ROOT);
          entries.push(extended(1, current));
          outcomes.forEach((status, index) => {
            const [prompt, agent] = current.nodes;
            if (prompt === undefined || agent === undefined) throw new Error('no nodes');
            entries.push(ended(prompt.nodeId, 'SUCCEEDED'), ended(agent.nodeId, status));
            current = chatGrowthRevision(run, index + 2, agent.nodeId, main, ROOT);
            entries.push(extended(index + 2, current));
          });
          const log = logOf(entries);
          for (let prefix = 0; prefix <= log.length; prefix += 1) {
            const once = projectGraph(log.slice(0, prefix), run);
            const twice = projectGraph(log.slice(0, prefix), run);
            expect(advanceGraph(once.graph, once.view)).toEqual(
              advanceGraph(twice.graph, twice.view),
            );
          }
          const final = projectGraph(log, run);
          expect(advanceGraph(final.graph, final.view).ready).toHaveLength(1);
        },
      ),
    );
  });
});
