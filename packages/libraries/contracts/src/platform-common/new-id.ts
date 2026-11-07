import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48 bits of time and 80 random bits, in Crockford base32 (26 characters). */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let rest = now;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  let random = '';
  for (const byte of randomBytes(16)) random += CROCKFORD.charAt(byte % 32);
  return time + random;
}

export type IdPrefix =
  | 'wfr'
  | 'cmp'
  | 'agr'
  | 'req'
  | 'una'
  | 'exe'
  | 'evt'
  | 'msg'
  | 'cor'
  | 'qst'
  | 'und'
  | 'ctx'
  | 'ses'
  | 'trn'
  | 'inp'
  | 'scm'
  | 'slq'
  | 'dlg';

/** A new random identifier `<prefix>_<ULID>`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/**
 * An ID derived from a readable path: `<prefix>_` and the first 32 hexadecimal digits of the
 * path's SHA-256, so replaying a log gives the same ID (Interface 3).
 */
export function pathDerivedId(prefix: 'nod' | 'unr' | 'req', path: string): string {
  return `${prefix}_${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32)}`;
}
