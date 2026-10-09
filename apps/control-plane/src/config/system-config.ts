import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SystemConfigSchema, validate, type SystemConfig } from '@multiagentos/contracts';
import { DEFAULT_KERNEL_CONFIG } from '@multiagentos/kernel';
import { DEFAULT_WORKFLOW_CONFIG } from '@multiagentos/workflow';

export type { SystemConfig } from '@multiagentos/contracts';

/** The system configuration is wrong; the system must not start. */
export class ConfigError extends Error {
  public constructor(message: string) {
    super(`CONFIG_INVALID: ${message}`);
    this.name = 'ConfigError';
  }
}

/** Built-in defaults, used when `MULTIAGENTOS_CONFIG` is not set. */
export function defaultSystemConfig(): SystemConfig {
  return {
    dataDir: join(homedir(), '.multiagentos'),
    kernel: DEFAULT_KERNEL_CONFIG,
    workflow: DEFAULT_WORKFLOW_CONFIG,
  };
}

/**
 * Validates against `platform.config.SystemConfig.v0` and checks what a Schema cannot say.
 * The checks that need the catalog (provider match, budget versus prompts) belong to the Kernel.
 */
export function assertSystemConfig(config: unknown): SystemConfig {
  const result = validate<SystemConfig>(SystemConfigSchema, config);
  if (!result.ok) throw new ConfigError(result.issues.join('; '));
  if (!isAbsolute(result.value.dataDir)) throw new ConfigError('dataDir must be an absolute path');
  return result.value;
}

/**
 * Loads the configuration (docs/M1/M1TechStack.md 4): the JSON file named by
 * `MULTIAGENTOS_CONFIG`, laid over the built-in defaults, or the defaults alone when the
 * variable is not set. A file may give any subset of the settings; an unknown key is an error.
 */
export async function loadSystemConfig(
  env: Readonly<Record<string, string | undefined>>,
): Promise<SystemConfig> {
  const path = env['MULTIAGENTOS_CONFIG'];
  if (path === undefined || path === '') return assertSystemConfig(defaultSystemConfig());
  let overrides: unknown;
  try {
    overrides = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `cannot read ${path}: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  return assertSystemConfig(overlay(defaultSystemConfig(), overrides));
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Objects are merged key by key; any other value, arrays included, replaces the default. */
function overlay(base: unknown, overrides: unknown): unknown {
  if (!isRecord(base) || !isRecord(overrides)) return overrides;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides))
    merged[key] = key in base ? overlay(base[key], value) : value;
  return merged;
}
