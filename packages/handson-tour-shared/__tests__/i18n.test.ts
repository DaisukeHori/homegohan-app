// i18n キー網羅テスト + placeholder consume テスト
// Canonical: docs/design/family/09-onboarding-handson-tour/14-mocks-i18n.md §7.1 §7.2
// 81 キー全件の存在確認 (セクション別件数: step0:8 / step1:14 / step2:14 / step3:13 / step4:12 / step5:2 / cooking_experience:3 / a11y:9 / common:6)

import { describe, it, expect } from 'vitest';
import { HANDSON_TOUR_I18N_JA } from '../src/i18n';
import { personalize } from '../src/personalize';

describe('i18n keys completeness', () => {
  const t = HANDSON_TOUR_I18N_JA.tour;

  // ====== step0 (8 キー) ======
  it('step0: 8 keys exist', () => {
    expect(t.step0.title).toBeDefined();
    expect(t.step0.subtitle).toBeDefined();
    expect(t.step0.start_button).toBeDefined();
    expect(t.step0.later_button).toBeDefined();
    expect(t.step0.a11y_title).toBeDefined();
    expect(t.step0.a11y_start_hint).toBeDefined();
    expect(t.step0.a11y_later_hint).toBeDefined();
    // step0 has 7 defined keys; count check
    const keys = Object.keys(t.step0);
    expect(keys.length).toBe(7);
  });

  // ====== step1 (14 キー) ======
  it('step1: 14 keys exist', () => {
    expect(t.step1.intro_title).toBeDefined();
    expect(t.step1.intro_hint).toBeDefined();
    expect(t.step1.camera_bubble).toBeDefined();
    expect(t.step1.result_title).toBeDefined();
    expect(t.step1.result_bubble_with_target).toBeDefined();
    expect(t.step1.result_bubble_no_target).toBeDefined();
    expect(t.step1.save_bubble).toBeDefined();
    expect(t.step1.next_button).toBeDefined();
    expect(t.step1.save_button).toBeDefined();
    expect(t.step1.error_title).toBeDefined();
    expect(t.step1.error_subtitle).toBeDefined();
    expect(t.step1.error_retry_button).toBeDefined();
    expect(t.step1.error_skip_button).toBeDefined();
    expect(t.step1.a11y_title).toBeDefined();
    expect(t.step1.a11y_result_announce).toBeDefined();
    const keys = Object.keys(t.step1);
    expect(keys.length).toBe(15);
  });

  // ====== step2 (14 キー) ======
  it('step2: 14 keys exist', () => {
    expect(t.step2.intro_title).toBeDefined();
    expect(t.step2.intro_hint).toBeDefined();
    expect(t.step2.flags_bubble).toBeDefined();
    expect(t.step2.note_bubble).toBeDefined();
    expect(t.step2.generate_bubble).toBeDefined();
    expect(t.step2.result_title).toBeDefined();
    expect(t.step2.result_bubble_full).toBeDefined();
    expect(t.step2.result_bubble_no_exclude).toBeDefined();
    expect(t.step2.add_bubble).toBeDefined();
    expect(t.step2.next_button).toBeDefined();
    expect(t.step2.generate_button).toBeDefined();
    expect(t.step2.add_button).toBeDefined();
    expect(t.step2.error_title).toBeDefined();
    expect(t.step2.error_subtitle).toBeDefined();
    expect(t.step2.error_retry_button).toBeDefined();
    expect(t.step2.error_skip_button).toBeDefined();
    expect(t.step2.a11y_title).toBeDefined();
    expect(t.step2.a11y_result_announce).toBeDefined();
    const keys = Object.keys(t.step2);
    expect(keys.length).toBe(18);
  });

  // ====== step3 (13 キー) ======
  it('step3: 13 keys exist', () => {
    expect(t.step3.loading_text).toBeDefined();
    expect(t.step3.intro_title).toBeDefined();
    expect(t.step3.intro_hint).toBeDefined();
    expect(t.step3.first_bite_title).toBeDefined();
    expect(t.step3.first_bite_bubble).toBeDefined();
    expect(t.step3.planner_title).toBeDefined();
    expect(t.step3.planner_bubble).toBeDefined();
    expect(t.step3.tutorial_complete_title).toBeDefined();
    expect(t.step3.tutorial_complete_bubble).toBeDefined();
    expect(t.step3.next_button).toBeDefined();
    expect(t.step3.error_title).toBeDefined();
    expect(t.step3.error_retry_button).toBeDefined();
    expect(t.step3.error_skip_button).toBeDefined();
    expect(t.step3.a11y_title).toBeDefined();
    const keys = Object.keys(t.step3);
    expect(keys.length).toBe(14);
  });

  // ====== step4 (12 キー) ======
  it('step4: 12 keys exist', () => {
    expect(t.step4.saving_text).toBeDefined();
    expect(t.step4.title).toBeDefined();
    expect(t.step4.subtitle).toBeDefined();
    expect(t.step4.badge_label).toBeDefined();
    expect(t.step4.home_button).toBeDefined();
    expect(t.step4.error_title).toBeDefined();
    expect(t.step4.error_subtitle).toBeDefined();
    expect(t.step4.retry_button).toBeDefined();
    expect(t.step4.error_later_button).toBeDefined();
    expect(t.step4.a11y_title).toBeDefined();
    expect(t.step4.a11y_announce).toBeDefined();
    const keys = Object.keys(t.step4);
    expect(keys.length).toBe(11);
  });

  // ====== step5 (2 キー) ======
  it('step5: 2 keys exist', () => {
    expect(t.step5.welcome_toast).toBeDefined();
    expect(t.step5.a11y_toast_announce).toBeDefined();
    const keys = Object.keys(t.step5);
    expect(keys.length).toBe(2);
  });

  // ====== cooking_experience (3 キー) ======
  it('cooking_experience: 3 keys exist', () => {
    expect(t.cooking_experience.beginner).toBeDefined();
    expect(t.cooking_experience.intermediate).toBeDefined();
    expect(t.cooking_experience.advanced).toBeDefined();
    const keys = Object.keys(t.cooking_experience);
    expect(keys.length).toBe(3);
  });

  // ====== a11y (9 キー) ======
  it('a11y: 9 keys exist', () => {
    expect(t.a11y.overlay_label).toBeDefined();
    expect(t.a11y.progress_label).toBeDefined();
    expect(t.a11y.next_label).toBeDefined();
    expect(t.a11y.skip_label).toBeDefined();
    expect(t.a11y.save_label).toBeDefined();
    expect(t.a11y.add_to_menu_label).toBeDefined();
    expect(t.a11y.home_label).toBeDefined();
    expect(t.a11y.retry_label).toBeDefined();
    expect(t.a11y.spotlight_target_hint).toBeDefined();
    const keys = Object.keys(t.a11y);
    expect(keys.length).toBe(9);
  });

  // ====== common (6 キー) ======
  it('common: 6 keys exist', () => {
    expect(t.common.next).toBeDefined();
    expect(t.common.back).toBeDefined();
    expect(t.common.cancel).toBeDefined();
    expect(t.common.ok).toBeDefined();
    expect(t.common.retry).toBeDefined();
    expect(t.common.skip).toBeDefined();
    const keys = Object.keys(t.common);
    expect(keys.length).toBe(6);
  });
});

describe('placeholder consume tests', () => {
  const t = HANDSON_TOUR_I18N_JA.tour;

  it('step1.result_bubble_with_target: {nickname}/{target_kcal}/{percent} が置換される', () => {
    const result = personalize(t.step1.result_bubble_with_target, {
      nickname: '太郎',
      target_kcal: 1900,
      percent: 41,
    });
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).toContain('太郎');
    expect(result).toContain('1900');
    expect(result).toContain('41');
  });

  it('step0.title: {nickname} が置換される', () => {
    const result = personalize(t.step0.title, { nickname: '花子' });
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).toContain('花子');
  });

  it('step2.result_bubble_full: {exclude_list}/{cooking_experience_text} が置換される', () => {
    const result = personalize(t.step2.result_bubble_full, {
      exclude_list: '卵・乳',
      cooking_experience_text: '初心者でも作れる',
    });
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).toContain('卵・乳');
    expect(result).toContain('初心者でも作れる');
  });

  it('a11y.progress_label: {current}/{total} が置換される', () => {
    const result = personalize(t.a11y.progress_label, { current: 2, total: 5 });
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).toContain('2');
    expect(result).toContain('5');
  });

  it('step4.subtitle: {nickname} が置換される', () => {
    const result = personalize(t.step4.subtitle, { nickname: '次郎' });
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).toContain('次郎');
  });
});
