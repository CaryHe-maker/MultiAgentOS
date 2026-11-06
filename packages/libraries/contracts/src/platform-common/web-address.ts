import { isIP } from 'node:net';

/**
 * Which addresses a web tool may reach (ExecutorSet 5d, M2Security 3c): the public internet and
 * nothing of this machine or its network. Pure functions: Core judges an address with them before
 * it asks, and the Executor again before it connects.
 */

/** The host names that stand for this machine or a private network, whatever they resolve to. */
function isPrivateName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/u, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal') ||
    // A name without a dot is resolved against the local search domains.
    !name.includes('.')
  );
}

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split('.').map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined;
}

function forbiddenV4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets === undefined) return true;
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function groupsOf(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text)?.[1];
  if (tail !== undefined) {
    const octets = ipv4Octets(tail);
    if (octets === undefined) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const rest = halves[1] === undefined || halves[1] === '' ? [] : halves[1].split(':');
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((part) =>
    Number.parseInt(part, 16),
  );
  return groups.length === 8 &&
    groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

function forbiddenV6(address: string): boolean {
  const groups = groupsOf(address);
  if (groups === undefined) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  // The address inside an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) address decides.
  const embedded = `${String(g6 >> 8)}.${String(g6 & 255)}.${String(g7 >> 8)}.${String(g7 & 255)}`;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return forbiddenV4(embedded);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return forbiddenV4(embedded);
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7, unique local
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10, link local
    (g0 & 0xff00) === 0xff00 || // ff00::/8, multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) // discard-only
  );
}

/** Loopback, private, link-local (the cloud metadata address too), unspecified, multicast and the like. */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return forbiddenV4(address);
  if (version === 6) return forbiddenV6(address);
  return true;
}

export type UrlCheck =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: 'ADDRESS_FORBIDDEN' | 'INVALID_URL' };

/**
 * What the address says by itself, before anything is resolved: only http and https, no user
 * name or password, and a host that is not an IP address or a name of a private network. The
 * check Core makes before it asks, and the first one of the Executor.
 */
export function checkUrlLiteral(text: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: 'INVALID_URL' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'INVALID_URL' };
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (host === '') return { ok: false, reason: 'INVALID_URL' };
  if (isIP(host) !== 0)
    return isForbiddenAddress(host)
      ? { ok: false, reason: 'ADDRESS_FORBIDDEN' }
      : { ok: true, url };
  return isPrivateName(host) ? { ok: false, reason: 'ADDRESS_FORBIDDEN' } : { ok: true, url };
}

/** The host name Core keys an authorization by: lower case, as the URL parser writes it (punycode). */
export function hostKeyOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
}
