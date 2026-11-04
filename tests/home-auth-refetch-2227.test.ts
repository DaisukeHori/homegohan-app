/**
 * #2227 H3: /home のログインの状態の変化での読み直しの判定 (shouldRefetchHomeOnAuthChange) の回帰テスト。
 *
 * 問題 (直す前): supabase-js はタブを前に戻したときにも同じ利用者の SIGNED_IN を出すことがあり、ホームはそのたびにデータを読み直して
 * AI つきの栄養の分析を読み、LLM を呼んで安全弁 nutrition_advice_auto (上限に数えない枠) を使っていた。
 * 直したあと: SIGNED_IN は前回読んだ利用者と違うときだけ読み直す。SIGNED_OUT・USER_UPDATED はいつも、INITIAL_SESSION・TOKEN_REFRESHED は読み直さない。
 * 描画の検査は tests/ai-consultation-home-refetch-2195.test.tsx の「AI つきの栄養の分析を余分に読まない」
 */
import type { AuthChangeEvent } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { HOME_REFETCH_AUTH_EVENTS, shouldRefetchHomeOnAuthChange } from '@/lib/home-auth-refetch';

const USER_A = 'user-a';
const USER_B = 'user-b';

describe('shouldRefetchHomeOnAuthChange (#2227 H3)', () => {
  it('前回読んだ利用者と同じ人の SIGNED_IN では読み直さない', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_A, USER_A)).toBe(false);
  });

  it('前回読んだ利用者と別の人の SIGNED_IN では読み直す', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_B, USER_A)).toBe(true);
  });

  it('ログインしていないと確かめたあとの SIGNED_IN では読み直す', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_A, null)).toBe(true);
  });

  it('まだ利用者を確かめていない (開いたときの読み込みの前) の SIGNED_IN では読み直す (読み落とさない側に寄せる)', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', USER_A, undefined)).toBe(true);
  });

  it('session に利用者が無い SIGNED_IN では読み直す (同じ人と確かめられない)', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', null, USER_A)).toBe(true);
    expect(shouldRefetchHomeOnAuthChange('SIGNED_IN', undefined, USER_A)).toBe(true);
  });

  it('SIGNED_OUT・USER_UPDATED は前回読んだ利用者と同じでも読み直す', () => {
    expect(shouldRefetchHomeOnAuthChange('SIGNED_OUT', null, USER_A)).toBe(true);
    expect(shouldRefetchHomeOnAuthChange('USER_UPDATED', USER_A, USER_A)).toBe(true);
  });

  it('読み直す event の集合にない event (INITIAL_SESSION・TOKEN_REFRESHED・PASSWORD_RECOVERY) では、利用者が変わっていても読み直さない', () => {
    const notRefetched: readonly AuthChangeEvent[] = ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'PASSWORD_RECOVERY'];
    for (const event of notRefetched) {
      expect(HOME_REFETCH_AUTH_EVENTS.has(event), `${event} が読み直す集合に入った`).toBe(false);
      expect(shouldRefetchHomeOnAuthChange(event, USER_B, USER_A), event).toBe(false);
    }
  });

  it('読み直す event の集合は SIGNED_IN・SIGNED_OUT・USER_UPDATED の 3 つ', () => {
    expect([...HOME_REFETCH_AUTH_EVENTS].sort()).toEqual(['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED']);
  });
});
