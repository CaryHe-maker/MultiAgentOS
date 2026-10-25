import {
  currentSchemas,
  readSchemaSnapshot,
  SCHEMA_SNAPSHOT_URL,
  writeSchemaSnapshot,
} from '../compatibility/schema-snapshot.js';
import { createM1ProtocolRegistry } from '../protocol-registry.js';

/**
 * `pnpm run contracts:snapshot`: rewrites the Schema snapshot of the freeze guard
 * (M1TechStack 11). Once M1 is accepted the snapshot is frozen and this refuses to change it.
 */
let frozen = false;
try {
  frozen = (await readSchemaSnapshot()).frozen;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (frozen) {
  console.error(`Nothing written: ${SCHEMA_SNAPSHOT_URL.pathname} is frozen`);
  process.exitCode = 1;
} else {
  const schemas = currentSchemas(createM1ProtocolRegistry());
  await writeSchemaSnapshot({ frozen: false, schemas });
  console.log(
    `${Object.keys(schemas).length} Schema(s) written to ${SCHEMA_SNAPSHOT_URL.pathname}`,
  );
}
