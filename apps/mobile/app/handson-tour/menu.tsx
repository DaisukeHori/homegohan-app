// handson-tour/menu.tsx — Step 2 AI による献立追加
// Canonical: docs/design/family/09-onboarding-handson-tour/04-step2-menu.md
//
// V4GenerateModal は React Native <Modal> を使うため、TourOverlay も別の <Modal> で
// ラップして V4GenerateModal の上に重ねる必要がある (TourSandboxWrapper は非使用)。

import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Modal, View } from 'react-native';

import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  MOCK_MENU_RESPONSE,
  STEP2_SUB_STEP_TO_TARGET,
  personalize,
} from '@homegohan/handson-tour-shared';
import type { SubStepOfStep2 } from '@homegohan/handson-tour-shared';

import { V4GenerateModal } from '../../src/components/menu/V4GenerateModal';
import { TourOverlay } from '../../src/handson-tour/TourOverlay';
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

  const advanceSubStep = (next: SubStepOfStep2) => {
    setSubStep(next);
  };

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
        // Step 3 へ遷移
        router.push(HANDSON_TOUR_ROUTES.step3 as never);
        break;
      default:
        break;
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [subStep]);

  const handleSkip = () => {
    router.replace('/home' as never);
  };

  const handleSandboxComplete = () => {
    advanceSubStep('2.8');
    setTimeout(() => advanceSubStep('2.9'), 500);
  };

  const getBubble = (): {
    title?: string;
    body: string;
    position: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  } => {
    switch (subStep) {
      case '2.1':
        return {
          title: i18n.step2.intro_title,
          body: i18n.step2.intro_hint,
          position: 'auto',
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
      {/* Step 2 intro マーカー: subStep 2.1 の間 DOM に存在 (E2E testID) */}
      {subStep === '2.1' && (
        <View testID="tour-step-2-intro" style={{ position: 'absolute', width: 0, height: 0 }} />
      )}
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
        onRequestClose={handleSkip}
      >
        <TourOverlay
          targetTestId={targetTestId}
          targetTestIds={targetTestIds}
          bubble={getBubble()}
          progress={{ current: 3, total: 5 }}
          primaryAction={getPrimaryAction()}
          showSkip={false}
          onSkip={handleSkip}
          accessibilityLabel={i18n.step2.a11y_title}
        />
      </Modal>
    </View>
  );
}
