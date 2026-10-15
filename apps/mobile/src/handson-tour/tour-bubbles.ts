// ハンズオンツアー Step 2 (献立) / Step 3 (バッジ) の吹き出しの文 (#1660)
// Canonical: docs/design/family/09-onboarding-handson-tour/04-step2-menu.md §3 / 05-step3-badges.md §3
//
// 画面 (app/handson-tour/menu.tsx / badges.tsx) から吹き出しの組み立てだけを外に出し、
// 「どのサブステップでも placeholder ({...}) が埋まらずに利用者に出ない」ことをテストで確かめられるようにする。
//   - 2.6 の本文は {cooking_experience_text} (と {exclude_list}) を埋める。以前は埋めずに出していた (#1660)
//   - 3.1 の本文は intro_hint ("タップで進む")。以前は {nickname} を埋めていない intro_title をそのまま本文に出していた
//     (タイトルの intro_title は埋めている。設計書 05 §3.3 の図は「{nickname} さん / もう 1 つ獲得しています! / タップで進む」)
//   - 3.1 の「n つ」と 3.2 (first_bite) の文言は共有の i18n のキーをそのまま使う。ツアーが Step 3 までに付けるのは planner だけで
//     (STEP3_BADGES_EARNED_IN_TOUR)、お試しの記録は first_bite に数えない (#1314)。3.2 は獲得の有無を言わない文言 (#1626)

import {
  HANDSON_TOUR_I18N_JA,
  buildStep2ResultBubbleBody,
  personalize,
} from '@homegohan/handson-tour-shared';
import type {
  Step2ResultBubbleProfile,
  SubStepOfStep2,
  SubStepOfStep3,
  TourOverlayProps,
} from '@homegohan/handson-tour-shared';

export type TourBubble = TourOverlayProps['bubble'];

const i18n = HANDSON_TOUR_I18N_JA.tour;

/** Step 2 の吹き出し。nickname は safeNickname を通した表示名 */
export function buildMenuTourBubble(
  subStep: SubStepOfStep2,
  params: { nickname: string; profile: Step2ResultBubbleProfile },
): TourBubble {
  switch (subStep) {
    case '2.1':
      return {
        title: i18n.step2.intro_title,
        body: i18n.step2.intro_hint,
        position: 'auto',
        // E2E (Maestro) が各 Step の最初の intro 吹き出しを見分ける目印 (設計書 09-onboarding-handson-tour の testID 一覧。#846)
        testId: 'tour-step-2-intro',
      };
    case '2.2':
      return {
        body: i18n.step2.flags_bubble,
        position: 'bottom',
      };
    case '2.3':
      return {
        body: i18n.step2.note_bubble,
        position: 'top',
      };
    case '2.4':
      return {
        body: i18n.step2.generate_bubble,
        position: 'top',
      };
    case '2.5':
      return {
        body: i18n.step2.generate_bubble,
        position: 'auto',
      };
    case '2.6':
      return {
        title: personalize(i18n.step2.result_title, { nickname: params.nickname }),
        body: buildStep2ResultBubbleBody(params.profile),
        position: 'bottom',
      };
    case '2.7':
      return {
        body: i18n.step2.add_bubble,
        position: 'top',
      };
    case '2.8':
    case '2.9':
      return {
        body: i18n.step2.add_bubble,
        position: 'auto',
      };
  }
}

/** Step 3 の吹き出し。nickname は safeNickname を通した表示名 */
export function buildBadgesTourBubble(subStep: SubStepOfStep3, params: { nickname: string }): TourBubble {
  switch (subStep) {
    case '3.0':
      return {
        body: i18n.step3.loading_text,
        position: 'auto',
      };
    case '3.1':
      return {
        title: personalize(i18n.step3.intro_title, { nickname: params.nickname }),
        body: i18n.step3.intro_hint,
        position: 'auto',
        // E2E (Maestro) が各 Step の最初の intro 吹き出しを見分ける目印 (設計書 09-onboarding-handson-tour の testID 一覧。#846)
        testId: 'tour-step-3-intro',
      };
    case '3.2':
      return {
        title: i18n.step3.first_bite_title,
        body: i18n.step3.first_bite_bubble,
        position: 'bottom',
      };
    case '3.3':
      return {
        title: i18n.step3.planner_title,
        body: i18n.step3.planner_bubble,
        position: 'bottom',
      };
    case '3.4':
      return {
        title: i18n.step3.tutorial_complete_title,
        body: i18n.step3.tutorial_complete_bubble,
        position: 'bottom',
      };
  }
}
