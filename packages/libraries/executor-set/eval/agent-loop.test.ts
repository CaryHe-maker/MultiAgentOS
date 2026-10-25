import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSubprocessRunner } from '@multiagentos/kernel';
import { describe, expect, it } from 'vitest';
import { createExecutorRegistry } from '../src/index.js';
import { createModelCallExecutor } from '../src/model-call/model-call-executor.js';
import { chatCompletion } from '../src/test-support/environments.js';
import { runAgentLoop } from './agent-loop.js';
import { loadCodeViewer } from './eval-setup.js';
import { gradeReport, loadAnswerKey } from './grade.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Replies in order; records the messages of every request. */
function scripted(replies: (() => Response)[], requests: unknown[][]): typeof fetch {
  let index = 0;
  return (_input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      messages: unknown[];
    };
    requests.push(body.messages);
    const reply = replies[Math.min(index, replies.length - 1)] as () => Response;
    index += 1;
    return Promise.resolve(reply());
  };
}

describe('evaluation loop (offline)', () => {
  it('loads the newest code viewer with exactly the versions it references', async () => {
    const setup = await loadCodeViewer();
    // The catalog keeps superseded versions; a lookup by id alone once picked v1.0.0.
    expect(setup.agent.version).toBe('v1.1.0');
    expect(setup.digests).toHaveProperty(
      `PROMPT:code-viewer-system@${setup.agent.promptRef.version}`,
    );
    expect(Object.keys(setup.digests).filter((key) => key.startsWith('PROMPT:'))).toHaveLength(1);
    expect(setup.instructions).toContain('to four sentences');
  });

  it('searches, reads, finishes and verifies the cited sources', async () => {
    const setup = await loadCodeViewer();
    const requests: unknown[][] = [];
    const finish = {
      summary: 'config_destroy frees the entries twice.',
      conclusions: [
        {
          statement: 'config_destroy calls free(config->entries) twice: a double free.',
          sources: [{ path: 'src/parser.c', startLine: 85, endLine: 90 }],
        },
        { statement: 'Never read.', sources: [{ path: 'src/main.c', startLine: 1, endLine: 2 }] },
      ],
      unconfirmed: [],
    };
    const fetch = scripted(
      [
        () =>
          chatCompletion([
            {
              id: 'c1',
              name: 'search_repository',
              arguments: '{"query":"config_destroy","mode":"SYMBOL"}',
            },
            { id: 'c2', name: 'read_file', arguments: '{"path":"src/parser.c"}' },
            { id: 'c3', name: 'read_file', arguments: '{"path":"src/parser.c"}' },
          ]),
        () =>
          chatCompletion([
            { id: 'c4', name: 'finish_analysis', arguments: JSON.stringify(finish) },
          ]),
      ],
      requests,
    );
    const result = await runAgentLoop({
      question: 'Find memory errors.',
      repositoryRoot: join(here, 'fixtures/c-review'),
      registry: { ...createExecutorRegistry(), MODEL: createModelCallExecutor({ fetch }) },
      agent: setup.agent,
      model: setup.model,
      instructions: setup.instructions,
      tools: setup.tools,
      apiKey: 'sk-test',
      subprocess: createSubprocessRunner(),
    });
    expect(result).toMatchObject({
      ok: true,
      endReason: 'FINISH',
      rounds: 2,
      verified: 1,
      unverified: 1,
      reads: 1,
      searches: 1,
      rejectedToolCalls: 1, // the second identical read_file
    });
    // The second request replays the first one and appends to it: a stable, cacheable prefix.
    const [first, second] = requests;
    expect(second?.slice(0, (first?.length ?? 0) - 1)).toEqual(first?.slice(0, -1));
    expect(JSON.stringify(second)).toContain('src/parser.c (lines 1-93 of 93)');
    const grade = gradeReport(
      result.report,
      loadAnswerKey(join(here, 'fixtures/c-review-answer-key.json')),
    );
    expect(grade.found).toContain('double-free');
  });

  it('forces finish_analysis after the round limit and degrades when it is not called', async () => {
    const setup = await loadCodeViewer();
    const requests: unknown[][] = [];
    const fetch = scripted([() => chatCompletion([], { text: 'I think it is fine.' })], requests);
    const result = await runAgentLoop({
      question: 'Find memory errors.',
      repositoryRoot: join(here, 'fixtures/c-review'),
      registry: { ...createExecutorRegistry(), MODEL: createModelCallExecutor({ fetch }) },
      agent: { ...setup.agent, limits: { maxRounds: 2, maxToolCallsPerRound: 8 } },
      model: setup.model,
      instructions: setup.instructions,
      tools: setup.tools,
      apiKey: 'sk-test',
      subprocess: createSubprocessRunner(),
    });
    expect(result).toMatchObject({ ok: false, endReason: 'DEGRADED', invalidReplies: 2 });
    expect(JSON.stringify(requests.at(-1))).toContain('This is your final call');
  });
});
