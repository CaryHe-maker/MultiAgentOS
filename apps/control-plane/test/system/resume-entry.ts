/**
 * Test-only child process for the resume case (Orchestration 7.6): it starts a long task whose root
 * splits the work and whose worker writes a file and then works on for long, so the parent can kill
 * the process in the middle of the task.
 */
import { openChat, scriptedAgents, tool } from '../acceptance/chat-driver.js';

const [dataDir, repository] = process.argv.slice(2);
if (dataDir === undefined || repository === undefined) throw new Error('dataDir and repository');

/** A wait that starts when the provider serves the turn. */
const delay = (ms: number): Promise<void> =>
  ({ then: (resolve: () => void) => setTimeout(resolve, ms) }) as unknown as Promise<void>;

const provider = scriptedAgents(
  {
    main: [
      tool('run_subagents', {
        plan: 'One worker writes the notes in out/.',
        tasks: [{ name: 'writer', agent: 'worker', goal: 'write the notes', writeScope: ['out'] }],
      }),
      tool('sleep', { until: [{ kind: 'children' }] }),
    ],
  },
  {
    writer: [
      tool('write_file', { path: 'out/notes.md', content: 'draft\n' }),
      { wait: delay(600_000), then: tool('finish_subagent', { summary: 'never reached' }) },
    ],
  },
);
const chat = await openChat({ dataDir, repository, provider });
const template = chat.system.templateRef('mission');
if (template === undefined) throw new Error('no template mission');
void chat.console.run(template, 'write the notes');
process.stdout.write('STARTED\n');
// The parent kills this process in the middle of the task.
await new Promise(() => undefined);
