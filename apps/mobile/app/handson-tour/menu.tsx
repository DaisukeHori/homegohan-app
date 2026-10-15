// handson-tour/menu.tsx — Step 2 AI による献立追加
// Canonical: docs/design/family/09-onboarding-handson-tour/04-step2-menu.md
//
// V4GenerateModal は React Native <Modal> を使うため、TourOverlay も別の <Modal> で
// ラップして V4GenerateModal の上に重ねる必要がある (TourSandboxWrapper は非使用)。

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View } from 'react-native';

import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  MOCK_MENU_RESPONSE,
  STEP2_SUB_STEP_TO_TARGET,
  personalize,
  fireAnalytics,
} from '@homegohan/handson-tour-shared';
import type { SubStepOfStep2 } from '@homegohan/handson-tour-shared';

import { V4GenerateModal } from '../../src/components/menu/V4GenerateModal';
import { TourOverlay } from '../../src/handson-tour/TourOverlay';
import { useLeaveTour } from '../../src/handson-tour/useLeaveTour';
import { tourAnalyticsPlatform } from '../../src/handson-tour/tour-platform';
import { useProfile } from '../../src/providers/ProfileProvider';

const i18n = HANDSON_TOUR_I18N_JA.tour;

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

export default function HandsonTourMenu() {
  const router = useRouter();
  const { profile } = useProfile();
  const nickname = safeNickname(profile?.nickname);

  const [subStep, setSubStep] = useState<SubStepOfStep2>('2.1');
  const mountTimeRef = React.useRef(Date.now());
  // ツアーを抜ける (skip API + handson_tour_skipped + /home。Step 1 と共通。#1642)。
  // leftTourRef = 抜けた。抜けたあとに残っているタイマー (2.5 の読み込み・2.8 → 2.9) や応答で、先のサブステップや Step 3 へ進めない
  const { leftTourRef, leaveTour } = useLeaveTour(2, profile?.id);

  const advanceSubStep = (next: SubStepOfStep2) => {
    if (leftTourRef.current) return;
    setSubStep(next);
  };

  // mount 時に step_viewed (step=2) を発火
  useEffect(() => {
    if (!profile?.id) return;
    fireAnalytics('handson_tour_step_viewed', {
      user_id: profile.id,
      timestamp: new Date().toISOString(),
      platform: tourAnalyticsPlatform(),
      app_version: '1.0.0',
      step: 2,
      sub_step: '2.1',
    });
  }, [profile?.id]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    switch (subStep) {
      case '2.1':
        timer = setTimeout(
          () => advanceSubStep('2.2'),
          HANDSON_TOUR_CONSTANTS.STEP2_INTRO_AUTO_MS
        );
        break;
      case '2.5':
        timer = setTimeout(
          () => advanceSubStep('2.6'),
          HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS
        );
        break;
      case '2.9':
        // Step 3 へ遷移 (ツアーを抜けたあとは進めない)
        if (!leftTourRef.current) router.push(HANDSON_TOUR_ROUTES.step3 as never);
        break;
      default:
        break;
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [subStep]);

  // 端末バック (Android) でツアーを抜ける (設計書 01-trigger-flow §2.2: Step 1〜3 の端末バックは
  // skipped{reason:'hard_back'} + skipped_at + /home)。以前は /home へ遷移するだけで、skip API も handson_tour_skipped も送っていなかった。
  // 呼び元は 2 つ: 吹き出しを包む <Modal> の onRequestClose (Android でモーダルを出している間の端末バックはこちらに来る) と、
  // TourOverlay の hardwareBackPress (overlay.onSkip)。showSkip={false} なので画面のスキップボタンからは呼ばれない
  const handleHardBack = useCallback(() => leaveTour('hard_back'), [leaveTour]);

  const handleSandboxComplete = () => {
    if (leftTourRef.current) return;
    if (profile?.id) {
      const dwell_ms = Date.now() - mountTimeRef.current;
      fireAnalytics('handson_tour_step_completed', {
        user_id: profile.id,
        timestamp: new Date().toISOString(),
        platform: tourAnalyticsPlatform(),
        app_version: '1.0.0',
        step: 2,
        dwell_ms,
      });
    }
    advanceSubStep('2.8');
    setTimeout(() => advanceSubStep('2.9'), 500);
  };

  const getBubble = (): {
    title?: string;
    body: string;
    position: 'top' | 'bottom' | 'left' | 'right' | 'auto';
    testId?: string;
  } => {
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
          title: personalize(i18n.step2.result_title, { nickname }),
          body: i18n.step2.result_bubble_no_exclude,
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
      default:
        return { body: '', position: 'auto' };
    }
  };

  const isAutoStep = ['2.1', '2.5', '2.8', '2.9'].includes(subStep);

  const getPrimaryAction = () => {
    if (isAutoStep) return undefined;
    switch (subStep) {
      case '2.2':
        return {
          label: i18n.step2.next_button,
          onPress: () => advanceSubStep('2.3'),
        };
      case '2.3':
        return {
          label: i18n.step2.next_button,
          onPress: () => advanceSubStep('2.4'),
        };
      case '2.4':
        return {
          label: i18n.step2.generate_button,
          onPress: () => advanceSubStep('2.5'),
        };
      case '2.6':
        return {
          label: i18n.step2.next_button,
          onPress: () => advanceSubStep('2.7'),
        };
      case '2.7':
        return {
          label: i18n.step2.add_button,
          onPress: () => handleSandboxComplete(),
        };
      default:
        return undefined;
    }
  };

  const target = STEP2_SUB_STEP_TO_TARGET[subStep];
  const targetTestId = typeof target === 'string' ? target : null;
  const targetTestIds = Array.isArray(target) ? target : undefined;

  return (
    <View style={{ flex: 1 }} testID="tour-step-2">
      {/* V4GenerateModal は内部で React Native <Modal> を使うため常時表示 */}
      <V4GenerateModal
        mode="sandbox"
        visible={true}
        onClose={() => {
          // Tour 中は onClose を無効化 (TourOverlay のスキップで制御)
        }}
        prefilled={MOCK_MENU_RESPONSE}
        loadingDurationMs={HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS}
        apiOptions={{ source: 'handson_tour', sandbox: true }}
        onSandboxComplete={handleSandboxComplete}
      />

      {/* TourOverlay を別 Modal でラップして V4GenerateModal の上に重ねる */}
      <Modal
        visible={true}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={handleHardBack}
      >
        <TourOverlay
          targetTestId={targetTestId}
          targetTestIds={targetTestIds}
          bubble={getBubble()}
          progress={{ current: 3, total: 5 }}
          primaryAction={getPrimaryAction()}
          showSkip={false}
          onSkip={handleHardBack}
          accessibilityLabel={i18n.step2.a11y_title}
        />
      </Modal>
    </View>
  );
}
