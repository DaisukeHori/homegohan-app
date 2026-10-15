// @vitest-environment node
/**
 * #1649: Edge Functions の名前の判定 (supabase/functions/_shared/profile-name.ts) が、正本 (packages/shared の normalizeProfileName) と同じ答えを返す。
 *
 * Edge Functions (Deno) は packages/shared を import しないので、同じ規則の写しを _shared に置いている。
 * 1. 写しの値と答えが正本と一致する (仮置きの値・代表的な入力)
 * 2. AI への入力 (_shared/user-context.ts の buildUserSummary / buildUserContextForPrompt) は、
 *    仮置きの 'Guest'・空白だけを名前として渡さない (「ニックネーム: 未設定」)。'guest' や実名はそのまま (前後の空白だけ除く)
 */
import { describe, expect, it } from 'vitest';
import {
  PROFILE_NAME_PLACEHOLDER as SHARED_PLACEHOLDER,
  normalizeProfileName as sharedNormalizeProfileName,
} from '@homegohan/shared';
import {
  PROFILE_NAME_PLACEHOLDER as EDGE_PLACEHOLDER,
  normalizeProfileName as edgeNormalizeProfileName,
} from '../supabase/functions/_shared/profile-name';
import { buildUserContextForPrompt, buildUserSummary } from '../supabase/functions/_shared/user-context';

/** 正本と写しの両方に通す入力。名前が無いもの・本人が付けた名前・文字列でないもの */
const INPUTS: readonly unknown[] = [
  'Guest',
  ' Guest ',
  '\tGuest\n',
  '',
  '   ',
  'guest',
  'GUEST',
  'Guests',
  'ゲスト',
  '花子',
  ' 花子 ',
  'Guest 太郎',
  null,
  undefined,
  0,
  {},
];

describe('Edge の normalizeProfileName は packages/shared の正本と一致する (#1649)', () => {
  it('仮置きの値が同じ', () => {
    expect(EDGE_PLACEHOLDER).toBe(SHARED_PLACEHOLDER);
  });

  it.each(INPUTS.map((input) => [input]))('%j に対する答えが正本と同じ', (input) => {
    expect(edgeNormalizeProfileName(input)).toBe(sharedNormalizeProfileName(input));
  });

  it('名前が無いもの (仮置き・空白だけ) は null、本人が付けた名前は前後の空白を除いて返す', () => {
    expect(edgeNormalizeProfileName(' Guest ')).toBeNull();
    expect(edgeNormalizeProfileName('   ')).toBeNull();
    expect(edgeNormalizeProfileName('guest')).toBe('guest');
    expect(edgeNormalizeProfileName(' 花子 ')).toBe('花子');
  });
});

describe('AI への入力 (user-context) に仮置きの Guest を名前として渡さない (#1649)', () => {
  it.each([
    ['Guest', '未設定'],
    [' Guest ', '未設定'],
    ['   ', '未設定'],
    ['guest', 'guest'],
    [' 花子 ', '花子'],
  ])('nickname が %j なら「- ニックネーム: %s」', (nickname, expected) => {
    const summary = buildUserSummary({ nickname }, null, null, null, null, null);

    expect(summary.split('\n')).toContain(`- ニックネーム: ${expected}`);
  });

  it.each([
    ['Guest', null],
    [' Guest ', null],
    ['   ', null],
    ['guest', 'guest'],
    [' 花子 ', '花子'],
  ])('buildUserContextForPrompt の profile.nickname は %j → %j', (nickname, expected) => {
    expect(buildUserContextForPrompt({ profile: { nickname } }).profile.nickname).toBe(expected);
  });
});
