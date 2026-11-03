// src/__tests__/app/menus/weekly/state/weekDataCache.test.ts
// #2201 U1: 献立表の週のキャッシュ (createWeekDataCache) は、読み始める前に取った書き込み口でだけ書き、
// AI 相談の成功の取り直しが捨てた (discard) あと・同じ週のあとの読み取りが書き込み口を取ったあとは、先に読み始めた応答を書かない。
// 問題 (直す前): 週のキャッシュはただの Map で、AI 相談の取り直しが clear() したあとに、それより前に始めた週の読み込み・
// 前後の週の先読みの応答が set でキャッシュを書き戻した (画面には置かない古い応答でも書いた)。その週へ戻ると、キャッシュから
// AI 相談の前の献立を出した (ページを描いて確かめる検査は tests/ai-consultation-weekly-refetch-2195.test.tsx)

import { describe, expect, it } from 'vitest';
import { createWeekDataCache } from '@/app/(main)/menus/weekly/_state/weekDataCache';

type Data = { plan: string | null };

const WEEK = '2026-11-02';
const OTHER_WEEK = '2026-11-09';
const BEFORE_AI = { plan: 'AI 相談の前の献立' };
const AFTER_AI = { plan: 'AI 相談の後の献立' };

describe('createWeekDataCache (#2201 U1)', () => {
  it('書き込み口で書いた応答を、書いた時刻を付けて返す', () => {
    const cache = createWeekDataCache<Data>();
    const before = Date.now();
    expect(cache.beginWrite(WEEK)(AFTER_AI)).toBe(true);
    const entry = cache.get(WEEK);
    expect(entry?.plan).toBe(AFTER_AI.plan);
    expect(entry?.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(cache.get(OTHER_WEEK)).toBeUndefined();
  });

  it('捨てる前に取った書き込み口では、捨てたあとに書かない (捨てる前に読み始めた週の読み込み・先読みの応答)', () => {
    const cache = createWeekDataCache<Data>();
    const writeBeforeDiscard = cache.beginWrite(WEEK);
    const writeOtherWeekBeforeDiscard = cache.beginWrite(OTHER_WEEK);
    cache.discard();
    expect(writeBeforeDiscard(BEFORE_AI)).toBe(false);
    expect(writeOtherWeekBeforeDiscard(BEFORE_AI)).toBe(false);
    expect(cache.get(WEEK)).toBeUndefined();
    expect(cache.get(OTHER_WEEK)).toBeUndefined();

    // 捨てたあとに読み始めた応答は書く
    expect(cache.beginWrite(WEEK)(AFTER_AI)).toBe(true);
    expect(cache.get(WEEK)?.plan).toBe(AFTER_AI.plan);
  });

  it('捨てたあとに書いた応答を、捨てる前に取った書き込み口の応答が後から届いても上書きしない', () => {
    const cache = createWeekDataCache<Data>();
    const writeBeforeDiscard = cache.beginWrite(WEEK);
    cache.discard();
    cache.beginWrite(WEEK)(AFTER_AI);
    expect(writeBeforeDiscard(BEFORE_AI)).toBe(false);
    expect(cache.get(WEEK)?.plan).toBe(AFTER_AI.plan);
  });

  it('同じ週のあとの読み取りが書き込み口を取ったら、先の書き込み口では書かない (応答が逆の順に届いても)', () => {
    const cache = createWeekDataCache<Data>();
    const writeEarlier = cache.beginWrite(WEEK);
    const writeLater = cache.beginWrite(WEEK);
    expect(writeLater(AFTER_AI)).toBe(true);
    expect(writeEarlier(BEFORE_AI)).toBe(false);
    expect(cache.get(WEEK)?.plan).toBe(AFTER_AI.plan);
  });

  it('別の週の書き込み口は、互いの書き込みを止めない', () => {
    const cache = createWeekDataCache<Data>();
    const writeWeek = cache.beginWrite(WEEK);
    const writeOtherWeek = cache.beginWrite(OTHER_WEEK);
    expect(writeWeek(AFTER_AI)).toBe(true);
    expect(writeOtherWeek(BEFORE_AI)).toBe(true);
    expect(cache.get(WEEK)?.plan).toBe(AFTER_AI.plan);
    expect(cache.get(OTHER_WEEK)?.plan).toBe(BEFORE_AI.plan);
  });

  it('書き込み口を取ると、その週のキャッシュを捨てる (あとに始めた読み取りの応答待ちのあいだ、それより前の応答を出さない)', () => {
    const cache = createWeekDataCache<Data>();
    cache.beginWrite(WEEK)(BEFORE_AI);
    cache.beginWrite(OTHER_WEEK)(BEFORE_AI);
    cache.beginWrite(WEEK);
    expect(cache.get(WEEK)).toBeUndefined();
    expect(cache.get(OTHER_WEEK)?.plan).toBe(BEFORE_AI.plan);
  });
});
