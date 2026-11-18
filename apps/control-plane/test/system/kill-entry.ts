/**
 * Test-only child process for the kill-anywhere cases: it runs a short scripted chat (a read, a
 * write the user allows, a reply) slowly enough for the parent to kill it between any two records
 * of the Session log.
 */
import { openChat, reply, scriptedChat, tool, until } from '../acceptance/chat-driver.js';

const [dataDir, repository] = process.argv.slice(2);
if (dataDir === undefined || repository === undefined) throw new Error('dataDir and repository');

const inner = scriptedChat(
  tool('read_file', { path: 'a.txt' }),
  tool('write_file', { path: 'out.txt', content: 'written\n' }),
  reply('done'),
);
const provider = {
  ...inner,
  fetch: async (...args: Parameters<typeof fetch>) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return inner.fetch(...args);
  },
};
const chat = await openChat({ dataDir, repository, provider });
await chat.console.submit('read a.txt and write out.txt');
await until(() => chat.printed('REPLY').length > 0, 'the reply', 60_000);
process.stdout.write('FINISHED\n');
