/**
 * #2227 H3: /home のログインの状態の変化での読み直しの判定 (shouldRefetchHomeOnAuthChange) の回帰テスト。
 *
 * 問題 (直す前): supabase-js はタブを前に戻したときにも同じ利用者の SIGNED_IN を出すことがあり、ホームはそのたびにデータを読み直して
 * AI つきの栄養の分析を読み、LLM を呼んで安全弁 nutrition_advice_auto (上限に数えない枠) を使っていた。
 * 直したあと: SIGNED_IN は、ホームの読み取りが自分で setSession している間は数えない (#2235 I2)。それ以外は、前回読んだ利用者がまだ無い・
 * セッションに利用者が無い・前回と違うときに読み直す。SIGNED_OUT・USER_UPDATED はいつも、INITIAL_SESSION・TOKEN_REFRESHED は読み直さない。
 * 描画の検査は tests/ai-consultation-home-refetch-2195.test.tsx の「AI つきの栄養の分析を余分に読まない」
 */
import type { AuthChangeEvent } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { HOME_REFETCH_AUTH_EVENTS, shouldRefetchHomeOnAuthChange } from '@/lib/home-auth-refetch';

const USER_A = 'user-a';
const USER_B = 'user-b';
/** ホームの読み取りが自分でセッションを同期していない (#2235 I2 の引数。この検査は H3 の判定だけを見る) */
const NOT_SYNCING = false;

describe('shouldRefetchHomeOnAuthChange (#2227 H3)', () => {
  it('前回読んだ利用者と同じ人の SIGNED_IN では読み直さない', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_A, USER_A, NOT_SYNCING)).toBe(false);
  });

  it('前回読んだ利用者と別の人の SIGNED_IN では読み直す', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_B, USER_A, NOT_SYNCING)).toBe(true);
  });

  it('ログインしていないと確かめたあとの SIGNED_IN では読み直す', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_A, null, NOT_SYNCING)).toBe(true);
  });

  it('まだ利用者を確かめていない (開いたときの読み込みの前) の SIGNED_IN では読み直す (読み落とさない側に寄せる)', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_A, undefined, NOT_SYNCING)).toBe(true);
  });

  it('session に利用者が無い SIGNED_IN では読み直す (同じ人と確かめられない)', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', null, USER_A, NOT_SYNCING)).toBe(true);
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', undefined, USER_A, NOT_SYNCING)).toBe(true);
  });

  it('SIGNED_OUT・USER_UPDATED は前回読んだ利用者と同じでも読み直す', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_OUT', null, USER_A, NOT_SYNCING)).toBe(true);
    expect(shouldRefetchHomeOnAuthChange('USER_UPDATED', USER_A, USER_A, NOT_SYNCING)).toBe(true);
  });

  it('読み直す event の集合にない event (INITIAL_SESSION・TOKEN_REFRESHED・PASSWORD_RECOVERY) では、利用者が変わっていても読み直さない', () => {
    const notRefetched: readonly AuthChangeEvent[] = ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'PASSWORD_RECOVERY'];
    for (const event of notRefetched) {
      expect(HOME_REFETCH_AUTH_EVENTS.has(event), `${event} が読み直す集合に入った`).toBe(false);
      expect(shouldRefetchHomeOnAuthChange(event, USER_B, USER_A, NOT_SYNCING), event).toBe(false);
    }
  });

  it('読み直す event の集合は SIGNED_IN・SIGNED_OUT・USER_UPDATED の 3 つ', () => {
    expect([...HOME_REFETCH_AUTH_EVENTS].sort()).toEqual(['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED']);
  });
});

describe('shouldRefetchHomeOnAuthChange: ホームの読み取りが自分でセッションを同期している間 (#2235 I2)', () => {
  /** ホームの読み取りが setSession を呼んでいる間 */
  const SYNCING = true;

  it('同期の間の SIGNED_IN は、まだ利用者を確かめていなくても・別の人でも読み直さない (setSession が出す同期の知らせ)', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_A, undefined, SYNCING)).toBe(false);
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_B, USER_A, SYNCING)).toBe(false);
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_A, null, SYNCING)).toBe(false);
  });

  it('同期の間でも SIGNED_OUT・USER_UPDATED は読み直す (絞るのは SIGNED_IN だけ)', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_OUT', null, USER_A, SYNCING)).toBe(true);
    expect(shouldRefetchHomeOnAuthChange('USER_UPDATED', USER_A, USER_A, SYNCING)).toBe(true);
  });

  it('同期の間でも、読み直す集合にない event は読み直さない', () => {
    expect(shouldRefetchHomeOnAuthChange('TOKEN_REFRESHED', USER_B, USER_A, SYNCING)).toBe(false);
  });
});
