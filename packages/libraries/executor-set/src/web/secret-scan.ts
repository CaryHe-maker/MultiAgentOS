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

/** The longest address a fetch sends: a page is found by a short one; a long one is carrying something. */
export const MAX_URL_CHARS = 800;

/** The Shannon entropy of the characters of `text`, in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Whether an address looks like it carries data out and not only asks for a page (the web may be
 * allowed for every public site; this is what stands between a page that talks the model into it
 * and the data in the repository): an address longer than `MAX_URL_CHARS`, or a value in its query
 * that is one long run of token characters with the spread of an encoding (base64, a key), not a
 * word, a number or the hash of a commit. A match refuses the whole call and, like a secret, never
 * says what matched.
 */
export function carriesData(address: string): boolean {
  if (address.length > MAX_URL_CHARS) return true;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  for (const [, value] of url.searchParams) {
    if (value.length < 32 || !/^[A-Za-z0-9+/=_-]+$/u.test(value)) continue;
    if (/^[0-9a-f]+$/iu.test(value)) continue;
    if (entropy(value) >= 4.3) return true;
  }
  return false;
}
