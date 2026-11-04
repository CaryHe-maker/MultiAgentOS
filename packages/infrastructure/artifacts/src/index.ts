/**
 * ArtifactStore (Infrastructure/ArtifactStore): one global content-addressed store under
 * `<dataDir>/artifacts/`. It does not decide access: Execution records and checks ownership.
 */
export { ArtifactIntegrityError } from './integrity-error.js';
export * from './global-store.js';
