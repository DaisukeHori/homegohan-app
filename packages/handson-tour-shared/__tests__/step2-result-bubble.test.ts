// Step 2 サブステップ 2.6 の吹き出し本文 (buildStep2ResultBubbleBody) と、全文言の placeholder が埋まりきること (#1660)
// Canonical: docs/design/family/09-onboarding-handson-tour/04-step2-menu.md §3.7 / §6
//            docs/design/family/09-onboarding-handson-tour/14-mocks-i18n.md §2.3 / §2.5
//
// #1660: モバイルの 2.6 の吹き出しが result_bubble_no_exclude の {cooking_experience_text} を埋めずに出しており、
// 利用者に「{cooking_experience_text} の手順」と見えていた。

import { describe, expect, it } from 'vitest';

import { HANDSON_TOUR_I18N_EN, HANDSON_TOUR_I18N_JA } from '../src/i18n';
import { personalize } from '../src/personalize';
import {
  COOKING_EXPERIENCE_LEVELS,
  DEFAULT_COOKING_EXPERIENCE,
  STEP2_EXCLUDE_LIST_MAX,
  buildStep2ResultBubbleBody,
  cookingExperienceText,
  step2ExcludeList,
  toCookingExperienceLevel,
} from '../src/step2-result-bubble';

const NO_PROFILE = { allergies: [], dislikes: [], cooking_experience: null };

describe('cookingExperienceText (設計書 04 §3.7 の cookingExpText)', () => {
  it('3 段階それぞれ i18n の cooking_experience の文になる', () => {
    expect(cookingExperienceText('beginner')).toBe('初心者でも作れる');
    expect(cookingExperienceText('intermediate')).toBe('いつもの手順で作れる');
    expect(cookingExperienceText('advanced')).toBe('シェフの腕前を活かせる');
  });

  it('NULL・undefined・空・想定外の値は beginner 扱い (設計書 04 §6)', () => {
    expect(DEFAULT_COOKING_EXPERIENCE).toBe('beginner');
    for (const value of [null, undefined, '', 'expert', 1]) {
      expect(toCookingExperienceLevel(value)).toBe('beginner');
      expect(cookingExperienceText(value)).toBe('初心者でも作れる');
    }
  });

  it('EN の文言も渡せる', () => {
    expect(cookingExperienceText('advanced', HANDSON_TOUR_I18N_EN.tour.cooking_experience)).toBe('For experienced cooks');
  });

  it('取りうる値は i18n の cooking_experience セクションのキーと一致する', () => {
    expect([...COOKING_EXPERIENCE_LEVELS].sort()).toEqual(Object.keys(HANDSON_TOUR_I18N_JA.tour.cooking_experience).sort());
  });
});

describe('buildStep2ResultBubbleBody (2.6 の吹き出し本文)', () => {
  it('プロフィールが空 (除外なし・料理の経験なし) なら「初心者でも作れる の手順」(設計書 04 §6「両方 NULL」)', () => {
    expect(buildStep2ResultBubbleBody(NO_PROFILE)).toBe('初心者でも作れる の手順');
  });

  it('除外なし・料理の経験あり → result_bubble_no_exclude を埋める', () => {
    expect(buildStep2ResultBubbleBody({ ...NO_PROFILE, cooking_experience: 'intermediate' })).toBe('いつもの手順で作れる の手順');
  });

  it('除外あり → result_bubble_full を埋める (アレルギー → 苦手な食材の順に「・」でつなぐ)', () => {
    expect(
      buildStep2ResultBubbleBody({ allergies: ['卵'], dislikes: ['セロリ'], cooking_experience: 'advanced' }),
    ).toBe('卵・セロリ は除外、シェフの腕前を活かせる の手順');
  });

  it(`除外の一覧は最大 ${STEP2_EXCLUDE_LIST_MAX} 件 (設計書 04 §3.7)`, () => {
    const profile = { allergies: ['卵', '乳'], dislikes: ['セロリ', 'パクチー'], cooking_experience: null };
    expect(step2ExcludeList(profile)).toEqual(['卵', '乳', 'セロリ']);
    expect(buildStep2ResultBubbleBody(profile)).toBe('卵・乳・セロリ は除外、初心者でも作れる の手順');
  });

  it('EN の文言でも placeholder が埋まる', () => {
    const body = buildStep2ResultBubbleBody(
      { allergies: ['egg'], dislikes: [], cooking_experience: 'beginner' },
      { step2: HANDSON_TOUR_I18N_EN.tour.step2, cooking_experience: HANDSON_TOUR_I18N_EN.tour.cooking_experience },
    );
    expect(body).toBe('Excluding egg — Easy enough for beginners instructions');
  });

  it.each([
    ['空', NO_PROFILE],
    ['除外あり・経験なし', { allergies: ['卵'], dislikes: [], cooking_experience: null }],
    ['除外なし・想定外の経験', { allergies: [], dislikes: [], cooking_experience: 'expert' }],
    ['苦手な食材だけ', { allergies: [], dislikes: ['セロリ'], cooking_experience: 'advanced' }],
  ])('%s: 本文に { } が残らない', (_label, profile) => {
    const body = buildStep2ResultBubbleBody(profile);
    expect(body).not.toMatch(/[{}]/);
  });
});

// 文言の全部を、placeholder 一覧 (i18n.ts 冒頭 / 設計書 14 §2.5) の値で描いて { } が残らないこと。
// 一覧に無い placeholder を文言に足すと、ここが赤くなる (画面がその placeholder を埋める手段を持たないまま出荷されるのを防ぐ)。
describe('全文言の placeholder が既知の一覧で埋まりきる', () => {
  const KNOWN_PLACEHOLDER_VALUES = {
    nickname: '太郎',
    target_kcal: '1900',
    percent: '41',
    exclude_list: '卵・乳',
    cooking_experience_text: cookingExperienceText('beginner'),
    current: '2',
    total: '5',
  } as const;

  function collectTexts(node: unknown, path: string, out: Array<[string, string]>): void {
    if (typeof node === 'string') {
      out.push([path, node]);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) collectTexts(child, path ? `${path}.${key}` : key, out);
    }
  }

  for (const [lang, dict] of [
    ['JA', HANDSON_TOUR_I18N_JA],
    ['EN', HANDSON_TOUR_I18N_EN],
  ] as const) {
    const texts: Array<[string, string]> = [];
    collectTexts(dict, '', texts);

    it(`${lang}: 文言を集められている (集め方の番兵)`, () => {
      expect(texts.map(([path]) => path)).toEqual(
        expect.arrayContaining(['tour.step2.result_bubble_no_exclude', 'tour.step2.result_bubble_full', 'tour.a11y.progress_label']),
      );
    });

    it.each(texts)(`${lang} %s: 埋めると { } が残らない`, (_path, text) => {
      expect(personalize(text, KNOWN_PLACEHOLDER_VALUES)).not.toMatch(/[{}]/);
    });
  }

  it('埋めずに出すと { } が残る (判定の番兵)', () => {
    expect(HANDSON_TOUR_I18N_JA.tour.step2.result_bubble_no_exclude).toMatch(/\{cooking_experience_text\}/);
  });
});
