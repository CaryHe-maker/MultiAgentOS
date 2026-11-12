/**
 * A template the user keeps in the repository (M2Design 3.8, the strict mode of Phase2Plan 2):
 * `mas run <id>` finds `.multiagentos/workflows/<id>.yaml`, checks it before anything starts and
 * names the rule and node of each problem; a template that holds runs like a built-in one. The
 * whole product runs from the console down to the Executors; only the provider is scripted.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLI_MESSAGES } from '@multiagentos/cli';
import type { ConsoleView } from '@multiagentos/user-interaction';
import { afterEach, describe, expect, it } from 'vitest';
import { composeSystem } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import { scriptedAgents, tool, type ScriptedChat } from './chat-driver.js';

const TIMEOUT = 120_000;
const OFFLINE_KEY = 'sk-acceptance-offline-key-0000';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function systemOn(files: Readonly<Record<string, string>>, provider?: ScriptedChat) {
  const root = await mkdtemp(join(tmpdir(), 'mas-template-'));
  directories.push(root);
  const repository = join(root, 'repo');
  for (const [name, content] of Object.entries({ 'README.md': 'demo\n', ...files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  const notices: string[] = [];
  const view: ConsoleView = {
    print: (record) => void notices.push(`${record.kind}: ${record.text}`),
    update: () => undefined,
    restoreInput: () => undefined,
  };
  const original = globalThis.fetch;
  if (provider !== undefined) globalThis.fetch = provider.fetch;
  try {
    const system = await composeSystem({
      config: { ...defaultSystemConfig(), dataDir: join(root, 'data') },
      repositoryRoot: await realpath(repository),
      preset: 'standard',
      view,
      credentials: { apiKeyFor: () => OFFLINE_KEY },
      log: () => undefined,
    });
    return { system, notices };
  } finally {
    globalThis.fetch = original;
  }
}

describe('a template of the repository (M2Design 3.8)', () => {
  it('names the rule and node of each problem, and nothing starts', async () => {
    const { system } = await systemOn({
      '.multiagentos/workflows/split.yaml': [
        'nodes:',
        '  - name: api',
        '    kind: AGENT',
        '    agent: worker',
        '    output: true',
        '  - name: ui',
        '    kind: AGENT',
        '    agent: worker',
        '  - name: docs',
        '    kind: AGENT',
        '    agent: wizard',
      ].join('\n'),
    });
    expect(await system.repositoryTemplate('nothing-here')).toBeUndefined();
    const found = await system.repositoryTemplate('split');
    expect(found?.ok).toBe(false);
    if (found === undefined || found.ok) return;
    const text = CLI_MESSAGES.invalidTemplate('split', found.issues);
    expect(text).toContain('模板 split 无效，没有开始运行');
    expect(text).toContain('规则 UNKNOWN_AGENT，节点 docs');
    expect(system.templateRef('split')).toBeUndefined();
  });

  it(
    'runs a template that holds like a built-in one',
    async () => {
      const provider = scriptedAgents({
        main: [tool('reply', { text: 'the repository template ran' })],
      });
      const { system, notices } = await systemOn(
        {
          '.multiagentos/workflows/answer.yaml': [
            'description: answer from the repository',
            'nodes:',
            '  - name: answer',
            '    kind: AGENT',
            '    agent: main',
            '    output: true',
          ].join('\n'),
        },
        provider,
      );
      const found = await system.repositoryTemplate('answer');
      expect(found).toMatchObject({ ok: true, ref: { id: 'answer' } });
      if (found === undefined || !found.ok) return;
      const original = globalThis.fetch;
      globalThis.fetch = provider.fetch;
      try {
        await system.start();
        const code = await system.run(async (console) => {
          const exit = await console.run(found.ref, 'say what ran');
          await console.shutdown('RUN_FINISHED');
          return exit;
        });
        expect(code).toBe(0);
      } finally {
        globalThis.fetch = original;
      }
      expect(notices.join('\n')).toContain('the repository template ran');
    },
    TIMEOUT,
  );
});
