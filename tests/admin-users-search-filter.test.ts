/**
 * 管理画面のユーザー検索 (q) → PostgREST の or=(...) フィルタ文字列 (#1145)
 *
 * 以前は `nickname.ilike.%${q}%` と検索語を連結していたため、"," ")" で構文が壊れ、"%" "_" がワイルドカードになった。
 * 検索語は (1) LIKE のワイルドカードをエスケープ → (2) PostgREST の引用符つき値としてエスケープ の順で二重にエスケープする。
 */
import { describe, it, expect } from 'vitest';
import {
  buildUserSearchFilter,
  escapeLikePattern,
  isUuid,
  quotePostgrestValue,
} from '../src/lib/admin/users-search';

const UUID_A = '3f6c1a2e-8b44-4d1f-9a55-0c2d7e9b1a10';
const UUID_B = '9b1d2c3e-4f50-4a61-8b72-1d3e4f5a6b7c';

describe('escapeLikePattern', () => {
  it('% _ \\ を LIKE のエスケープ付きにする', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('ふつうの文字は変えない', () => {
    expect(escapeLikePattern('たろう user@example.com')).toBe('たろう user@example.com');
  });
});

describe('quotePostgrestValue', () => {
  it('二重引用符で囲み、" と \\ だけをエスケープする', () => {
    expect(quotePostgrestValue('abc')).toBe('"abc"');
    expect(quotePostgrestValue('a"b')).toBe('"a\\"b"');
    expect(quotePostgrestValue('a\\b')).toBe('"a\\\\b"');
  });

  it('"," "(" ")" "." は値の一部としてそのまま残る (引用符の中なので構文を壊さない)', () => {
    expect(quotePostgrestValue('a,b(c).d')).toBe('"a,b(c).d"');
  });
});

describe('isUuid', () => {
  it('UUID の形だけを受ける (大文字も可)', () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid(UUID_A.toUpperCase())).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(`${UUID_A},nickname.eq.x`)).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('buildUserSearchFilter', () => {
  it('空・空白だけの検索語は null (フィルタを付けない)', () => {
    expect(buildUserSearchFilter('')).toBeNull();
    expect(buildUserSearchFilter('   ')).toBeNull();
  });

  it('ふつうの検索語は nickname の部分一致だけ', () => {
    expect(buildUserSearchFilter('tanaka')).toBe('nickname.ilike."%tanaka%"');
  });

  it('前後の空白は取り除く', () => {
    expect(buildUserSearchFilter('  tanaka  ')).toBe('nickname.ilike."%tanaka%"');
  });

  it('"," ")" を含む検索語でも、条件は 1 つの引用符つき値に収まる (別の条件が混ざらない)', () => {
    const filter = buildUserSearchFilter('a,b)')!;
    expect(filter).toBe('nickname.ilike."%a,b)%"');
    // 検索語に細工 (別の条件の注入) をしても、引用符の外には出ない
    const injected = buildUserSearchFilter('x%,id.eq.00000000-0000-0000-0000-000000000000')!;
    expect(injected).toBe('nickname.ilike."%x\\\\%,id.eq.00000000-0000-0000-0000-000000000000%"');
  });

  it('% と _ は LIKE のワイルドカードにならない (バックスラッシュでエスケープし、引用符の層でもう一度エスケープする)', () => {
    // LIKE: 100\%\_x → 引用符の層: 100\\%\\_x
    expect(buildUserSearchFilter('100%_x')).toBe('nickname.ilike."%100\\\\%\\\\_x%"');
  });

  it('" と \\ を含む検索語は、引用符を閉じない', () => {
    // LIKE: a"b\\c (\ を 2 つ) → 引用符の層: a\"b\\\\c
    expect(buildUserSearchFilter('a"b\\c')).toBe('nickname.ilike."%a\\"b\\\\\\\\c%"');
  });

  it('UUID の形なら id の一致を足す (大文字は小文字にそろえる)', () => {
    expect(buildUserSearchFilter(UUID_A)).toBe(`nickname.ilike."%${UUID_A}%",id.eq.${UUID_A}`);
    expect(buildUserSearchFilter(UUID_A.toUpperCase())).toBe(
      `nickname.ilike."%${UUID_A.toUpperCase()}%",id.eq.${UUID_A}`,
    );
  });

  it('UUID でない検索語には id の条件を付けない (以前の "0000…" ダミー条件も付けない)', () => {
    expect(buildUserSearchFilter('tanaka')).not.toContain('id.eq.');
  });

  it('メールの一致で見つかった user_id を id.in.(...) で足す', () => {
    expect(buildUserSearchFilter('foo@example.com', [UUID_A, UUID_B])).toBe(
      `nickname.ilike."%foo@example.com%",id.in.(${UUID_A},${UUID_B})`,
    );
  });

  it('メール一致の id は重複を除き、UUID の形のものだけを通す (構文を壊す値を入れない)', () => {
    const filter = buildUserSearchFilter('foo', [
      UUID_A,
      UUID_A,
      `${UUID_B}),nickname.ilike.%25`,
      'x',
      UUID_B.toUpperCase(),
    ])!;
    expect(filter).toBe(`nickname.ilike."%foo%",id.in.(${UUID_A},${UUID_B})`);
  });

  it('メール一致の id が空なら id.in は付けない', () => {
    expect(buildUserSearchFilter('foo', [])).toBe('nickname.ilike."%foo%"');
  });
});
