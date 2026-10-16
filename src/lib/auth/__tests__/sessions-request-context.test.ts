/**
 * src/lib/auth/sessions/request-context.ts の単体テスト (#1190。設計 docs/design/cross/16-auth-history-sessions.md §13.5・§20.1)
 */
import { describe, expect, it } from 'vitest';
import { countryCodeOf } from '../sessions/request-context';

const headersWith = (value?: string) => new Headers(value === undefined ? {} : { 'x-vercel-ip-country': value });

describe('countryCodeOf', () => {
  it('countryCodeOf は x-vercel-ip-country が大文字 2 文字 (例 JP) ならその値を返す', () => {
    expect(countryCodeOf(headersWith('JP'))).toBe('JP');
    expect(countryCodeOf(headersWith('US'))).toBe('US');
  });

  it('ヘッダが無ければ null', () => {
    expect(countryCodeOf(headersWith())).toBeNull();
  });

  it.each(['jp', 'JPN', 'J1', '12', '', ' JP', 'JP ', 'J'])(
    '小文字・3 文字・数字・空・前後の空白つきなど /^[A-Z]{2}$/ に合わなければ null (%j)',
    (value) => {
      // Headers は値の前後の空白を落とすので、空白つきは get の戻りを直接与えて確かめる
      expect(countryCodeOf({ get: (name: string) => (name === 'x-vercel-ip-country' ? value : null) })).toBeNull();
    },
  );
});
