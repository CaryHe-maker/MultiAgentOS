import { randomBytes } from 'node:crypto';

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
  'wfr' | 'agr' | 'req' | 'una' | 'exe' | 'evt' | 'msg' | 'cor' | 'qst' | 'ctx';

/** A new random identifier `<prefix>_<ULID>` (M1Interface 3.1). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
