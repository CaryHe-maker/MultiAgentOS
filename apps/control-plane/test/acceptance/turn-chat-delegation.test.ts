/**
 * The Agent of a Turn-chat starts subtasks the way a single-agent harness does (Orchestration
 * D112): `subagent` starts one from its prompt alone, `subagent_fork` one that starts from this
 * conversation, both running as `chat-sub`; `mission` hands a goal to Mission's root, which owns it
 * as Mission does (D113). Every case runs the real product from the console down to the Executors,
 * with only the provider's HTTP API scripted per Agent.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function chatOn(provider: ScriptedChat): Promise<Chat> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-delegate-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-delegate-repo-'));
  directories.push(dataDir, repository);
  await writeFile(join(repository, 'notes.txt'), 'the answer is 42\n');
  const chat = await openChat({ dataDir, repository, provider });
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
          waitForTasks(),
          reply('the mission delivered'),
        ],
        mission: [
          tool('write_file', { path: 'parser.txt', content: 'done\n' }),
          // A task that changed files is sent back once until it checked them: it answers again.
          reply('parser.txt written'),
          reply('parser.txt written'),
        ],
      });
      const chat = await chatOn(provider);
      await chat.say('build the parser as a mission');
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      expect(chat.printed('REPLY')).toEqual(['the mission delivered']);
      const [root] = requestsOf(provider, 'mission');
      // Mission's root: its own tools, the template's goal and guide, and the goal it owns.
      expect(toolNames(root)).toContain('run_subagents');
      expect(all(root)).toContain('You own this goal from start to delivery');
      expect(all(root)).toContain('Decisions, by what you see.');
      expect(all(root)).toContain('The goal you own:\nWrite parser.txt with one line: done.');
      // It does not see the conversation it was started from.
      expect(all(root)).not.toContain('build the parser as a mission');
      // Its reply is its result, which chat reads when it wakes.
      expect(all(requestsOf(provider, 'main').at(-1))).toContain('parser.txt written');
    },
    TIMEOUT,
  );
});
