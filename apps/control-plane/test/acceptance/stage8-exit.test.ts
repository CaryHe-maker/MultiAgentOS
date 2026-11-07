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
