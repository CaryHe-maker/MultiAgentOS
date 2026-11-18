/**
 * The Agent of a Turn-chat starts subtasks the way a single-agent harness does (Orchestration
 * D112): `subagent` starts one from its prompt alone, `subagent_fork` one that starts from this
 * conversation, both running as `chat-sub`; `mission` hands a goal to Mission's root, which owns it
 * as Mission does (D113) and works in chat's place until it ends (D115). Every case runs the real
 * product from the console down to the Executors, with only the provider's HTTP API scripted per
 * Agent.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { SystemConfig } from '@multiagentos/contracts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openChat,
  reply,
  scriptedAgents,
  textOf,
  tool,
  until,
  type Chat,
  type ChatOptions,
  type ChatRequest,
  type ScriptedChat,
} from './chat-driver.js';
import { agentOfRequest } from './chat-driver.js';

const TIMEOUT = 60_000;
const directories: string[] = [];
const open: Chat[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function chatOn(
  provider: ScriptedChat,
  options: Pick<ChatOptions, 'answer' | 'configure'> = {},
): Promise<Chat> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-delegate-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-delegate-repo-'));
  directories.push(dataDir, repository);
  await writeFile(join(repository, 'notes.txt'), 'the answer is 42\n');
  const chat = await openChat({ dataDir, repository, provider, ...options });
  open.push(chat);
  return chat;
}

/** A subtask returns at once: chat sleeps until it ends, and is woken with its result. */
const waitForTasks = () => tool('sleep', { until: [{ kind: 'children', mode: 'all' }] });
const requestsOf = (provider: ScriptedChat, agent: string): ChatRequest[] =>
  provider.requests.filter((request) => agentOfRequest(request) === agent);
const all = (request: ChatRequest | undefined): string =>
  (request?.messages ?? []).map((message) => textOf(message)).join('\n');
const toolNames = (request: ChatRequest | undefined): string[] =>
  (request?.tools ?? []).map((each) => each.function.name).sort();
const USER_ASKS = 'find what notes.txt says';
const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

describe('subagent and subagent_fork (Orchestration D112)', () => {
  it(
    'starts a fresh chat-sub that answers in text, and hands the text back as its result',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('subagent', {
            description: 'read the notes',
            prompt: 'Read notes.txt and say what it says.',
          }),
          waitForTasks(),
          reply('the notes say 42'),
        ],
        'chat-sub': [
          tool('read_file', { path: 'notes.txt' }),
          { calls: [], text: 'notes.txt says: the answer is 42' },
        ],
      });
      const chat = await chatOn(provider);
      await chat.say(USER_ASKS);
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      expect(chat.printed('REPLY')).toEqual(['the notes say 42']);
      const [chatFirst] = requestsOf(provider, 'main');
      // chat offers the harness's delegation tools and not Mission's run_subagents.
      expect(toolNames(chatFirst)).toEqual(
        expect.arrayContaining(['subagent', 'subagent_fork', 'mission']),
      );
      expect(toolNames(chatFirst)).not.toContain('run_subagents');
      const [subFirst] = requestsOf(provider, 'chat-sub');
      // A fresh child starts from its prompt alone: the user's message is not in its context.
      expect(all(subFirst)).toContain('Read notes.txt and say what it says.');
      expect(all(subFirst)).not.toContain(USER_ASKS);
      expect(toolNames(subFirst)).toContain('finish_subagent');
      expect(toolNames(subFirst)).not.toContain('subagent');
      // Its answer written as text is its result, shown to chat when it wakes.
      const chatWoken = requestsOf(provider, 'main').at(-1);
      expect(all(chatWoken)).toContain('notes.txt says: the answer is 42');
    },
    TIMEOUT,
  );

  it(
    'starts a forked chat-sub that begins with the conversation',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('subagent_fork', { description: 'check it', prompt: 'Check what I asked about.' }),
          waitForTasks(),
          reply('checked'),
        ],
        'chat-sub': [tool('finish_subagent', { summary: 'it is about notes.txt' })],
      });
      const chat = await chatOn(provider);
      await chat.say(USER_ASKS);
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      const [subFirst] = requestsOf(provider, 'chat-sub');
      // A fork starts from this conversation: the user's message is in its context.
      expect(all(subFirst)).toContain(USER_ASKS);
      expect(all(subFirst)).toContain('Check what I asked about.');
      expect(all(requestsOf(provider, 'main').at(-1))).toContain('it is about notes.txt');
    },
    TIMEOUT,
  );
});

describe('mission (Orchestration D113)', () => {
  it(
    'hands a goal to Mission’s root, told as the template tells it, and gets its reply back',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('mission', {
            description: 'deliver the parser',
            goal: 'Write parser.txt with one line: done.',
          }),
        ],
        mission: [
          tool('write_file', { path: 'parser.txt', content: 'done\n' }),
          reply('parser.txt written'),
        ],
      });
      const chat = await chatOn(provider);
      await chat.say('build the parser as a mission');
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      // The Mission works in chat's place (D115): its reply is the answer of the turn.
      expect(chat.printed('REPLY')).toEqual(['parser.txt written']);
      const [root] = requestsOf(provider, 'mission');
      // Mission's root: its own tools, the template's goal and guide, and the goal it owns.
      expect(toolNames(root)).toContain('run_subagents');
      expect(all(root)).toContain('You own this goal from start to delivery');
      expect(all(root)).toContain('Decisions, by what you see.');
      expect(all(root)).toContain('The goal you own:\nWrite parser.txt with one line: done.');
      // It does not see the conversation it was started from.
      expect(all(root)).not.toContain('build the parser as a mission');
      // chat's turn ended with its call, and the delivery does not wake it.
      expect(requestsOf(provider, 'main')).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe('/mission (Orchestration D114)', () => {
  const missionScript = [
    tool('write_file', { path: 'parser.txt', content: 'done\n' }),
    reply('parser.txt written'),
  ];

  it(
    'asks chat again when it does not hand the task to mission, then runs the Mission it writes',
    async () => {
      const provider = scriptedAgents({
        main: [
          // A turn that does the work itself is refused: the user asked for a Mission.
          tool('read_file', { path: 'notes.txt' }),
          tool('mission', {
            description: 'deliver the parser',
            goal: 'Write parser.txt with one line: done.',
          }),
        ],
        mission: missionScript,
      });
      const chat = await chatOn(provider);
      await chat.say('/mission build the parser');
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      expect(chat.printed('REPLY')).toEqual(['parser.txt written']);
      const [first, second] = requestsOf(provider, 'main');
      // chat reads what the user wrote, /mission included.
      expect(all(first)).toContain('/mission build the parser');
      expect(all(second)).toContain('the user sent this message with /mission');
      expect(all(second)).not.toContain('the answer is 42');
      // The Mission starts from the goal chat wrote, not from the conversation.
      const [root] = requestsOf(provider, 'mission');
      expect(all(root)).toContain('The goal you own:\nWrite parser.txt with one line: done.');
      expect(all(root)).not.toContain('/mission build the parser');
    },
    TIMEOUT,
  );

  it(
    'gives up after two retries and goes on with what chat does',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('read_file', { path: 'notes.txt' }),
          tool('read_file', { path: 'notes.txt' }),
          reply('I answered myself'),
        ],
      });
      const chat = await chatOn(provider);
      await chat.say('/mission what do the notes say');
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      expect(chat.printed('REPLY')).toEqual(['I answered myself']);
      expect(requestsOf(provider, 'main')).toHaveLength(3);
      expect(requestsOf(provider, 'mission')).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    'shows how to use /mission when no goal comes with it',
    async () => {
      const provider = scriptedAgents({ main: [reply('unused')] });
      const chat = await chatOn(provider);
      await chat.console.submit('/mission');
      expect(chat.printed('NOTICE').at(-1)).toContain('用法：/mission <目标>');
      expect(provider.requests).toHaveLength(0);
    },
    TIMEOUT,
  );
});

describe('a Mission in chat’s place (Orchestration D115)', () => {
  it(
    'comes back to chat, which waits for the user and goes on with the conversation',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('mission', {
            description: 'deliver the parser',
            goal: 'Write parser.txt with one line: done.',
          }),
          // The next message of the user is answered by chat, which has the Mission's result.
          reply('it wrote one line: done'),
        ],
        mission: [
          tool('write_file', { path: 'parser.txt', content: 'done\n' }),
          reply('parser.txt written with one line: done'),
        ],
      });
      const chat = await chatOn(provider);
      await chat.say('/mission build the parser');
      await until(() => chat.printed('REPLY').length > 0, 'the first reply');
      // The run waits for the user again: nothing ended, no error was shown.
      await until(
        () => chat.lives.at(-1)?.status.includes('等待输入') === true,
        'the run to wait for input',
      );
      expect(chat.printed('ERROR')).toEqual([]);
      const before = requestsOf(provider, 'main').length;
      const missionBefore = requestsOf(provider, 'mission').length;
      await chat.say('what did it write?');
      await until(() => chat.printed('REPLY').length > 1, 'the second reply');
      expect(chat.printed('REPLY')).toEqual([
        'parser.txt written with one line: done',
        'it wrote one line: done',
      ]);
      // Only chat answered the second message, and its context holds the Mission's reply as the
      // result of its call, before what the user wrote next.
      expect(requestsOf(provider, 'mission')).toHaveLength(missionBefore);
      const next = requestsOf(provider, 'main')[before];
      const text = all(next);
      expect(text).toContain('what did it write?');
      expect(text).toContain('parser.txt written with one line: done');
      expect(text.indexOf('parser.txt written with one line: done')).toBeLessThan(
        text.indexOf('what did it write?'),
      );
      // The call is answered as a call to subtasks is: its tool result, then what they came to.
      const messages = next?.messages ?? [];
      const answer = messages.findIndex((message) =>
        textOf(message).includes('subtask(s) finished'),
      );
      expect(messages[answer]?.role).toBe('tool');
      expect(textOf(messages[answer + 1])).toContain('parser.txt written with one line: done');
      await until(
        () => chat.lives.at(-1)?.status.includes('等待输入') === true,
        'the run to wait for input again',
      );
    },
    TIMEOUT,
  );

  it(
    'takes what the user writes while it works as a note to it, and chat is not asked',
    async () => {
      const held = gate();
      const provider = scriptedAgents({
        main: [tool('mission', { description: 'deliver it', goal: 'Write done.txt.' })],
        mission: [
          { wait: held.opened, then: tool('write_file', { path: 'done.txt', content: 'done\n' }) },
          reply('done.txt written, with a header'),
        ],
      });
      const chat = await chatOn(provider);
      await chat.console.submit('/mission write done.txt');
      await until(() => requestsOf(provider, 'mission').length > 0, 'the Mission at work');
      await chat.console.submit('also add a header');
      held.open();
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      expect(chat.printed('REPLY')).toEqual(['done.txt written, with a header']);
      expect(all(requestsOf(provider, 'mission')[1])).toContain('also add a header');
      expect(requestsOf(provider, 'main')).toHaveLength(1);
      expect(all(requestsOf(provider, 'main')[0])).not.toContain('also add a header');
    },
    TIMEOUT,
  );

  it(
    'stopped by the user, it says so, and chat reads that it was stopped when the user writes next',
    async () => {
      const held = gate();
      const provider = scriptedAgents({
        main: [
          tool('mission', { description: 'deliver it', goal: 'Write done.txt.' }),
          reply('the Mission was stopped before it wrote anything'),
        ],
        mission: [{ wait: held.opened, then: reply('never') }],
      });
      const chat = await chatOn(provider);
      await chat.console.submit('/mission write done.txt');
      await until(() => requestsOf(provider, 'mission').length > 0, 'the Mission at work');
      await chat.console.interrupt();
      await until(() => chat.lives.at(-1)?.status === '已暂停', 'the run to be paused');
      await chat.console.interrupt();
      await until(() => chat.lives.at(-1)?.status === '等待输入', 'the turn to end');
      expect(chat.printed('ERROR').join('\n')).toContain('已中止');
      expect(chat.printed('REPLY')).toEqual([]);
      await chat.say('what happened?');
      expect(chat.printed('REPLY')).toEqual(['the Mission was stopped before it wrote anything']);
      // The stop answers chat's call, as it answers any call the stop cut short.
      expect(all(requestsOf(provider, 'main')[1])).toContain('the user stopped it');
    },
    TIMEOUT,
  );

  it(
    'asks the user its own question and goes on with the answer: a question does not end it',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('mission', { description: 'deliver it', goal: 'Write the file the user names.' }),
        ],
        mission: [
          tool('ask_user', { kind: 'ask', question: 'which file name?' }),
          tool('write_file', { path: 'named.txt', content: 'done\n' }),
          reply('named.txt written'),
        ],
      });
      const chat = await chatOn(provider);
      await chat.console.submit('/mission write the file I name');
      await until(() => chat.lives.at(-1)?.pending?.kind === 'QUESTION', 'the question');
      expect(chat.lives.at(-1)?.pending?.text).toContain('which file name?');
      // Nothing was delivered yet, and chat was not asked anything.
      expect(chat.printed('REPLY')).toEqual([]);
      expect(requestsOf(provider, 'main')).toHaveLength(1);
      await chat.console.submit('named.txt');
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      expect(chat.printed('REPLY')).toEqual(['named.txt written']);
      // The answer went to the Mission, as the result of its call.
      const answered = requestsOf(provider, 'mission')[1];
      const answer = answered?.messages.find((message) => textOf(message).includes('named.txt'));
      expect(answer?.role).toBe('tool');
      expect(requestsOf(provider, 'main')).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe('the budget of a Mission in chat’s place (Orchestration D115)', () => {
  // The least an input may open with, counted at whole input limits: after chat's call it cannot
  // lend a Mission the least the Mission works with.
  const LEAST_OF_MAIN = 2_832_000;
  const short = (config: SystemConfig): SystemConfig => ({
    ...config,
    kernel: {
      ...config.kernel,
      budget: { ...config.kernel.budget, inputTokenLimit: LEAST_OF_MAIN, reserveShare: 1 },
    },
  });
  const aboutBudget = (chat: Chat) =>
    chat.questions.filter((question) => question.includes('额度快用完了'));

  it(
    'asks the user for more when chat cannot lend what it needs, and starts it with a yes',
    async () => {
      const provider = scriptedAgents({
        main: [tool('mission', { description: 'deliver it', goal: 'Write done.txt.' })],
        mission: [
          tool('write_file', { path: 'done.txt', content: 'done\n' }),
          reply('done.txt written'),
        ],
      });
      const chat = await chatOn(provider, { configure: short });
      await chat.say('/mission write done.txt');
      // Asked before it started, and again as it runs short: it is topped up as main is.
      expect(aboutBudget(chat).length).toBeGreaterThanOrEqual(1);
      expect(chat.printed('REPLY')).toEqual(['done.txt written']);
      expect(requestsOf(provider, 'main')).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'refuses the call when the user adds nothing, and chat goes on with the refusal',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('mission', { description: 'deliver it', goal: 'Write done.txt.' }),
          reply('there is not enough budget for a Mission'),
        ],
      });
      const chat = await chatOn(provider, { configure: short, answer: () => 'n' });
      await chat.say('write done.txt with a mission');
      expect(aboutBudget(chat)).toHaveLength(1);
      expect(requestsOf(provider, 'mission')).toHaveLength(0);
      expect(all(requestsOf(provider, 'main')[1])).toContain('BUDGET_INSUFFICIENT');
      expect(chat.printed('REPLY')).toEqual(['there is not enough budget for a Mission']);
    },
    TIMEOUT,
  );
});
