import { describe, expect, it } from 'vitest';
import { sanitizeGitConfig } from './git-config.js';

describe('sanitizeGitConfig', () => {
  it('takes the credentials out of a remote URL and keeps the rest of the line', () => {
    const text =
      '[remote "origin"]\n\turl = https://me:ghp_secret@github.com/o/r.git\n\tfetch = +refs/*';
    const clean = sanitizeGitConfig(text);
    expect(clean).toContain('url = https://github.com/o/r.git');
    expect(clean).not.toContain('ghp_secret');
    expect(clean).toContain('fetch = +refs/*');
  });

  it('drops the lines that hold a token, a password or an authorization header', () => {
    const text = [
      '[http]',
      '\textraHeader = Authorization: Bearer abc',
      '\tsslVerify = true',
      '[credential]',
      '\thelper = store',
      '[x]',
      '\tapiToken = zzz',
    ].join('\n');
    const clean = sanitizeGitConfig(text);
    expect(clean).not.toMatch(/abc|zzz/u);
    expect(clean).toContain('sslVerify = true');
    expect(clean).toContain('helper = store');
  });

  it('leaves a config without secrets as it is', () => {
    const text = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n';
    expect(sanitizeGitConfig(text)).toBe(text);
  });

  it('leaves scp-style and plain URLs alone', () => {
    const text = '\turl = git@github.com:o/r.git\n\turl = https://github.com/o/r.git';
    expect(sanitizeGitConfig(text)).toBe(text);
  });
});
