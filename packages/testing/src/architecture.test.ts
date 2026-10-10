import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

/** Internal dependencies each workspace may declare (docs/M1/M1TechStack.md 3). */
const ALLOWED_INTERNAL_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'packages/libraries/contracts': [],
  'packages/libraries/agent-tool-pool': ['contracts'],
  'packages/libraries/executor-set': ['contracts'],
  'packages/infrastructure/fabric': ['contracts'],
  'packages/infrastructure/module-host': ['contracts'],
  'packages/infrastructure/persistence': ['contracts'],
  'packages/infrastructure/artifacts': ['contracts'],
  'packages/modules/kernel': ['contracts', 'fabric'],
  'packages/modules/workflow': ['contracts', 'fabric'],
  'packages/modules/user-interaction': ['contracts', 'fabric'],
  'apps/cli': ['contracts', 'user-interaction'],
  'apps/control-plane': [
    'agent-tool-pool',
    'artifacts',
    'cli',
    'contracts',
    'executor-set',
    'fabric',
    'kernel',
    'module-host',
    'persistence',
    'user-interaction',
    'workflow',
  ],
};

/** Every workspace sits in exactly one of these groups; `packages/testing` is the only other one. */
const WORKSPACE_GROUPS = [
  'apps',
  'packages/modules',
  'packages/libraries',
  'packages/infrastructure',
];

/** Kernel components whose data is isolated (docs/M1/Kernel/Interaction.md 3.2). */
const KERNEL_COMPONENTS = ['core', 'execution', 'monitor', 'scheduler', 'gateway', 'supervisor'];
const PROVIDER_SDK = /from '(?:ai|@ai-sdk\/[^']+)'/u;
const CHILD_PROCESS = /from '(?:node:)?child_process'/u;

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
}

async function workspaces(): Promise<string[]> {
  const found: string[] = ['packages/testing'];
  for (const group of WORKSPACE_GROUPS)
    for (const entry of await readdir(join(root, group), { withFileTypes: true }))
      if (entry.isDirectory()) found.push(`${group}/${entry.name}`);
  return found.sort();
}

async function sources(directory: string): Promise<{ path: string; text: string }[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true, recursive: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name).replaceAll('\\', '/'));
  return await Promise.all(
    files.map(async (path) => ({ path, text: await readFile(path, 'utf8') })),
  );
}

describe('architecture boundaries', () => {
  it('declares only the allowed internal dependencies', async () => {
    const production = (await workspaces()).filter((name) => name !== 'packages/testing');
    expect(production).toEqual(Object.keys(ALLOWED_INTERNAL_DEPENDENCIES).sort());
    for (const name of production) {
      const manifest = JSON.parse(
        await readFile(join(root, name, 'package.json'), 'utf8'),
      ) as Manifest;
      const internal = Object.keys(manifest.dependencies ?? {})
        .filter((dependency) => dependency.startsWith('@multiagentos/'))
        .map((dependency) => dependency.slice('@multiagentos/'.length));
      expect(internal, name).toEqual([...(ALLOWED_INTERNAL_DEPENDENCIES[name] ?? [])].sort());
    }
  });

  it('keeps Kernel components out of each other', async () => {
    for (const component of KERNEL_COMPONENTS) {
      const others = [...KERNEL_COMPONENTS.filter((other) => other !== component), 'run-actor'];
      const sibling = new RegExp(`from '(?:\\.\\./)+(?:${others.join('|')})/`, 'u');
      for (const file of await sources(`packages/modules/kernel/src/${component}`))
        expect(sibling.test(file.text), file.path).toBe(false);
    }
  });

  it('confines provider SDKs to the model-call Executor', async () => {
    for (const name of await workspaces())
      for (const file of await sources(`${name}/src`))
        if (!file.path.includes('/packages/libraries/executor-set/src/model-call/'))
          expect(PROVIDER_SDK.test(file.text), file.path).toBe(false);
  });

  it('confines child processes to the Supervisor', async () => {
    for (const name of await workspaces())
      for (const file of await sources(`${name}/src`))
        if (!file.path.includes('/packages/modules/kernel/src/supervisor/'))
          expect(CHILD_PROCESS.test(file.text), file.path).toBe(false);
  });
});
