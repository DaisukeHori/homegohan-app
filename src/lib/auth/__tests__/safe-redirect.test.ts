/**
 * src/lib/auth/safe-redirect.ts のユニットテスト
 * Issue #1043 (F1a-08/F6-14) open redirect 対策
 */

import { describe, it, expect } from 'vitest';
import { getSafeRedirectPath, getSafeRedirectPathOrDefault } from '../safe-redirect';

describe('getSafeRedirectPath', () => {
  describe('悪性な入力を拒否する', () => {
    it('プロトコル相対 URL (//evil.com) を拒否する', () => {
      expect(getSafeRedirectPath('//evil.com')).toBeNull();
      expect(getSafeRedirectPath('//evil.com/path')).toBeNull();
    });

    it('スキーム付き絶対 URL (https://evil.com) を拒否する', () => {
      expect(getSafeRedirectPath('https://evil.com')).toBeNull();
      expect(getSafeRedirectPath('http://evil.com')).toBeNull();
    });

    it('バックスラッシュ変種 (/\\evil.com) を拒否する', () => {
      expect(getSafeRedirectPath('/\\evil.com')).toBeNull();
      expect(getSafeRedirectPath('\\\\evil.com')).toBeNull();
      expect(getSafeRedirectPath('/\\/evil.com')).toBeNull();
    });

    it('percent-encoding によるエンコード変種 (%2F%2Fevil.com) を拒否する', () => {
      expect(getSafeRedirectPath('%2F%2Fevil.com')).toBeNull();
      expect(getSafeRedirectPath('%2f%2fevil.com')).toBeNull();
      // 二重エンコード
      expect(getSafeRedirectPath('%252F%252Fevil.com')).toBeNull();
    });

    it('制御文字 (タブ・改行・復帰) で `//` 判定を回避する変種を拒否する', () => {
      // WHATWG URL パーサはタブ・改行を除去するため、
      // `/<制御文字>/evil.com` は new URL() 適用後に `//evil.com` と同義になる
      expect(getSafeRedirectPath('/%09/evil.com')).toBeNull();
      expect(getSafeRedirectPath('/%0A/evil.com')).toBeNull();
      expect(getSafeRedirectPath('/%0D/evil.com')).toBeNull();
      // 二重エンコード変種
      expect(getSafeRedirectPath('/%2509/evil.com')).toBeNull();
      expect(getSafeRedirectPath('/%250A/evil.com')).toBeNull();
      expect(getSafeRedirectPath('/%250D/evil.com')).toBeNull();
    });

    it('javascript: スキームを拒否する', () => {
      expect(getSafeRedirectPath('javascript:alert(1)')).toBeNull();
      expect(getSafeRedirectPath('JaVaScRiPt:alert(1)')).toBeNull();
    });

    it('data: スキームを拒否する', () => {
      expect(getSafeRedirectPath('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('null・undefined・空文字を拒否する', () => {
      expect(getSafeRedirectPath(null)).toBeNull();
      expect(getSafeRedirectPath(undefined)).toBeNull();
      expect(getSafeRedirectPath('')).toBeNull();
    });

    it('/ から始まらない相対パス (home) を拒否する', () => {
      expect(getSafeRedirectPath('home')).toBeNull();
    });
  });

  describe('正当な入力を許可する', () => {
    it('単純な相対パス /home を許可する', () => {
      expect(getSafeRedirectPath('/home')).toBe('/home');
    });

    it('クエリ付きの相対パス /invite/xxx?a=b を許可する', () => {
      expect(getSafeRedirectPath('/invite/xxx?a=b')).toBe('/invite/xxx?a=b');
    });

    it('前後の空白をトリムした上で許可する', () => {
      expect(getSafeRedirectPath('  /home  ')).toBe('/home');
    });
  });

  describe('戻り値は正規化済み(先頭が単一の `/`)である', () => {
    it('先頭が単一のバックスラッシュの場合、正規化した `/` 始まりの文字列を返す', () => {
      // \javascript:alert(1) は正規化すると /javascript:alert(1) となり、
      // 先頭 `/` が単一で `//` にもスキームにもならないため許可されるが、
      // 戻り値自体は生の candidate ではなく正規化済み文字列でなければならない
      // (呼び出し側が「先頭 `/` = 内部パス」という契約を素朴に信頼できるようにするため)
      const result = getSafeRedirectPath('\\javascript:alert(1)');
      expect(result).toBe('/javascript:alert(1)');
      expect(result?.startsWith('/')).toBe(true);
      expect(result?.startsWith('\\')).toBe(false);
    });
  });
});

describe('getSafeRedirectPathOrDefault', () => {
  it('不正な next の場合はデフォルトの fallback を返す', () => {
    expect(getSafeRedirectPathOrDefault('//evil.com')).toBe('/home');
    expect(getSafeRedirectPathOrDefault(null)).toBe('/home');
  });

  it('カスタム fallback を指定できる', () => {
    expect(getSafeRedirectPathOrDefault('https://evil.com', '/login')).toBe('/login');
  });

  it('正当な next はそのまま返す', () => {
    expect(getSafeRedirectPathOrDefault('/onboarding/welcome')).toBe('/onboarding/welcome');
  });
});
