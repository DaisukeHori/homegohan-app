// handson-tour/photo.tsx — Step 1 写真からの食事追加
// Canonical: docs/design/family/09-onboarding-handson-tour/03-step1-photo.md

import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  MOCK_PHOTO_RESPONSE,
  STEP1_SUB_STEP_TO_TARGET,
  personalize,
} from '@homegohan/handson-tour-shared';
import type { SubStepOfStep1 } from '@homegohan/handson-tour-shared';

import { Card } from '../../src/components/ui';
import { getApi } from '../../src/lib/api';
import { colors, radius, spacing } from '../../src/theme';
import { useProfile } from '../../src/providers/ProfileProvider';
import { TourSandboxWrapper } from '../../src/handson-tour/TourSandboxWrapper';
import { registerTourTarget, unregisterTourTarget } from '../../src/handson-tour/useTourOverlayLogic';

const SANDBOX_SAMPLE_IMAGE = require('../../assets/handson-tour/sample-meal.webp');

// ─── Sandbox content component ────────────────────────────────
// Accepts mode / onSandboxComplete injected by TourSandboxWrapper.cloneElement
interface MealSandboxEmbedProps {
  mode?: 'sandbox';
  onSandboxComplete?: (result: unknown) => void;
  prefilled?: typeof MOCK_PHOTO_RESPONSE;
  apiOptions?: { source: 'handson_tour'; sandbox: true };
}

function MealSandboxEmbed({ onSandboxComplete, prefilled = MOCK_PHOTO_RESPONSE, apiOptions = { source: 'handson_tour', sandbox: true } }: MealSandboxEmbedProps) {
  const insets = useSafeAreaInsets();
  const [isSaving, setIsSaving] = useState(false);

  // Spotlight target refs
  const cameraButtonRef = useRef<View>(null);
  const resultDishNameRef = useRef<View>(null);
  const resultCaloriesRef = useRef<View>(null);
  const saveButtonRef = useRef<View>(null);

  useEffect(() => {
    // Register tour targets after mount
    const ids = [
      ['meal-camera-button', cameraButtonRef],
      ['meal-result-dish-name', resultDishNameRef],
      ['meal-result-calories', resultCaloriesRef],
      ['meal-save-button', saveButtonRef],
    ] as const;

    for (const [id, ref] of ids) {
      if (ref.current) registerTourTarget(id, ref.current);
    }

    return () => {
      for (const [id] of ids) {
        unregisterTourTarget(id);
      }
    };
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const api = getApi();
      await api.post('/api/meal-plans/add-from-photo', {
        ...prefilled,
        sandbox: apiOptions.sandbox,
        source: apiOptions.source,
      });
      onSandboxComplete?.(prefilled);
    } catch {
      // sandbox errors are non-fatal — complete anyway
      onSandboxComplete?.(prefilled);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View testID="meal-new-screen-sandbox" style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingTop: insets.top + 8, paddingBottom: spacing.sm, paddingHorizontal: spacing.lg,
        backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <View style={{ width: 22 }} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>食事を記録</Text>
        </View>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        {/* Sample image — Spotlight target for sub-step 1.2 */}
        <View ref={cameraButtonRef} testID="meal-camera-button">
          <Image
            source={SANDBOX_SAMPLE_IMAGE}
            style={{ width: '100%', height: 220, borderRadius: radius.lg ?? 12 }}
            resizeMode="cover"
          />
        </View>

        {/* Mock result card — Spotlight targets for sub-step 1.5 */}
        <Card>
          <View style={{ gap: spacing.sm }}>
            <View ref={resultDishNameRef} testID="meal-result-dish-name">
              <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
                {prefilled.dishName}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' }}>
              <View ref={resultCaloriesRef} testID="meal-result-calories">
                <Text style={{ fontSize: 13, color: colors.textLight }}>
                  {prefilled.calories} kcal
                </Text>
              </View>
              <Text style={{ fontSize: 13, color: colors.textLight }}>
                たんぱく質 {prefilled.protein_g}g
              </Text>
              <Text style={{ fontSize: 13, color: colors.textLight }}>
                脂質 {prefilled.fat_g}g
              </Text>
              <Text style={{ fontSize: 13, color: colors.textLight }}>
                炭水化物 {prefilled.carbs_g}g
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: colors.textMuted }}>
              ※ チュートリアル用のサンプル解析結果です
            </Text>
          </View>
        </Card>

        {/* Detected items */}
        <View style={{ gap: spacing.xs }}>
          {prefilled.detected_items.map((item) => (
            <View key={item.name} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
              <Text style={{ fontSize: 14, color: colors.text }}>{item.name}</Text>
              <Text style={{ fontSize: 13, color: colors.textMuted }}>{item.portion_g}g</Text>
            </View>
          ))}
        </View>

        {/* Save button — Spotlight target for sub-step 1.6 */}
        <View ref={saveButtonRef} testID="meal-save-button">
          <Pressable
            onPress={handleSave}
            disabled={isSaving}
            style={({ pressed }) => ({
              paddingVertical: spacing.lg,
              borderRadius: 12,
              backgroundColor: colors.accent,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: spacing.sm,
              opacity: isSaving ? 0.7 : pressed ? 0.9 : 1,
            })}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : null}
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#fff' }}>
              {isSaving ? '保存中...' : 'この食事を記録する'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

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
        <MealSandboxEmbed />
      </TourSandboxWrapper>
    </View>
  );
}
