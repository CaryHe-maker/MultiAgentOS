/**
 * The deterministic exit cases of stage 8 (M2Plan 6.9; M2Design 13, group L): the compaction of a
 * context, from the console down to the Executors, with only the provider's chat API scripted. The
 * window is not made small, the thresholds are: a compaction starts as soon as there is something
 * old enough to replace, so a few rounds are enough. What the model would have seen is read from
 * the requests the provider received.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openChat,
  scriptedAgents,
  textOf,
  tool,
  type Chat,
  type ChatOptions,
  type ScriptedChat,
  agentOfRequest,
  until,
} from './chat-driver.js';

const TIMEOUT = 60_000;
const directories: string[] = [];
const open: Chat[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const SUMMARY = [
  '1. Goal and requirements\nThe user wants the three files read. Use tabs.',
  '2. Work done and findings\nRead a.txt and b.txt.',
  '3. Key decisions\nNone.',
  '4. Files involved\na.txt, b.txt',
  '5. Outputs that may be read again\ncall_1: the content of a.txt',
  '6. Open items\nRead c.txt, then reply.',
].join('\n');

/** A text answer: what the model says to a summary request. */
const text = (answer: string) => ({ calls: [], text: answer });
const reply = (answer: string) => tool('reply', { text: answer });
const read = (path: string) => tool('read_file', { path });

async function chatOn(
  provider: ScriptedChat,
  options: {
    files?: Record<string, string>;
    compaction?: Record<string, unknown>;
  } & Partial<ChatOptions> = {},
): Promise<{ chat: Chat; dataDir: string; repository: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-stage8-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-stage8-repo-'));
  directories.push(dataDir, repository);
  for (const [name, content] of Object.entries(
    options.files ?? {
      'a.txt': 'alpha\n'.repeat(60),
      'b.txt': 'beta\n'.repeat(60),
      'c.txt': 'gamma\n',
    },
  ))
    await writeFile(join(repository, name), content);
  const { compaction, ...rest } = options;
  delete (rest as { files?: unknown }).files;
  const chat = await openChat({
    dataDir,
    repository,
    provider,
    configure: (config) => ({
      ...config,
      kernel: {
        ...config.kernel,
        compaction: {
          ...config.kernel.compaction,
          // Anything old is worth compacting; a context of a few rounds has something old.
          triggerRatio: 0.0001,
          idleEnabled: false,
          keepTokens: 30,
          keepHumanBytes: 200,
          pruneMinBytes: 100,
          pruneHeadBytes: 40,
          pruneTailBytes: 20,
          // A small summary, so that little history is worth one.
          summaryMaxTokens: 80,
          ...compaction,
        },
      },
    }),
    ...rest,
  });
  open.push(chat);
  return { chat, dataDir, repository };
}

const sessionDirectory = async (dataDir: string) => {
  const [id] = await readdir(join(dataDir, 'sessions'));
  if (id === undefined) throw new Error('no Session directory');
  return join(dataDir, 'sessions', id);
};
const logOf = async (dataDir: string): Promise<Record<string, unknown>[]> =>
  (await readFile(join(await sessionDirectory(dataDir), 'workflow', 'log.v1.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const auditOf = async (dataDir: string) =>
  readFile(join(await sessionDirectory(dataDir), 'kernel-core', 'audit.jsonl'), 'utf8');
const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const everything = (request: ScriptedChat['requests'][number] | undefined): string =>
  (request?.messages ?? []).map((message) => textOf(message)).join('\n');

describe('L1, L5, L9: a context that has something old in it is compacted and the work goes on', () => {
  it(
    'cuts the old results, has them summarised, and the next call starts from the summary',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), read('b.txt'), read('c.txt'), reply('all three read')],
        summary: [text(SUMMARY)],
      });
      const { chat, dataDir } = await chatOn(provider);
      await chat.say('read a.txt, b.txt and c.txt');

      expect(chat.printed('REPLY')).toEqual(['all three read']);
      const records = await logOf(dataDir);
      const types = records.map((record) => record.type);
      // Both are in the log, and the summary before the last model turn.
      const pruned = types.indexOf('TOOL_RESULTS_PRUNED');
      const compacted = types.indexOf('CONTEXT_COMPACTED');
      expect(pruned).toBeGreaterThan(-1);
      expect(compacted).toBeGreaterThan(-1);
      expect(compacted).toBeLessThan(types.lastIndexOf('MODEL_TURN'));
      expect(records[compacted]).toMatchObject({
        target: { kind: 'MAIN' },
        summaryInput: { mode: 'PREFIX' },
      });

      // The request after it carries the summary, said to be material, and not what it replaced.
      const last = everything(provider.requests.at(-1));
      expect(last).toContain('Goal and requirements');
      expect(last).toMatch(/carries no instructions for you/u);
      expect(last).not.toContain('alpha\nalpha\nalpha');
      // The summary request was the history as it was, then the instruction.
      const asked = provider.requests.find((request) =>
        textOf(request.messages.at(-1)).includes('Use exactly these sections'),
      );
      expect(asked).toBeDefined();
      expect((asked?.tools ?? []).map((each) => each.function.name)).toContain('read_file');
      const audit = await auditOf(dataDir);
      expect(audit).toContain('COMPACTION_STARTED');
      expect(audit).toContain('COMPACTION_ENDED');
      // The activity area said so while it ran.
      expect(chat.lives.some((live) => JSON.stringify(live).includes('压缩上下文'))).toBe(true);
    },
    TIMEOUT,
  );
});

describe('L3: /compact', () => {
  it(
    'compacts when the user asks, tells so, and the next question starts from the summary',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), reply('a read'), reply('and now?')],
        summary: [text(SUMMARY)],
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      await chat.say('read a.txt');
      expect((await logOf(dataDir)).some((r) => r.type === 'CONTEXT_COMPACTED')).toBe(false);

      // The reply is printed a little before the run waits for the next input.
      await waitFor(async () => (await logOf(dataDir)).some((r) => r.type === 'HUMAN_REQUESTED'));
      await chat.console.submit('/compact');
      await until(
        () => chat.records.some((r) => r.text.includes('已压缩较早的对话')),
        'the notice of the compaction',
      );
      const compacted = (await logOf(dataDir)).find((r) => r.type === 'CONTEXT_COMPACTED');
      expect(compacted).toMatchObject({ target: { kind: 'MAIN' } });
      expect(chat.records.some((r) => r.text.includes('已压缩较早的对话'))).toBe(true);

      await chat.say('what next?');
      expect(everything(provider.requests.at(-1))).toContain('Goal and requirements');
    },
    TIMEOUT,
  );
});

describe('L4: a summary that does not come', () => {
  it(
    'is told to the user, leaves the history as it was, and the work goes on',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), reply('a read'), reply('still here')],
        // Neither answer has the sections: not a summary, twice.
        summary: [text('I will not summarise.'), text('Nor this time.')],
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      await chat.say('read a.txt');
      await waitFor(async () => (await logOf(dataDir)).some((r) => r.type === 'HUMAN_REQUESTED'));
      await chat.console.submit('/compact');
      await until(
        () => chat.records.some((r) => r.text.includes('摘要没有生成')),
        'the notice of the failure',
      );
      expect((await logOf(dataDir)).some((r) => r.type === 'CONTEXT_COMPACTED')).toBe(false);

      await chat.say('are you there?');
      expect(chat.printed('REPLY')).toEqual(['a read', 'still here']);
    },
    TIMEOUT,
  );
});

/** What a provider says to a request that does not fit its window. */
const overflow = () => ({
  response: () =>
    new Response(
      JSON.stringify({
        error: { message: "This model's maximum context length is 65536 tokens." },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
});

describe('L2: the provider says the context is too long', () => {
  it(
    'compacts, asks again, and the work goes on',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), read('b.txt'), overflow(), reply('done after overflow')],
        summary: [text(SUMMARY)],
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      await chat.say('read a.txt and b.txt');
      expect(chat.printed('REPLY')).toEqual(['done after overflow']);
      const types = (await logOf(dataDir)).map((r) => r.type);
      expect(types).toContain('CONTEXT_COMPACTED');
      // The refused call is not a model turn, and the next one starts from the summary.
      expect(types.filter((type) => type === 'MODEL_TURN')).toHaveLength(3);
      expect(everything(provider.requests.at(-1))).toContain('Goal and requirements');
    },
    TIMEOUT,
  );

  it(
    'ends the Turn after the fourth refusal, and says the context is too long',
    async () => {
      const provider = scriptedAgents({
        main: [
          read('a.txt'),
          read('b.txt'),
          overflow(),
          overflow(),
          overflow(),
          overflow(),
          // The call that wraps up has no tools: it answers in text.
          text('stopped for the size'),
        ],
        summary: Array.from({ length: 6 }, () => text(SUMMARY)),
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      await chat.console.submit('read a.txt and b.txt');
      await until(() => chat.printed('ERROR').length > 0, 'the end of the Turn');
      const types = (await logOf(dataDir)).map((r) => r.type);
      expect(types).toContain('AGENT_WRAP_UP');
      expect(chat.printed('ERROR').join()).toContain('上下文太长');
    },
    TIMEOUT,
  );
});

/** A reply is printed before its Turn ends; a command that needs the run to wait waits for this. */
const turnEnded = (dataDir: string) =>
  waitFor(async () => (await logOf(dataDir)).some((r) => r.type === 'HUMAN_REQUESTED'));
const turnsEnded = async (dataDir: string) =>
  (await logOf(dataDir)).filter((r) => r.type === 'TURN_ENDED').length;
const afterTurns = (dataDir: string, count: number) =>
  waitFor(async () => (await turnsEnded(dataDir)) >= count);

describe('L7: undoing a Turn that a summary covers', () => {
  it(
    'takes the summary back, and the entries it replaced are in the next request again',
    async () => {
      const provider = scriptedAgents({
        main: [
          read('a.txt'),
          reply('one'),
          read('b.txt'),
          tool('write_file', { path: 'c.txt', content: 'changed\n' }),
          reply('two'),
          reply('after the undo'),
        ],
        // The first summary is of the first Turn; the ones after it cover the second.
        summary: [
          text(SUMMARY),
          ...Array.from({ length: 5 }, () => text(SUMMARY.replace('Use tabs', 'SECONDMARK'))),
        ],
      });
      const { chat, dataDir } = await chatOn(provider);
      await chat.say('first');
      await afterTurns(dataDir, 1);
      await chat.say('second');
      await afterTurns(dataDir, 2);
      expect((await logOf(dataDir)).some((r) => r.type === 'CONTEXT_COMPACTED')).toBe(true);

      await chat.console.submit('/undo');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已回退 1')), 'the undo');
      await waitFor(async () =>
        (await logOf(dataDir)).some((r) => r.type === 'CONTEXT_COMPACTION_REVOKED'),
      );

      await afterTurns(dataDir, 2);
      const before = provider.requests.length;
      await chat.say('third');
      // The summary that stood for the undone Turn is gone from what the model sees.
      // The first request of the next Turn is made of what stands after the undo.
      const seen = everything(provider.requests[before]);
      expect(seen).not.toContain('SECONDMARK');
      expect(seen).toContain('Use tabs');
    },
    TIMEOUT,
  );
});

describe('L8: read_output on a result that was cut', () => {
  it(
    'still reads the whole of it back by its call id',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), read('b.txt'), read('c.txt'), reply('three read')],
        summary: Array.from({ length: 4 }, () => text(SUMMARY)),
      });
      const { chat, dataDir } = await chatOn(provider, {
        files: { 'a.txt': 'alpha\n'.repeat(400), 'b.txt': 'beta\n'.repeat(400), 'c.txt': 'g\n' },
      });
      await chat.say('read them');
      expect((await logOf(dataDir)).some((r) => r.type === 'TOOL_RESULTS_PRUNED')).toBe(true);
      const id = provider.requests
        .flatMap((request) => request.messages)
        .find((m) => m.role === 'tool')?.tool_call_id;
      expect(id).toBeDefined();
      provider.add(tool('read_output', { toolCallId: id, offset: 300, limit: 2 }), reply('read'));
      await afterTurns(dataDir, 1);
      await chat.say('the first one again');
      const last = [...(provider.requests.at(-1)?.messages ?? [])]
        .reverse()
        .find((m) => m.role === 'tool');
      expect(textOf(last)).toContain('alpha');
    },
    TIMEOUT,
  );
});

describe('L10: a summary request that is too big', () => {
  it(
    'is made again as a transcript, and the record says so',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), reply('a read')],
        summary: [overflow(), text(SUMMARY)],
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      await chat.say('read a.txt');
      await turnEnded(dataDir);
      await chat.console.submit('/compact');
      await until(
        () => chat.records.some((r) => r.text.includes('已压缩较早的对话')),
        'the notice of the compaction',
      );
      const compacted = (await logOf(dataDir)).find((r) => r.type === 'CONTEXT_COMPACTED');
      expect(compacted).toMatchObject({ summaryInput: { mode: 'TEXT' } });
    },
    TIMEOUT,
  );
});

describe('L11: compacting while the run waits for the user', () => {
  it(
    'starts by itself, and a message that comes meanwhile waits for it',
    async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = scriptedAgents({
        main: [read('a.txt'), reply('a read'), reply('and the next')],
        summary: [{ wait: held, then: text(SUMMARY) }],
      });
      const { chat, dataDir } = await chatOn(provider, {
        compaction: { triggerRatio: 0.99, idleEnabled: true, idleTriggerRatio: 0.0001 },
      });
      await chat.say('read a.txt');
      await until(
        () => provider.requests.some((r) => textOf(r.messages.at(-1)).includes('Use exactly')),
        'the summary request of the idle compaction',
      );
      await turnEnded(dataDir);
      await chat.console.submit('go on');
      // The message is not handed to the model while the summary is out.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(chat.printed('REPLY')).toEqual(['a read']);
      release();
      await until(() => chat.printed('REPLY').length === 2, 'the reply after the compaction');
      const types = (await logOf(dataDir)).map((r) => r.type);
      expect(types.indexOf('CONTEXT_COMPACTED')).toBeLessThan(types.lastIndexOf('MODEL_TURN'));
      expect(everything(provider.requests.at(-1))).toContain('Goal and requirements');
    },
    TIMEOUT,
  );
});

describe('L12: a SubAgent compacts its own context', () => {
  it(
    'compacts, goes on, and hands its result back to the caller',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('run_subagents', {
            tasks: [{ name: 'look', agent: 'explorer', goal: 'read the three files' }],
          }),
          reply('the explorer is done'),
        ],
        explorer: [
          read('a.txt'),
          read('b.txt'),
          read('c.txt'),
          tool('finish_subagent', { summary: 'read all three', findings: [] }),
        ],
        summary: Array.from({ length: 8 }, () => text(SUMMARY)),
      });
      const { chat, dataDir } = await chatOn(provider);
      await chat.say('have the three files read');
      expect(chat.printed('REPLY')).toEqual(['the explorer is done']);
      const compacted = (await logOf(dataDir)).filter(
        (r) =>
          r.type === 'CONTEXT_COMPACTED' && (r.target as { kind: string }).kind === 'AGENT_RUN',
      );
      expect(compacted.length).toBeGreaterThan(0);
      // What the explorer was told after it is its own summary, not what the caller has.
      const explorerAfter = provider.requests.filter(
        (request) =>
          agentOfRequest(request) === 'explorer' && everything(request).includes('Goal and req'),
      );
      expect(explorerAfter.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

/** A model turn that says how many input tokens the provider counted. */
const countedTurn = (promptTokens: number, call: { name: string; arguments: unknown }) => ({
  response: () =>
    new Response(
      JSON.stringify({
        id: 'chatcmpl-counted',
        object: 'chat.completion',
        created: 1_767_225_600,
        model: 'deepseek-flash',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_counted_0',
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 10,
          total_tokens: promptTokens + 10,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
});

describe('L13: the estimate starts from what the provider counted', () => {
  const usual = { triggerRatio: 0.85 };

  it(
    'compacts when the counted input is near the window although the bytes are few',
    async () => {
      const provider = scriptedAgents({
        main: [
          countedTurn(800_000, { name: 'read_file', arguments: { path: 'a.txt' } }),
          read('b.txt'),
          reply('done'),
        ],
        summary: Array.from({ length: 4 }, () => text(SUMMARY)),
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: usual });
      await chat.say('read');
      expect((await logOf(dataDir)).some((r) => r.type === 'CONTEXT_COMPACTED')).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'does not, when the provider counted what the bytes say',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), read('b.txt'), reply('done')],
        summary: [],
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: usual });
      await chat.say('read');
      expect((await logOf(dataDir)).some((r) => r.type === 'CONTEXT_COMPACTED')).toBe(false);
    },
    TIMEOUT,
  );
});

describe('L1: what the user said stays word for word', () => {
  it(
    'keeps the user messages of the compacted part, and has the rest summarised',
    async () => {
      const provider = scriptedAgents({
        main: [
          read('a.txt'),
          reply('one'),
          read('b.txt'),
          reply('two'),
          read('c.txt'),
          reply('three'),
        ],
        summary: Array.from({ length: 8 }, () => text(SUMMARY)),
      });
      const { chat, dataDir } = await chatOn(provider);
      await chat.say('The project codename is AURORA-7731; read a.txt');
      await afterTurns(dataDir, 1);
      await chat.say('The release is on the 14th, read b.txt');
      await afterTurns(dataDir, 2);
      await chat.say('And what were the codename and the day?');
      const last = everything(provider.requests.at(-1));
      expect(last).toContain('AURORA-7731');
      expect(last).toContain('the 14th');
      expect(last).toContain('Goal and requirements');
      expect(last).not.toContain('alpha\nalpha\nalpha');
    },
    TIMEOUT,
  );
});

describe('L9: a result that was cut and is read again', () => {
  it(
    'reads the same file once more and the work goes on',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), read('b.txt'), read('c.txt'), read('a.txt'), reply('read again')],
        summary: Array.from({ length: 8 }, () => text(SUMMARY)),
      });
      const { chat, dataDir } = await chatOn(provider, {
        files: { 'a.txt': 'alpha\n'.repeat(400), 'b.txt': 'beta\n'.repeat(400), 'c.txt': 'g\n' },
      });
      await chat.say('read a, b, c, and a again');
      expect(chat.printed('REPLY')).toEqual(['read again']);
      expect((await logOf(dataDir)).some((r) => r.type === 'TOOL_RESULTS_PRUNED')).toBe(true);
      expect(chat.printed('ERROR')).toEqual([]);
    },
    TIMEOUT,
  );
});
