/**
 * #1444 (CodeQL js/prototype-pollution-utility) の回帰テスト。
 * プロフィールの performanceProfile の更新 (src/app/(main)/profile/page.tsx) が使う assignAtPath は、
 * パスの先へ値を入れる。__proto__ / constructor / prototype を含むパスでは何も書かずに失敗し、共有のプロトタイプを汚さない。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assignAtPath, InvalidObjectPathError } from '@/lib/assign-at-path';

/** テストで汚染を試みるプロパティ名 (Object.prototype に現れたら汚染された証拠) */
const POLLUTED_KEY = 'pollutedBy1444';

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>)[POLLUTED_KEY];
});

describe('assignAtPath', () => {
  it('既存のネストした値を書き換える (ほかの値は残す)', () => {
    const target: Record<string, unknown> = { sport: { id: 'soccer', name: null }, cut: { enabled: false } };
    assignAtPath(target, 'sport.name', 'サッカー');
    expect(target).toEqual({ sport: { id: 'soccer', name: 'サッカー' }, cut: { enabled: false } });
  });

  it('途中の要素が無ければ、空のオブジェクトを作って進む', () => {
    const target: Record<string, unknown> = { sport: null };
    assignAtPath(target, 'sport.phase', 'training');
    assignAtPath(target, 'growth.isUnder18', true);
    expect(target).toEqual({ sport: { phase: 'training' }, growth: { isUnder18: true } });
  });

  it('1 要素のパスは直下に入れる', () => {
    const target: Record<string, unknown> = {};
    assignAtPath(target, 'priorities', { protein: 'high' });
    expect(target).toEqual({ priorities: { protein: 'high' } });
  });

  it.each([
    ['__proto__.' + POLLUTED_KEY],
    ['sport.__proto__.' + POLLUTED_KEY],
    ['constructor.prototype.' + POLLUTED_KEY],
    ['sport.constructor.prototype.' + POLLUTED_KEY],
    ['prototype'],
    ['sport..name'],
    [''],
  ])('受け付けないパス %j は、何も書かずに InvalidObjectPathError を投げる', (path) => {
    const target: Record<string, unknown> = { sport: { name: null } };
    expect(() => assignAtPath(target, path, 'x')).toThrow(InvalidObjectPathError);
    expect(target).toEqual({ sport: { name: null } });
    expect(({} as Record<string, unknown>)[POLLUTED_KEY]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty(POLLUTED_KEY);
  });
});

describe('プロフィールの画面は assignAtPath を使う (自前でパスを辿らない)', () => {
  const page = readFileSync(resolve(__dirname, '..', 'src/app/(main)/profile/page.tsx'), 'utf8');

  it('updatePerformanceProfile は assignAtPath で書く', () => {
    const start = page.indexOf('const updatePerformanceProfile');
    expect(start).toBeGreaterThanOrEqual(0);
    // 関数の本体 (performanceProfile の既定の値の「};」より後ろまで)。終わりは、書いた結果を渡す updateField の呼び出し
    const end = page.indexOf("updateField('performanceProfile'", start);
    expect(end).toBeGreaterThan(start);
    const body = page.slice(start, end);
    expect(body).toContain('assignAtPath(newProfile, path, value)');
    expect(body).not.toMatch(/path\.split\(/);
  });
});
