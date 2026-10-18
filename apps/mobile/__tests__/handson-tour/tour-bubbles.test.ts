/**
 * tour-bubbles.test.ts
 * ハンズオンツアー Step 2 / Step 3 の吹き出しの文 (apps/mobile/src/handson-tour/tour-bubbles.ts。#1660)
 *
 * 確かめること:
 *   - 2.6 の本文は {cooking_experience_text} (と {exclude_list}) を埋める。Web (src/app/handson-tour/menu/page.tsx) と同じ文になる
 *     (以前は result_bubble_no_exclude をそのまま出し、利用者に「{cooking_experience_text} の手順」と見えていた)
 *   - 3.1 の本文は intro_hint。以前は {nickname} を埋めていない intro_title をそのまま本文に出していた
 *   - Step 2 / Step 3 のどのサブステップ・どのプロフィールでも、吹き出しのタイトルと本文に { } が残らない
 *   - 3.1 の「n つ」はツアーが Step 3 までに付けるバッジの数 (STEP3_BADGES_EARNED_IN_TOUR = planner の 1 つ)、
 *     3.2 (first_bite) は獲得の有無を言わない共有の文言 (#1626。お試しの記録は first_bite に数えない #1314)
 */
import {
  HANDSON_TOUR_I18N_JA,
  STEP3_BADGES_EARNED_IN_TOUR,
  SUB_STEPS_OF_STEP_2,
  SUB_STEPS_OF_STEP_3,
} from '@homegohan/handson-tour-shared';
import type { Step2ResultBubbleProfile } from '@homegohan/handson-tour-shared';

import { buildBadgesTourBubble, buildMenuTourBubble } from '../../src/handson-tour/tour-bubbles';

const i18n = HANDSON_TOUR_I18N_JA.tour;
const NICKNAME = '花子';

const PROFILES: Array<[string, Step2ResultBubbleProfile]> = [
  ['空 (取れなかった・未回答)', { allergies: [], dislikes: [], cooking_experience: null }],
  ['除外なし・中級', { allergies: [], dislikes: [], cooking_experience: 'intermediate' }],
  ['除外あり・上級', { allergies: ['卵', '乳'], dislikes: ['セロリ', 'パクチー'], cooking_experience: 'advanced' }],
  ['想定外の経験', { allergies: [], dislikes: ['セロリ'], cooking_experience: 'expert' }],
];

function shownText(bubble: { title?: string; body: string }): string {
  return `${bubble.title ?? ''}\n${bubble.body}`;
}

describe('buildMenuTourBubble (Step 2)', () => {
  it('2.6: 除外なし・料理の経験なしなら「初心者でも作れる の手順」(設計書 04 §6「両方 NULL」)', () => {
    const bubble = buildMenuTourBubble('2.6', { nickname: NICKNAME, profile: PROFILES[0][1] });
    expect(bubble.body).toBe('初心者でも作れる の手順');
    expect(bubble.title).toBe('花子 さんに合わせた献立');
    expect(bubble.position).toBe('bottom');
  });

  it('2.6: 除外なし・中級なら result_bubble_no_exclude を埋める', () => {
    const bubble = buildMenuTourBubble('2.6', { nickname: NICKNAME, profile: PROFILES[1][1] });
    expect(bubble.body).toBe('いつもの手順で作れる の手順');
  });

  it('2.6: 除外ありなら result_bubble_full を埋める (最大 3 件・「・」区切り)', () => {
    const bubble = buildMenuTourBubble('2.6', { nickname: NICKNAME, profile: PROFILES[2][1] });
    expect(bubble.body).toBe('卵・乳・セロリ は除外、シェフの腕前を活かせる の手順');
  });

  it('2.1: intro の目印 testId を持つ (E2E が見分ける。#846)', () => {
    expect(buildMenuTourBubble('2.1', { nickname: NICKNAME, profile: PROFILES[0][1] }).testId).toBe('tour-step-2-intro');
  });

  describe.each(PROFILES)('プロフィール: %s', (_label, profile) => {
    it.each([...SUB_STEPS_OF_STEP_2])('%s: タイトルと本文に { } が残らない', (subStep) => {
      const bubble = buildMenuTourBubble(subStep, { nickname: NICKNAME, profile });
      expect(shownText(bubble)).not.toMatch(/[{}]/);
    });
  });
});

describe('buildBadgesTourBubble (Step 3)', () => {
  it('3.1: タイトルは名前を埋めた intro_title、本文は intro_hint (設計書 05 §3.3)', () => {
    const bubble = buildBadgesTourBubble('3.1', { nickname: NICKNAME });
    expect(bubble.title).toBe('花子 さん、もう 1 つ獲得しています!');
    expect(bubble.body).toBe(i18n.step3.intro_hint);
    expect(bubble.testId).toBe('tour-step-3-intro');
  });

  it('3.1: タイトルの「n つ」は、ツアーが Step 3 までに実際に付けるバッジの数と合う (#1626)', () => {
    const bubble = buildBadgesTourBubble('3.1', { nickname: NICKNAME });
    expect(bubble.title).toContain(`もう ${STEP3_BADGES_EARNED_IN_TOUR.length} つ獲得しています`);
  });

  it('3.2: first_bite の吹き出しは共有の文言で、獲得の有無を言わない (#1626)', () => {
    const bubble = buildBadgesTourBubble('3.2', { nickname: NICKNAME });
    expect(bubble.title).toBe(i18n.step3.first_bite_title);
    expect(bubble.body).toBe(i18n.step3.first_bite_bubble);
    expect(bubble.body).toBe('食事を「完了」にするともらえるバッジです');
    expect(bubble.body).not.toMatch(/しました|もらえます/);
  });

  it.each([...SUB_STEPS_OF_STEP_3])('%s: タイトルと本文に { } が残らない', (subStep) => {
    expect(shownText(buildBadgesTourBubble(subStep, { nickname: NICKNAME }))).not.toMatch(/[{}]/);
  });
});
