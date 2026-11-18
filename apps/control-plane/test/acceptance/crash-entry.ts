/**
 * Test-only child process for S1 (M2Design 14): it reads a file in a Session, then its next model
 * call never returns and it tells the parent, which kills it there with SIGKILL.
 */
import { openChat, scriptedChat, tool, until } from './chat-driver.js';

const [dataDir, repository] = process.argv.slice(2);
if (dataDir === undefined || repository === undefined) throw new Error('dataDir and repository');

const provider = scriptedChat(tool('read_file', { path: 'a.txt' }), {
  response: () => {
    process.stdout.write('BLOCKED\n');
    return new Promise<Response>(() => undefined);
  },
});
const chat = await openChat({ dataDir, repository, provider });
await chat.console.submit('hello');
await until(() => provider.requests.length === 2, 'the second model call', 60_000);
setInterval(() => undefined, 1_000);
