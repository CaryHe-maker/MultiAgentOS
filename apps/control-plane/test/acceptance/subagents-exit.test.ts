/**
 * The deterministic acceptance cases (M2Design 13): SubAgents running together
 * (P), their budgets (B) and what the user sees of them. Every case runs the real product from
 * the console down to the Executors, with only the provider's HTTP API scripted per Agent; what
 * the model would see is read from the requests the provider received.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SystemConfig } from '@multiagentos/contracts';
import { probeSandbox } from '@multiagentos/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  barrier,
  openChat,
  scriptedAgents,
  textOf,
  tool,
  until,
  type Chat,
  type ChatOptions,
  type ScriptedChat,
} from './chat-driver.js';

const TIMEOUT = 90_000;
const bwrapWorks = (await probeSandbox(tmpdir())).available;
const real = bwrapWorks ? describe : describe.skip;

const directories: string[] = [];
const open: Chat[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface Place {
  readonly dataDir: string;
  readonly repository: string;
}

async function roots(files: Readonly<Record<string, string>> = {}): Promise<Place> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-subagents-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-subagents-repo-'));
  directories.push(dataDir, repository);
  for (const [name, content] of Object.entries({ 'a.txt': 'one\n', ...files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  return { dataDir, repository };
}

async function chatOn(
  place: Place,
  provider: ScriptedChat,
  options: Partial<ChatOptions> = {},
): Promise<Chat> {
  const chat = await openChat({ ...place, provider, ...options });
  open.push(chat);
  return chat;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const seen = (provider: ScriptedChat): string =>
  provider.requests
    .flatMap((request) => request.messages.map((message) => textOf(message)))
    .join('\n');
const toolNames = (request: ScriptedChat['requests'][number] | undefined): string[] =>
  (request?.tools ?? []).map((each) => each.function.name).sort();
const finish = (summary: string, extra: Record<string, unknown> = {}) =>
  tool('finish_subagent', { summary, findings: [], ...extra });
const finishWorker = (summary: string, changedFiles: string[], extra: object = {}) =>
  tool('finish_subagent', {
    summary,
    changedFiles,
    status: 'done',
    validation: [],
    ...extra,
  });
const spawn = (...tasks: Record<string, unknown>[]) => tool('run_subagents', { tasks });
const reply = (text: string) => tool('reply', { text });
const doneReplies = (chat: Chat, count: number) =>
  until(() => chat.printed('REPLY').length >= count, `${String(count)} replies`);

describe('P2: two workers with separate scopes', () => {
  it(
    'run at the same time, write only inside their own scope, and the caller gets both results',
    async () => {
      const place = await roots({ 'api/old.txt': 'old\n', 'ui/old.txt': 'old\n' });
      const together = barrier(2);
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'fix-api', agent: 'worker', goal: 'write api/new.txt', writeScope: ['api'] },
              { name: 'fix-ui', agent: 'worker', goal: 'write ui/new.txt', writeScope: ['ui'] },
            ),
            reply('both done'),
          ],
        },
        {
          'fix-api': [
            {
              wait: together(),
              then: tool('write_file', { path: 'api/new.txt', content: 'api\n' }),
            },
            finishWorker('wrote api', ['api/new.txt']),
            finishWorker('wrote api', ['api/new.txt']),
          ],
          'fix-ui': [
            { wait: together(), then: tool('write_file', { path: 'ui/new.txt', content: 'ui\n' }) },
            finishWorker('wrote ui', ['ui/new.txt']),
            finishWorker('wrote ui', ['ui/new.txt']),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('change both');

      expect(await readFile(join(place.repository, 'api/new.txt'), 'utf8')).toBe('api\n');
      expect(await readFile(join(place.repository, 'ui/new.txt'), 'utf8')).toBe('ui\n');
      expect(chat.printed('REPLY')).toContain('both done');
      // The caller read both results, in the order it wrote the tasks.
      const last = textOf(provider.requests.at(-1)?.messages.at(-1));
      const lastMessages =
        provider.requests
          .at(-1)
          ?.messages.map((m) => textOf(m))
          .join('\n') ?? '';
      expect(lastMessages).toContain('Result of task fix-api (worker): DONE');
      expect(lastMessages).toContain('Result of task fix-ui (worker): DONE');
      expect(lastMessages.indexOf('fix-api (worker)')).toBeLessThan(
        lastMessages.indexOf('fix-ui (worker)'),
      );
      expect(last.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    'refuses a write outside the worker scope, leaves the other scope alone, and says so in the result',
    async () => {
      const place = await roots({ 'api/old.txt': 'old\n', 'ui/old.txt': 'old\n' });
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'fix-api', agent: 'worker', goal: 'change the api', writeScope: ['api'] },
              { name: 'fix-ui', agent: 'worker', goal: 'change the ui', writeScope: ['ui'] },
            ),
            reply('done'),
          ],
        },
        {
          'fix-api': [
            tool('write_file', { path: 'ui/stolen.txt', content: 'x\n' }),
            finishWorker('blocked', [], {
              status: 'blocked',
              blockers: ['needs ui/stolen.txt, outside my scope'],
            }),
          ],
          'fix-ui': [
            tool('write_file', { path: 'ui/new.txt', content: 'ui\n' }),
            finishWorker('wrote ui', ['ui/new.txt']),
            finishWorker('wrote ui', ['ui/new.txt']),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('change both');
      expect(await exists(join(place.repository, 'ui/stolen.txt'))).toBe(false);
      expect(await exists(join(place.repository, 'ui/new.txt'))).toBe(true);
      const all = seen(provider);
      expect(all).toContain('Result of task fix-api (worker): BLOCKED');
      expect(all).toContain('Result of task fix-ui (worker): DONE');
    },
    TIMEOUT,
  );
});

describe('the tools of each Agent', () => {
  it(
    'give main run_subagents, a worker the tools to change files, and an explorer only to read',
    async () => {
      const place = await roots({ 'src/auth.ts': 'export const auth = 1;\n' });
      const provider = scriptedAgents({
        main: [
          spawn(
            { name: 'look', agent: 'explorer', goal: 'find auth' },
            { name: 'change', agent: 'worker', goal: 'edit', writeScope: ['src'] },
          ),
          reply('ok'),
        ],
        explorer: [finish('found auth in src/auth.ts')],
        worker: [finishWorker('nothing to do', [])],
      });
      const chat = await chatOn(place, provider);
      await chat.say('go');
      const request = (agent: string) =>
        provider.requests.find((each) => {
          const names = toolNames(each);
          if (agent === 'main') return names.includes('run_subagents');
          if (agent === 'worker')
            return names.includes('write_file') && names.includes('finish_subagent');
          return names.includes('finish_subagent') && !names.includes('write_file');
        });
      expect(toolNames(request('main'))).toEqual(
        expect.arrayContaining(['run_subagents', 'reply', 'ask_user']),
      );
      const explorer = toolNames(request('explorer'));
      expect(explorer).toEqual(expect.arrayContaining(['read_file', 'finish_subagent']));
      for (const forbidden of [
        'write_file',
        'edit_file',
        'run_command',
        'run_subagents',
        'reply',
        'ask_user',
      ])
        expect(explorer).not.toContain(forbidden);
      const worker = toolNames(request('worker'));
      expect(worker).toEqual(
        expect.arrayContaining([
          'write_file',
          'edit_file',
          'finish_subagent',
          'update_todos',
          'ask_user',
        ]),
      );
      for (const forbidden of ['run_subagents', 'reply']) expect(worker).not.toContain(forbidden);
    },
    TIMEOUT,
  );
});

describe('dependencies and results', () => {
  it(
    'give a task the result of the one it waits for, and the caller the written order',
    async () => {
      const place = await roots({ 'src/auth.ts': 'export const auth = 1;\n' });
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              {
                name: 'apply',
                agent: 'worker',
                goal: 'apply what the survey found',
                writeScope: ['src'],
                dependsOn: ['survey'],
              },
              { name: 'survey', agent: 'explorer', goal: 'find the auth code' },
            ),
            reply('done'),
          ],
          explorer: [finish('auth lives in src/auth.ts, nothing else')],
        },
        {
          apply: [
            tool('write_file', { path: 'src/auth.ts', content: 'export const auth = 2;\n' }),
            finishWorker('changed auth', ['src/auth.ts']),
            finishWorker('changed auth', ['src/auth.ts']),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      const worker = provider.requests.find((each) => {
        const names = toolNames(each);
        return names.includes('write_file') && names.includes('finish_subagent');
      });
      const workerSees = worker?.messages.map((m) => textOf(m)).join('\n') ?? '';
      expect(workerSees).toContain('Your task (apply, worker)');
      expect(workerSees).toContain('Result of task survey (explorer): DONE');
      expect(workerSees).toContain('auth lives in src/auth.ts, nothing else');
      // The worker is not shown what the user typed.
      // (A message of its own: the name of the temporary directory may end in the same letters.)
      expect(worker?.messages.map((m) => textOf(m)) ?? []).not.toContain('go');
      const lastMessages =
        provider.requests
          .at(-1)
          ?.messages.map((m) => textOf(m))
          .join('\n') ?? '';
      expect(lastMessages.indexOf('task apply')).toBeLessThan(lastMessages.indexOf('task survey'));
    },
    TIMEOUT,
  );
});

describe('B2: more than the caller can lend', () => {
  it(
    'starts nothing, and tells the caller what it can lend',
    async () => {
      const place = await roots();
      const provider = scriptedAgents({
        main: [
          spawn(
            {
              name: 'one',
              agent: 'worker',
              goal: 'x',
              writeScope: ['a'],
              budget: { tokens: 1_200_000 },
            },
            {
              name: 'two',
              agent: 'worker',
              goal: 'y',
              writeScope: ['b'],
              budget: { tokens: 1_200_000 },
            },
          ),
          reply('by myself'),
        ],
      });
      const chat = await chatOn(place, provider, {
        configure: (config: SystemConfig) => ({
          ...config,
          kernel: {
            ...config.kernel,
            budget: { ...config.kernel.budget, turnTokenLimit: 3_000_000 },
          },
        }),
      });
      await chat.say('go');
      expect(provider.requests).toHaveLength(2);
      const answer = textOf(provider.requests[1]?.messages.filter((m) => m.role === 'tool').at(-1));
      expect(answer).toMatch(/BUDGET_INSUFFICIENT: at most \d+ tokens can be lent/u);
      expect(chat.printed('REPLY')).toContain('by myself');
    },
    TIMEOUT,
  );
});

describe('what the user sees', () => {
  it(
    'shows SubAgents under the caller, and /timeline lists every AgentRun of the run',
    async () => {
      const place = await roots({ 'src/auth.ts': 'x\n' });
      const provider = scriptedAgents({
        main: [spawn({ name: 'survey', agent: 'explorer', goal: 'look' }), reply('done')],
        explorer: [finish('looked')],
      });
      const chat = await chatOn(place, provider);
      await chat.say('go');
      const branches = chat.lives.flatMap((live) =>
        live.activity.filter((line) => line.label.startsWith('explorer survey')),
      );
      expect(branches.length).toBeGreaterThan(0);
      expect(branches.every((line) => line.branch?.endsWith('└─ ') === true)).toBe(true);
      await doneReplies(chat, 1);
      await chat.console.submit('/timeline');
      const timeline = chat.printed('NOTICE').at(-1) ?? '';
      expect(timeline).toContain('main');
      expect(timeline).toContain('  explorer survey');
    },
    TIMEOUT,
  );
});

real('what a command changed (M2Design 7.1)', () => {
  it(
    'is found by scanning the write scope, and marked against what the worker reports',
    async () => {
      const place = await roots({ 'out/old.txt': 'old\n' });
      const sha = 'a'.repeat(64);
      const provider = scriptedAgents(
        {
          main: [
            spawn({ name: 'make', agent: 'worker', goal: 'make a file', writeScope: ['out'] }),
            reply('done'),
          ],
        },
        {
          make: [
            tool('run_command', { command: 'echo made > out/made.txt && rm out/old.txt' }),
            finishWorker('ran a command', [], {
              validation: [
                {
                  command: 'echo',
                  exitCode: 0,
                  outputRef: {
                    artifactId: `art_${sha}`,
                    sha256: sha,
                    size: 1,
                    mediaType: 'text/plain',
                  },
                },
              ],
            }),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(await exists(join(place.repository, 'out/made.txt'))).toBe(true);
      expect(await exists(join(place.repository, 'out/old.txt'))).toBe(false);
      expect(seen(provider)).toContain('changed but not reported: out/made.txt, out/old.txt');
    },
    TIMEOUT,
  );
});

real('A: one question for the same command, whoever asks (M2Design 5.5)', () => {
  it(
    'asks once when two workers want the same command at the same time, and both then run it',
    async () => {
      const place = await roots({ 'a/x.txt': 'x\n', 'b/y.txt': 'y\n' });
      const together = barrier(2);
      const sha = 'a'.repeat(64);
      const finishing = (summary: string) =>
        finishWorker(summary, [], {
          validation: [
            {
              command: 'touch made.txt',
              exitCode: 0,
              outputRef: {
                artifactId: `art_${sha}`,
                sha256: sha,
                size: 1,
                mediaType: 'text/plain',
              },
            },
          ],
        });
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'left', agent: 'worker', goal: 'say hi', writeScope: ['a'] },
              { name: 'right', agent: 'worker', goal: 'say hi', writeScope: ['b'] },
            ),
            reply('done'),
          ],
        },
        {
          left: [
            {
              wait: together(),
              then: tool('run_command', { command: 'touch made.txt' }),
            },
            finishing('left said hi'),
          ],
          right: [
            {
              wait: together(),
              then: tool('run_command', { command: 'touch made.txt' }),
            },
            finishing('right said hi'),
          ],
        },
      );
      const chat = await chatOn(place, provider, {
        // "This command, for the rest of the run" covers the second worker.
        answer: (question) => (question.includes('运行这条命令') ? 'c' : 'y'),
      });
      await chat.say('go');
      expect(chat.questions.filter((each) => each.includes('运行这条命令'))).toHaveLength(1);
      const all = seen(provider);
      expect(all).toContain('Result of task left (worker): DONE');
      expect(all).toContain('Result of task right (worker): DONE');
    },
    TIMEOUT,
  );
});
