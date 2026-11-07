/**
 * What a query or an address may not carry out of this machine (ExecutorSet 5d): anything that
 * looks like a credential. A pattern match refuses the whole call; the refusal never says which
 * pattern or which text matched.
 */
const PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/u,
  /\bghp_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[bap]-[A-Za-z0-9-]{10,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
];

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/iu;

/** The values of the environment variables that look like credentials, at least 8 characters long. */
export function environmentSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    SECRET_NAME.test(name) && value !== undefined && value.length >= 8 ? [value] : [],
  );
}

export function containsSecret(text: string, secrets: readonly string[] = []): boolean {
  return (
    PATTERNS.some((pattern) => pattern.test(text)) ||
    secrets.some((secret) => text.includes(secret))
  );
}
