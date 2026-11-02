import { FileDefinitionSource } from '../adapters/file/file-definition-source.js';
import { planSealV1 } from '../catalog-v1/catalog-v1.js';
import { DEFAULT_DEFINITIONS_DIRECTORY } from '../definitions-directory.js';

/**
 * `pnpm run catalog:seal [directory]`: computes and writes the digest of every published
 * definition that has none yet. Drafts and files that already have a digest are never changed.
 */
const directory = process.argv[2] ?? DEFAULT_DEFINITIONS_DIRECTORY;
const source = new FileDefinitionSource(directory);
const plan = planSealV1(await source.load());
if (plan.issues.length > 0) {
  for (const issue of plan.issues)
    console.error(`[${issue.code}] ${issue.origin}: ${issue.message}`);
  console.error(`Nothing sealed: ${plan.issues.length} issue(s) in ${directory}`);
  process.exitCode = 1;
} else {
  await source.writeDigests(plan.patches);
  for (const patch of plan.patches) console.log(`sealed ${patch.origin} ${patch.digest}`);
  console.log(`${plan.patches.length} definition(s) sealed in ${directory}`);
}
