// handson-tour/photo.tsx — Step 1 写真からの食事追加
// Canonical: docs/design/family/09-onboarding-handson-tour/03-step1-photo.md

import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  MOCK_PHOTO_RESPONSE,
  STEP1_SUB_STEP_TO_TARGET,
  personalize,
} from '@homegohan/handson-tour-shared';
import type { SubStepOfStep1 } from '@homegohan/handson-tour-shared';

import { useProfile } from '../../src/providers/ProfileProvider';
import { TourSandboxWrapper } from '../../src/handson-tour/TourSandboxWrapper';

const i18n = HANDSON_TOUR_I18N_JA.tour;

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

export default function HandsonTourPhoto() {
  const router = useRouter();
  const { profile } = useProfile();
  const nickname = safeNickname(profile?.nickname);
  const targetKcal = 1900; // フォールバック値、実際はプロフィールから取得
  const percent = Math.round((MOCK_PHOTO_RESPONSE.calories / targetKcal) * 100);

  const [subStep, setSubStep] = useState<SubStepOfStep1>('1.1');
  const mountTimeRef = useRef(Date.now());

  const advanceSubStep = (next: SubStepOfStep1) => {
    setSubStep(next);
  };

  // サブステップ自動進行テーブル
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    switch (subStep) {
      case '1.1':
        timer = setTimeout(
          () => advanceSubStep('1.2'),
          HANDSON_TOUR_CONSTANTS.STEP1_INTRO_AUTO_MS
        );
        break;
      case '1.2':
        timer = setTimeout(
          () => advanceSubStep('1.3'),
          HANDSON_TOUR_CONSTANTS.STEP1_CAMERA_AUTO_MS
        );
        break;
      case '1.3':
        timer = setTimeout(
          () => advanceSubStep('1.4'),
          HANDSON_TOUR_CONSTANTS.STEP1_ANALYZING_DURATION_MS
        );
        break;
      case '1.4':
        timer = setTimeout(
          () => advanceSubStep('1.5'),
          HANDSON_TOUR_CONSTANTS.STEP1_RESULT_TO_SPOTLIGHT_MS
        );
        break;
      default:
        break;
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [subStep]);

  const handleSandboxComplete = async () => {
    // Step 2 へ遷移
    router.push(HANDSON_TOUR_ROUTES.step2 as never);
  };

  const handleSkip = async () => {
    router.replace('/home' as never);
  };

  // サブステップに応じた bubble 設定
  const getBubble = (): {
    title?: string;
    body: string;
    position: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  } => {
    switch (subStep) {
      case '1.1':
        return {
          title: i18n.step1.intro_title,
          body: i18n.step1.intro_hint,
          position: 'auto',
        };
      case '1.2':
        return {
          body: i18n.step1.camera_bubble,
          position: 'top',
        };
      case '1.3':
        return {
          body: i18n.step1.camera_bubble,
          position: 'auto',
        };
      case '1.4':
        return {
          body: i18n.step1.camera_bubble,
          position: 'auto',
        };
      case '1.5':
        return {
          title: i18n.step1.result_title,
          body: personalize(i18n.step1.result_bubble_with_target, {
            nickname,
            target_kcal: targetKcal,
            percent,
          }),
          position: 'bottom',
        };
      case '1.6':
        return {
          body: i18n.step1.save_bubble,
          position: 'top',
        };
      case '1.7':
        return {
          body: i18n.step1.save_bubble,
          position: 'auto',
        };
      default:
        return { body: '', position: 'auto' };
    }
  };

  const isAutoStep = ['1.1', '1.2', '1.3', '1.4', '1.7'].includes(subStep);

  const primaryAction = !isAutoStep
    ? {
        label: subStep === '1.6' ? i18n.step1.save_button : i18n.step1.next_button,
        onPress: () => {
          if (subStep === '1.5') advanceSubStep('1.6');
          else if (subStep === '1.6') {
            advanceSubStep('1.7');
            // 保存 API は sandbox モードで既存コンポーネントが呼ぶ
            setTimeout(() => handleSandboxComplete(), 1000);
          }
        },
      }
    : undefined;

  return (
    <View style={{ flex: 1 }} testID="tour-step-1">
      <TourSandboxWrapper
        subStep={subStep}
        subStepToTarget={STEP1_SUB_STEP_TO_TARGET}
        overlay={{
          bubble: getBubble(),
          progress: { current: 2, total: 5 },
          primaryAction,
          showSkip: false,
          onSkip: handleSkip,
          accessibilityLabel: i18n.step1.a11y_title,
        }}
        childProps={{
          mode: 'sandbox',
          initialStep: 'result',
          prefilled: MOCK_PHOTO_RESPONSE,
          apiOptions: { source: 'handson_tour', sandbox: true },
        }}
        onSandboxComplete={handleSandboxComplete}
      >
        {/* P3-B が MealNewScreen に mode='sandbox' サポートを追加する。現在はプレースホルダー */}
        <View style={{ flex: 1 }} />
      </TourSandboxWrapper>
    </View>
  );
}
