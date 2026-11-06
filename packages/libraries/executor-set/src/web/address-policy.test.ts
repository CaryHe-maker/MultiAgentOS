import { describe, expect, it } from 'vitest';
import {
  allowedAddresses,
  checkUrlLiteral,
  hostKeyOf,
  isForbiddenAddress,
  PUBLIC_ONLY,
} from './address-policy.js';
import { containsSecret, environmentSecrets } from './secret-scan.js';

describe('the addresses a web tool may not reach', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2001:db8::1',
  ])('refuses %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });

  it('refuses what is not an address at all', () => {
    expect(isForbiddenAddress('not-an-address')).toBe(true);
    expect(isForbiddenAddress('999.1.1.1')).toBe(true);
  });
});

describe('what an address says by itself', () => {
  it.each([
    'http://127.0.0.1/',
    'http://localhost:8080/x',
    'http://app.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://intranet/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://017700000001/',
  ])('is forbidden: %s', (url) => {
    expect(checkUrlLiteral(url)).toEqual({ ok: false, reason: 'ADDRESS_FORBIDDEN' });
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
    'not a url',
    'http://user:pw@example.com/',
  ])('is not a fetchable address: %s', (url) => {
    expect(checkUrlLiteral(url)).toEqual({ ok: false, reason: 'INVALID_URL' });
  });

  it('takes a public host, and writes its key in lower case', () => {
    const checked = checkUrlLiteral('https://Docs.Example.COM/a?b=1#c');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(hostKeyOf(checked.url)).toBe('docs.example.com');
    const unicode = checkUrlLiteral('https://bücher.example/');
    if (unicode.ok) expect(hostKeyOf(unicode.url)).toBe('xn--bcher-kva.example');
  });
});

describe('what a host name resolves to', () => {
  it('allows a name that resolves only to public addresses', async () => {
    expect(await allowedAddresses('example.com', () => Promise.resolve(['93.184.216.34']))).toEqual(
      ['93.184.216.34'],
    );
  });

  it('refuses a name with one private address among public ones', async () => {
    expect(
      await allowedAddresses('example.com', () => Promise.resolve(['93.184.216.34', '10.0.0.5'])),
    ).toBeUndefined();
  });

  it('refuses a name that resolves to nothing, and takes an IP literal for itself', async () => {
    expect(await allowedAddresses('gone.example', () => Promise.resolve([]))).toBeUndefined();
    expect(
      await allowedAddresses('8.8.8.8', () => Promise.reject(new Error('never asked'))),
    ).toEqual(['8.8.8.8']);
    expect(
      await allowedAddresses('[::1]', () => Promise.reject(new Error('never asked'))),
    ).toBeUndefined();
  });

  it('lets a test allow an address that production never does', async () => {
    const loopback = { forbids: (address: string) => address !== '127.0.0.1' };
    expect(
      await allowedAddresses('fixture.test', () => Promise.resolve(['127.0.0.1']), loopback),
    ).toEqual(['127.0.0.1']);
    expect(
      await allowedAddresses('fixture.test', () => Promise.resolve(['127.0.0.1']), PUBLIC_ONLY),
    ).toBeUndefined();
  });
});

describe('credentials in a query or an address', () => {
  it.each([
    'how to use sk-abcdefghijklmnopqrstuvwxyz123456 with curl',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN RSA PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  ])('is found in %s', (text) => {
    expect(containsSecret(text)).toBe(true);
  });

  it('is not found in an ordinary query', () => {
    expect(containsSecret('node.js fs.promises readFile documentation')).toBe(false);
    expect(containsSecret('sk-short')).toBe(false);
  });

  it('knows the secrets of the environment, by their names, and only the long ones', () => {
    const secrets = environmentSecrets({
      DEEPSEEK_API_KEY: 'a-long-secret-value',
      DB_PASSWORD: 'short',
      HOME: '/home/someone-long-enough',
      GITHUB_TOKEN: undefined,
    });
    expect(secrets).toEqual(['a-long-secret-value']);
    expect(containsSecret('search a-long-secret-value', secrets)).toBe(true);
    expect(containsSecret('search something else', secrets)).toBe(false);
  });
});
