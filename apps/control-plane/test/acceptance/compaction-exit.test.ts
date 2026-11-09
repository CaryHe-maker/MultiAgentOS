/**
 * The deterministic acceptance cases (M2Design 13, group L): the compaction of a
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
  listSessions,
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
    /** Another process on the place an earlier one left: the same data and the same repository. */
    place?: { dataDir: string; repository: string };
  } & Partial<ChatOptions> = {},
): Promise<{ chat: Chat; dataDir: string; repository: string }> {
  const dataDir = options.place?.dataDir ?? (await mkdtemp(join(tmpdir(), 'mas-compaction-data-')));
  const repository =
    options.place?.repository ?? (await mkdtemp(join(tmpdir(), 'mas-compaction-repo-')));
  if (options.place === undefined) {
    directories.push(dataDir, repository);
    for (const [name, content] of Object.entries(
      options.files ?? {
        'a.txt': 'alpha\n'.repeat(60),
        'b.txt': 'beta\n'.repeat(60),
        'c.txt': 'gamma\n',
      },
    ))
      await writeFile(join(repository, name), content);
  }
  const { compaction, ...rest } = options;
  delete (rest as { files?: unknown }).files;
  delete (rest as { place?: unknown }).place;
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
          keepRatio: 0.00004,
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
      await awaitingInput(chat);
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
      await awaitingInput(chat);
      await chat.console.submit('/compact');
      await until(
        () => chat.records.some((r) => r.text.includes('摘要没有生成')),
        'the notice of the failure',
      );
      expect((await logOf(dataDir)).some((r) => r.type === 'CONTEXT_COMPACTED')).toBe(false);

      // Why it did not come is on the audit for whoever looks: the stage and the code of each try,
      // never what was written.
      // The audit is written beside the work; the failure entry comes after both problems.
      for (let wait = 0; wait < 400; wait += 1) {
        if ((await auditOf(dataDir)).includes('COMPACTION_FAILED')) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const problems = (await auditOf(dataDir))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry['type'] === 'COMPACTION_SUMMARY_PROBLEM');
      expect(
        problems.map((entry) => [entry['stage'], entry['reasonCode'], entry['strict']]),
      ).toEqual([
        ['MODEL', 'COMPACTION_SUMMARY_INVALID', false],
        ['MODEL', 'COMPACTION_SUMMARY_INVALID', true],
      ]);
      expect(JSON.stringify(problems)).not.toContain('I will not summarise');

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

/**
 * A reply is printed before the run waits for the next input; a command that needs the run to
 * wait (`/compact`, `/undo`) waits for what the interface shows, not for the log.
 */
const awaitingInput = (chat: Chat) =>
  until(() => chat.lives.at(-1)?.status.includes('等待输入') === true, 'the end of the Turn');
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

      await awaitingInput(chat);
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
      await awaitingInput(chat);
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

describe('L11: /compact in a Session that was just opened', () => {
  it(
    'compacts right away, as it does in the middle of a conversation, with no AgentRun of this process',
    async () => {
      // A conversation with history in it; nothing compacts by itself.
      const earlier = scriptedAgents({
        main: [read('a.txt'), read('b.txt'), reply('both read')],
        summary: [],
      });
      const first = await chatOn(earlier, { compaction: { triggerRatio: 0.99 } });
      await first.chat.say('read the two files');
      await awaitingInput(first.chat);
      await first.chat.close();
      open.splice(open.indexOf(first.chat), 1);

      // A new process opens it and, before anything is said, asks for a compaction.
      const later = scriptedAgents({ main: [reply('and now')], summary: [text(SUMMARY)] });
      const { chat, dataDir } = await chatOn(later, {
        place: { dataDir: first.dataDir, repository: first.repository },
        compaction: { triggerRatio: 0.99 },
      });
      await listSessions(chat);
      await chat.console.submit('/resume 1');
      await until(
        () => chat.printed('NOTICE').some((text) => text.includes('已打开')),
        'the Session to be open',
      );
      await awaitingInput(chat);
      await chat.console.submit('/compact');
      await until(
        () => chat.printed('STEP').some((text) => text.includes('已压缩较早的对话')),
        'the compaction',
      );
      // Nothing was said to the model before it: the one request so far is the summary request.
      expect(later.requests).toHaveLength(1);
      expect(everything(later.requests[0])).toContain('Use exactly');
      expect((await logOf(dataDir)).some((r) => r.type === 'CONTEXT_COMPACTED')).toBe(true);

      await chat.say('go on');
      expect(chat.printed('REPLY')).toContain('and now');
      expect(everything(later.requests.at(-1))).toContain('Goal and requirements');
    },
    TIMEOUT,
  );
});

/**
 * Opens the Session an earlier process left, in a new process on the same place, and waits until
 * it waits for input: the state a user is in right after choosing a conversation to go on with.
 */
async function reopen(
  place: { dataDir: string; repository: string },
  provider: ScriptedChat,
  compaction: Record<string, unknown> = { triggerRatio: 0.99 },
) {
  const opened = await chatOn(provider, { place, compaction });
  const { chat } = opened;
  await listSessions(chat);
  await chat.console.submit('/resume 1');
  await until(() => chat.printed('NOTICE').some((text) => text.includes('已打开')), 'the Session');
  await awaitingInput(chat);
  return opened;
}

const summaries = (provider: ScriptedChat) =>
  provider.requests.filter((r) => textOf(r.messages.at(-1)).includes('Use exactly these sections'));
const mains = (provider: ScriptedChat) =>
  provider.requests.filter(
    (r) => !textOf(r.messages.at(-1)).includes('Use exactly these sections'),
  );
const compactedRecords = async (dataDir: string) =>
  (await logOf(dataDir)).filter((r) => r.type === 'CONTEXT_COMPACTED');
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('L14: before there is a Session, and at the first request of a new one', () => {
  it(
    'refuses /compact where there is nothing to compact, and asks nothing of the model at the first request',
    async () => {
      // A threshold every context passes: what is there to compact at the very first request?
      const provider = scriptedAgents({ main: [reply('hello')], summary: [] });
      const { chat } = await chatOn(provider);
      await chat.console.submit('/compact');
      expect(chat.printed('NOTICE').at(-1)).toBe('当前不能使用这条指令。');
      expect(provider.requests).toHaveLength(0);

      await chat.say('hi');
      expect(chat.printed('REPLY')).toEqual(['hello']);
      expect(summaries(provider)).toHaveLength(0);
      expect(mains(provider)).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe('L15: /compact where the context is too short to be worth it', () => {
  it(
    'says so, asks nothing of the model, changes nothing, and the work goes on',
    async () => {
      const provider = scriptedAgents({ main: [reply('hello'), reply('still here')], summary: [] });
      // The newest 15% of the limit stays as it is: a few words are all of it.
      const { chat, dataDir } = await chatOn(provider, {
        compaction: { triggerRatio: 0.99, keepRatio: 0.15 },
      });
      await chat.say('hi');
      await awaitingInput(chat);
      await chat.console.submit('/compact');
      await until(
        () =>
          chat.printed('NOTICE').at(-1) === '无法压缩：抱歉，目前的上下文记录仍较短，无法有效压缩',
        'the notice that it is too short',
      );
      expect(summaries(provider)).toHaveLength(0);
      expect(await compactedRecords(dataDir)).toHaveLength(0);
      // The line that said the system was compacting is gone.
      expect(chat.lives.at(-1)?.activity.some((line) => line.label === '系统')).toBe(false);

      await chat.say('are you there?');
      expect(chat.printed('REPLY')).toEqual(['hello', 'still here']);
    },
    TIMEOUT,
  );
});

describe('L16: compacting again and again', () => {
  it(
    'has the second summary take the first one in, and a compaction with nothing new says so',
    async () => {
      const provider = scriptedAgents({
        main: [read('a.txt'), reply('first'), read('b.txt'), reply('second'), reply('third')],
        summary: [text(SUMMARY), text(SUMMARY), text(SUMMARY)],
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      const compact = async (count: number) => {
        await awaitingInput(chat);
        await chat.console.submit('/compact');
        await until(
          () =>
            chat.printed('STEP').filter((text) => text.includes('已压缩较早的对话')).length >=
            count,
          `compaction number ${String(count)}`,
        );
      };
      await chat.say('read a.txt');
      await compact(1);
      await chat.say('read b.txt');
      await compact(2);
      expect(await compactedRecords(dataDir)).toHaveLength(2);

      // Nothing new since: the summary alone is not worth another.
      await awaitingInput(chat);
      await chat.console.submit('/compact');
      await until(
        () =>
          chat.printed('NOTICE').at(-1) === '无法压缩：抱歉，目前的上下文记录仍较短，无法有效压缩',
        'the notice that there is nothing new to compact',
      );
      expect(await compactedRecords(dataDir)).toHaveLength(2);

      await chat.say('and now?');
      const last = everything(mains(provider).at(-1));
      // One summary, the newest: it took the first one in.
      expect(occurrences(last, 'Goal and requirements')).toBe(1);
      expect(chat.printed('REPLY')).toEqual(['first', 'second', 'third']);
    },
    TIMEOUT,
  );
});

describe('L17: going on from a Session that was compacted', () => {
  it(
    'starts from the summary after it is opened again, compacts once more, and a fork has it too',
    async () => {
      const first = await chatOn(
        scriptedAgents({
          main: [read('a.txt'), reply('first')],
          summary: [text(SUMMARY)],
        }),
        { compaction: { triggerRatio: 0.99 } },
      );
      await first.chat.say('read a.txt');
      await awaitingInput(first.chat);
      await first.chat.console.submit('/compact');
      await until(
        () => first.chat.printed('STEP').some((text) => text.includes('已压缩较早的对话')),
        'the compaction',
      );
      await first.chat.close();
      open.splice(open.indexOf(first.chat), 1);

      const later = scriptedAgents({
        main: [read('b.txt'), reply('second'), reply('in the fork')],
        summary: [text(SUMMARY)],
      });
      const { chat, dataDir } = await reopen(first, later);
      await chat.say('read b.txt');
      // The summary of the earlier process is what the model starts from.
      expect(everything(mains(later)[0])).toContain('Goal and requirements');

      // And it compacts again, in this process, with no AgentRun made for it.
      await awaitingInput(chat);
      await chat.console.submit('/compact');
      await until(
        () => chat.printed('STEP').filter((text) => text.includes('已压缩较早的对话')).length >= 1,
        'the second compaction',
      );
      expect(await compactedRecords(dataDir)).toHaveLength(2);

      // A fork carries the history as it stands: the summary, not what it replaced.
      await awaitingInput(chat);
      await chat.console.submit('/fork');
      await chat.say('in the fork');
      const forked = everything(mains(later).at(-1));
      expect(forked).toContain('Goal and requirements');
      expect(occurrences(forked, 'Goal and requirements')).toBe(1);
    },
    TIMEOUT,
  );
});

describe('L18: a Session opened already over the threshold', () => {
  it(
    'is compacted by the first request, before the model is asked, and the answer comes from the summary',
    async () => {
      const first = await chatOn(
        scriptedAgents({ main: [read('a.txt'), read('b.txt'), reply('both read')], summary: [] }),
        { compaction: { triggerRatio: 0.99 } },
      );
      await first.chat.say('read the two files');
      await awaitingInput(first.chat);
      await first.chat.close();
      open.splice(open.indexOf(first.chat), 1);

      // Opened again with a threshold the context is far over. Nothing compacts by itself while
      // the user only looks.
      const later = scriptedAgents({ main: [reply('after')], summary: [text(SUMMARY)] });
      const { chat, dataDir } = await reopen(first, later, {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(later.requests).toHaveLength(0);
      expect(chat.lives.at(-1)?.status).toContain('等待输入');

      await chat.say('go on');
      // The summary is asked for first; the model that answers has it.
      expect(summaries(later)).toHaveLength(1);
      expect(later.requests.indexOf(summaries(later)[0] as never)).toBe(0);
      expect(everything(mains(later)[0])).toContain('Goal and requirements');
      expect(chat.printed('REPLY')).toContain('after');
      expect(await compactedRecords(dataDir)).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe('L19: a message that comes while /compact is working', () => {
  it(
    'waits for the compaction, and is answered from the summary',
    async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = scriptedAgents({
        main: [read('a.txt'), reply('a read'), reply('and the next')],
        summary: [{ wait: held, then: text(SUMMARY) }],
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      await chat.say('read a.txt');
      await awaitingInput(chat);
      await chat.console.submit('/compact');
      await until(() => summaries(provider).length === 1, 'the summary request');
      // The line says the system is at work, with a time.
      expect(chat.lives.at(-1)?.activity.some((line) => line.label === '系统')).toBe(true);

      await chat.console.submit('go on');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(chat.printed('REPLY')).toEqual(['a read']);
      release();
      await until(() => chat.printed('REPLY').length === 2, 'the reply after the compaction');
      const types = (await logOf(dataDir)).map((r) => r.type);
      expect(types.indexOf('CONTEXT_COMPACTED')).toBeLessThan(types.lastIndexOf('MODEL_TURN'));
      expect(everything(mains(provider).at(-1))).toContain('Goal and requirements');
    },
    TIMEOUT,
  );
});

describe('L20: /compact when it cannot be done now', () => {
  it(
    'is refused while a run is going and while a compaction is going, and nothing is started',
    async () => {
      let releaseMain: () => void = () => undefined;
      const heldMain = new Promise<void>((resolve) => {
        releaseMain = resolve;
      });
      let releaseSummary: () => void = () => undefined;
      const heldSummary = new Promise<void>((resolve) => {
        releaseSummary = resolve;
      });
      const provider = scriptedAgents({
        main: [read('a.txt'), { wait: heldMain, then: reply('slow') }, reply('done')],
        summary: [{ wait: heldSummary, then: text(SUMMARY) }],
      });
      const { chat } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      const refused = '暂时无法压缩：请等当前运行或正在进行的压缩结束后再试。';

      // While the run is going.
      await chat.console.submit('a slow one');
      await until(() => mains(provider).length === 2, 'the run to be under way');
      await chat.console.submit('/compact');
      expect(chat.printed('NOTICE').at(-1)).toBe(refused);
      expect(summaries(provider)).toHaveLength(0);
      releaseMain();
      await until(() => chat.printed('REPLY').length === 1, 'the slow reply');
      await awaitingInput(chat);

      // While a compaction is going.
      await chat.console.submit('/compact');
      await until(() => summaries(provider).length === 1, 'the summary request');
      await chat.console.submit('/compact');
      expect(chat.printed('NOTICE').at(-1)).toBe(refused);
      expect(summaries(provider)).toHaveLength(1);
      releaseSummary();
      await until(
        () => chat.printed('STEP').some((text) => text.includes('已压缩较早的对话')),
        'the compaction',
      );
      await chat.say('and now?');
      expect(chat.printed('REPLY')).toEqual(['slow', 'done']);
    },
    TIMEOUT,
  );
});

describe('L21: a compaction that is left behind', () => {
  it(
    'is cancelled by /fork: nothing is written to the Session it was for, and the fork goes on',
    async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = scriptedAgents({
        main: [read('a.txt'), reply('a read'), reply('in the fork')],
        summary: [{ wait: held, then: text(SUMMARY) }],
      });
      const { chat, dataDir } = await chatOn(provider, { compaction: { triggerRatio: 0.99 } });
      await chat.say('read a.txt');
      await awaitingInput(chat);
      const original = await sessionDirectory(dataDir);
      await chat.console.submit('/compact');
      await until(() => summaries(provider).length === 1, 'the summary request');

      await chat.console.submit('/fork');
      release();
      await chat.say('in the fork');
      expect(chat.printed('REPLY')).toContain('in the fork');
      // Nothing of the summary reached the Session it was made for.
      const log = await readFile(join(original, 'workflow', 'log.v1.jsonl'), 'utf8');
      expect(log).not.toContain('CONTEXT_COMPACTED');
      const audit = await readFile(join(original, 'kernel-core', 'audit.jsonl'), 'utf8');
      expect(audit).toContain('COMPACTION_FAILED');
      expect(audit).not.toContain('COMPACTION_ENDED');
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
