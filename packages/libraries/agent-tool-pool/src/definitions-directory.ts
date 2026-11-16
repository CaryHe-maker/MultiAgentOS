import { fileURLToPath } from 'node:url';

/**
 * The catalog shipped in this repository (`packages/agent-tool-pool/definitions`). This file
 * sits directly under `src/` and `dist/`, so `../definitions` resolves from both.
 */
export const DEFAULT_DEFINITIONS_DIRECTORY = fileURLToPath(
  new URL('../definitions', import.meta.url),
);
