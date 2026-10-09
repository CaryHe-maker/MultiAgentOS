import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  assertSystemConfig,
  defaultSystemConfig,
  loadSystemConfig,
} from './system-config.js';

const roots: string[] = [];
async function configFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'multiagentos-config-'));
  roots.push(root);
  const path = join(root, 'config.json');
  await writeFile(path, content);
  return path;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('system configuration', () => {
  it('uses valid built-in defaults when MULTIAGENTOS_CONFIG is not set', async () => {
    expect(await loadSystemConfig({})).toEqual(defaultSystemConfig());
  });

  it('lays a partial file over the defaults', async () => {
    const path = await configFile(
      JSON.stringify({ kernel: { provider: 'other', budget: { tokenLimit: 1000 } } }),
    );
    const config = await loadSystemConfig({ MULTIAGENTOS_CONFIG: path });
    const defaults = defaultSystemConfig();
    expect(config.kernel.provider).toBe('other');
    expect(config.kernel.budget).toEqual({ ...defaults.kernel.budget, tokenLimit: 1000 });
    expect(config.workflow).toEqual(defaults.workflow);
  });

  it.each([
    ['an unknown key', JSON.stringify({ kernel: { providr: 'typo' } })],
    ['a value of the wrong type', JSON.stringify({ kernel: { runTimeoutMs: 'soon' } })],
    ['a relative dataDir', JSON.stringify({ dataDir: 'relative/dir' })],
    ['a file that is not JSON', '{'],
  ])('rejects %s', async (_label, content) => {
    const path = await configFile(content);
    await expect(loadSystemConfig({ MULTIAGENTOS_CONFIG: path })).rejects.toThrow(ConfigError);
  });

  it('rejects a missing file and a config without a required part', async () => {
    await expect(
      loadSystemConfig({ MULTIAGENTOS_CONFIG: join(tmpdir(), 'no-such-config.json') }),
    ).rejects.toThrow(ConfigError);
    expect(() => assertSystemConfig({ dataDir: tmpdir() })).toThrow(ConfigError);
  });
});
