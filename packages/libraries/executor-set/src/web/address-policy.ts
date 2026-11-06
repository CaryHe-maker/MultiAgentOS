import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isForbiddenAddress } from '@multiagentos/contracts';

/**
 * The judgement of an address (`isForbiddenAddress`, `checkUrlLiteral`, `hostKeyOf`) is in
 * contracts, where Core uses it too. What is here needs the network: resolving a name, and a
 * policy a test may loosen.
 */
export {
  checkUrlLiteral,
  hostKeyOf,
  isForbiddenAddress,
  type UrlCheck,
} from '@multiagentos/contracts';

/** Resolves a host name to every address it has. */
export type Resolve = (host: string) => Promise<readonly string[]>;

export const systemResolve: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** What an address policy is made of; tests may allow an address that production never would. */
export interface AddressPolicy {
  forbids(address: string): boolean;
}

export const PUBLIC_ONLY: AddressPolicy = { forbids: isForbiddenAddress };

/**
 * The addresses of a host that a connection may use, or undefined when any of them is forbidden:
 * a name that answers with one private address among public ones is refused, since which one is
 * used is not ours to decide. An IP literal stands for itself.
 */
export async function allowedAddresses(
  host: string,
  resolve: Resolve,
  policy: AddressPolicy = PUBLIC_ONLY,
): Promise<readonly string[] | undefined> {
  const bare = host.replace(/^\[|\]$/gu, '');
  const addresses = isIP(bare) === 0 ? await resolve(bare) : [bare];
  if (addresses.length === 0 || addresses.some((address) => policy.forbids(address)))
    return undefined;
  return addresses;
}
