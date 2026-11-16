import { fileURLToPath } from 'node:url';

/**
 * The catalog shipped in this repository (`packages/agent-tool-pool/definitions`). This file
 * sits directly under `src/` and `dist/`, so `../definitions` resolves from both.
 */
export const DEFAULT_DEFINITIONS_DIRECTORY = fileURLToPath(
  new URL('../definitions', import.meta.url),
);

/**
 * The comparison arms beside the catalog (`definitions-arms/<arm>`): whole files that replace the
 * catalog's files at the same paths when the arm runs (Orchestration D81).
 */
export const DEFINITION_ARM_DIRECTORIES = {
  'no-acceptance': fileURLToPath(new URL('../definitions-arms/no-acceptance', import.meta.url)),
  /** The root's manual with the original whole examples (Orchestration D83). */
  'few-shot': fileURLToPath(new URL('../definitions-arms/few-shot', import.meta.url)),
} as const;
