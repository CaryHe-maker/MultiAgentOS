import { describe, expect, it } from 'vitest';
import { MAX_URL_CHARS, carriesData } from './secret-scan.js';

describe('an address that carries data', () => {
  it('lets the addresses of pages through', () => {
    for (const url of [
      'https://example.com/',
      'https://example.com/docs/guide?page=2&lang=zh',
      'https://github.com/owner/repo/commit/3f786850e387550fdab836ed7e6dc881de23001b',
      'https://example.com/?commit=3f786850e387550fdab836ed7e6dc881de23001b',
      'https://example.com/search?q=how-to-write-a-long-descriptive-title-for-a-page-about-parsing',
      'https://www.scsxghw.com/school/80873.html?year=2024&province=%E5%9B%9B%E5%B7%9D',
      'not an address',
    ])
      expect(carriesData(url), url).toBe(false);
  });

  it('refuses an address that is too long', () => {
    expect(carriesData(`https://example.com/${'a'.repeat(MAX_URL_CHARS)}`)).toBe(true);
  });

  it('refuses a query value with the spread of an encoding', () => {
    expect(
      carriesData(
        'https://example.com/?d=dGhpcyBpcyBhIHNlY3JldCBmcm9tIHRoZSByZXBvc2l0b3J5IHdpdGggbWFueSBjaGFyYWN0ZXJz',
      ),
    ).toBe(true);
    expect(
      carriesData('https://example.com/?k=Zm9vOmJhcjpiYXo6cXV4OjEyMzQ1Njc4OTA7QUJDREVGR0g'),
    ).toBe(true);
  });
});
