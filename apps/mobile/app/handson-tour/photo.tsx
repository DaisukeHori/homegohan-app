// handson-tour/photo.tsx — Step 1 写真からの食事追加
// Canonical: docs/design/family/09-onboarding-handson-tour/03-step1-photo.md

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { ViewInstance } from 'react-native';
import { Text } from '../../src/components/ui/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  MOCK_PHOTO_RESPONSE,
  STEP1_SUB_STEP_TO_TARGET,
  personalize,
  fireAnalytics,
  TOUR_PHOTO_SAVE_URL,
  buildTourPhotoSaveBody,
} from '@homegohan/handson-tour-shared';
import type { SubStepOfStep1 } from '@homegohan/handson-tour-shared';

import { Card } from '../../src/components/ui';
import { getApi } from '../../src/lib/api';
import { getAnalyticsAppVersion } from '../../src/lib/app-version';
import { colors, radius, spacing } from '../../src/theme';
import { useProfile } from '../../src/providers/ProfileProvider';
import { safeNickname } from '../../src/handson-tour/safe-nickname';
import { TourSandboxWrapper } from '../../src/handson-tour/TourSandboxWrapper';
import {
  tourPhotoSaveErrorOutcomeOf,
  type TourPhotoSaveFailure,
} from '../../src/handson-tour/photo-save-failure';
import { registerTourTarget, unregisterTourTarget } from '../../src/handson-tour/useTourOverlayLogic';
import { useLeaveTour, useTourHardBack } from '../../src/handson-tour/useLeaveTour';
import { tourAnalyticsPlatform } from '../../src/handson-tour/tour-platform';

const SANDBOX_SAMPLE_IMAGE = require('../../assets/handson-tour/sample-meal.webp');

// ─── Sandbox content component ────────────────────────────────
// Accepts mode / onSandboxComplete injected by TourSandboxWrapper.cloneElement
// 保存そのもの (POST /api/meal-plans/add-from-photo) は親 (HandsonTourPhoto の handleSave) がする。
// 吹き出しの【保存】とこの画面の保存ボタンのどちらからでも、同じ保存を通る (#1625。Web と同じ形)
interface MealSandboxEmbedProps {
  mode?: 'sandbox';
  onSandboxComplete?: (result: unknown) => void;
  prefilled?: typeof MOCK_PHOTO_RESPONSE;
  /** 保存中 (親の state)。ボタンを押せなくしてスピナーを出す */
  isSaving?: boolean;
}

function MealSandboxEmbed({ onSandboxComplete, prefilled = MOCK_PHOTO_RESPONSE, isSaving = false }: MealSandboxEmbedProps) {
  const insets = useSafeAreaInsets();

  // Spotlight target refs
  const cameraButtonRef = useRef<ViewInstance>(null);
  const resultDishNameRef = useRef<ViewInstance>(null);
  const resultCaloriesRef = useRef<ViewInstance>(null);
  const saveButtonRef = useRef<ViewInstance>(null);

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

  const handleSave = () => {
    onSandboxComplete?.(prefilled);
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
            testID="meal-save-button-press"
            onPress={handleSave}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityState={{ disabled: isSaving, busy: isSaving }}
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
              <ActivityIndicator testID="tour-step-1-saving" size="small" color="#fff" />
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

export default function HandsonTourPhoto() {
  const router = useRouter();
  const { profile } = useProfile();
  const nickname = safeNickname(profile?.nickname);
  const targetKcal = 1900; // フォールバック値、実際はプロフィールから取得
  const percent = Math.round((MOCK_PHOTO_RESPONSE.calories / targetKcal) * 100);

  const [subStep, setSubStep] = useState<SubStepOfStep1>('1.1');
  const [isSaving, setIsSaving] = useState(false);
  // 保存の失敗 (設計書 03-step1 §3.10 のエラー画面)。連続の失敗回数で【あとで】を強調する
  const [saveError, setSaveError] = useState(false);
  const [saveErrorCount, setSaveErrorCount] = useState(0);
  const savingRef = useRef(false);
  // ツアーを抜ける (skip API + handson_tour_skipped + /home。Step 2・3 と共通。#1642)。
  // leftTourRef = 抜けた。抜けたあとに保存の応答が返っても Step 2 へ進めない・エラー画面を出さない。
  // 端末バックを続けて押しても skip を 1 回だけ送る
  const { leftTourRef, leaveTour } = useLeaveTour(1, profile?.id);
  const mountTimeRef = useRef(Date.now());

  // mount 時に step_viewed (step=1) を発火
  useEffect(() => {
    if (!profile?.id) return;
    fireAnalytics('handson_tour_step_viewed', {
      user_id: profile.id,
      timestamp: new Date().toISOString(),
      platform: tourAnalyticsPlatform(),
      app_version: getAnalyticsAppVersion(),
      step: 1,
      sub_step: '1.1',
    });
  }, [profile?.id]);

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

  // 保存 (サブステップ 1.6 → 1.7 → 1.8)。設計書 03-step1 §3.7〜§3.10 (Web の src/app/handson-tour/photo/page.tsx と同じ形。#1625):
  // 保存の API を呼び、成功したら Step 2 へ。失敗したら進まずにエラー画面 (tour-step-1-error) を出し、
  // 【もう一度】で 1.7 から再実行、【あとで】でホームへ。
  // 以前は、本文が MOCK_PHOTO_RESPONSE そのままで mealType が無く 400 になり、その失敗も握りつぶして進んでいた。
  // 吹き出しの【保存】は保存の API を呼ばずに 1 秒後に Step 2 へ進むだけだった。
  // ただし「この利用者はお試しの保存の対象ではない」(sandbox_not_eligible) は、通信や保存の失敗ではなく、何度送っても変わらない答えなので、
  // エラー画面を出さずに Step 2 へ進める (設定からのやり直し = 設計書 01-trigger-flow §1.2 / §4.2 は Step 4 まで通して見せる)。
  const handleSave = async () => {
    // 二重送信を防ぐ (吹き出しの【保存】と、下の画面の保存ボタンの両方から呼ばれうる)。ツアーを抜けたあと (ホームへの遷移中) も送らない
    if (savingRef.current || leftTourRef.current) return;
    savingRef.current = true;
    setSaveError(false);
    advanceSubStep('1.7');
    setIsSaving(true);

    let failure: TourPhotoSaveFailure | null = null;
    try {
      await getApi().post(TOUR_PHOTO_SAVE_URL, buildTourPhotoSaveBody());
    } catch (error) {
      const outcome = tourPhotoSaveErrorOutcomeOf(error);
      if (outcome.kind === 'failed') failure = outcome.failure;
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }

    // 保存の応答を待つ間に端末バックでツアーを抜けていたら、ここで終える (ホームへの遷移を Step 2 へ上書きしない)
    if (leftTourRef.current) return;

    if (failure) {
      // 失敗は必ず記録する。そのうえでエラー画面を出す (設計書 03-step1 §3.10)
      if (profile?.id) {
        fireAnalytics('handson_tour_step_error', {
          user_id: profile.id,
          timestamp: new Date().toISOString(),
          platform: tourAnalyticsPlatform(),
          app_version: getAnalyticsAppVersion(),
          step: 1,
          sub_step: '1.6',
          ...failure,
        });
      }
      setSaveErrorCount((count) => count + 1);
      setSaveError(true);
      return;
    }

    // 完了の計測は保存が成功してから (設計書 03-step1 §9: handson_tour_step_completed は 1.6 保存成功)。
    // 保存の対象でない利用者 (sandbox_not_eligible) も Step 1 を終えて先へ進むので記録する
    if (profile?.id) {
      fireAnalytics('handson_tour_step_completed', {
        user_id: profile.id,
        timestamp: new Date().toISOString(),
        platform: tourAnalyticsPlatform(),
        app_version: getAnalyticsAppVersion(),
        step: 1,
        dwell_ms: Date.now() - mountTimeRef.current,
      });
    }
    // Step 2 へ遷移
    router.push(HANDSON_TOUR_ROUTES.step2 as never);
  };

  // ツアーを抜ける (/home へ遷移 + skip API。設計書 03-step1 §9: handson_tour_skipped)。呼び元は 3 つ:
  //   - エラー画面の【あとで】 → 'user_action' (§3.10)
  //   - 吹き出しのオーバーレイの端末バック (TourOverlay の hardwareBackPress が overlay.onSkip を呼ぶ) → 'hard_back'
  //   - エラー画面の端末バック (下の useTourHardBack。エラー画面ではオーバーレイを出さないので自前で受ける) → 'hard_back'
  //   (設計書 01-trigger-flow §2.2: Step 1〜3 の端末バックは skipped{reason:'hard_back'} + skipped_at + /home)
  const handleSkipByUser = useCallback(() => leaveTour('user_action'), [leaveTour]);
  const handleHardBack = useCallback(() => leaveTour('hard_back'), [leaveTour]);

  // エラー画面の端末バック (Android)。エラー画面は TourSandboxWrapper (= TourOverlay の hardwareBackPress) を外して出すので、
  // ここで受けないと端末バックが画面の戻る (Step 0 の Welcome) になってしまう
  useTourHardBack(saveError, handleHardBack);

  // サブステップに応じた bubble 設定
  const getBubble = (): {
    title?: string;
    body: string;
    position: 'top' | 'bottom' | 'left' | 'right' | 'auto';
    testId?: string;
  } => {
    switch (subStep) {
      case '1.1':
        return {
          title: i18n.step1.intro_title,
          body: i18n.step1.intro_hint,
          position: 'auto',
          // E2E (Maestro) が各 Step の最初の intro 吹き出しを見分ける目印 (設計書 09-onboarding-handson-tour の testID 一覧。#846)
          testId: 'tour-step-1-intro',
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

  const primaryAction = (() => {
    if (subStep === '1.5') {
      return {
        label: i18n.step1.next_button,
        onPress: () => advanceSubStep('1.6'),
      };
    }
    if (subStep === '1.6') {
      return {
        label: i18n.step1.save_button,
        onPress: handleSave,
        disabled: isSaving,
        showSpinner: isSaving,
      };
    }
    // 1.1〜1.4 は自動で進む。1.7 は保存中 (ボタンを出さない)
    return undefined;
  })();

  if (saveError) {
    // 設計書 03-step1 §3.10: フルスクリーンのエラー画面 (Step 0 と同じパターン)。吹き出しのオーバーレイは出さない
    const emphasizeSkip = saveErrorCount >= HANDSON_TOUR_CONSTANTS.ERROR_CONSECUTIVE_THRESHOLD;
    return (
      <View
        style={errorStyles.backdrop}
        testID="tour-step-1-error"
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        <View style={errorStyles.modal}>
          <Text style={errorStyles.title} accessibilityRole="header">
            {`⚠ ${i18n.step1.error_title}`}
          </Text>
          <Text style={errorStyles.subtitle}>{i18n.step1.error_subtitle}</Text>
          <Pressable
            testID="tour-step-1-error-retry"
            onPress={handleSave}
            accessibilityRole="button"
            style={errorStyles.retryButton}
          >
            <Text style={errorStyles.retryButtonText}>{i18n.step1.error_retry_button}</Text>
          </Pressable>
          <Pressable
            testID="tour-step-1-error-skip"
            onPress={handleSkipByUser}
            accessibilityRole="button"
            style={errorStyles.skipButton}
          >
            <Text style={[errorStyles.skipButtonText, emphasizeSkip && errorStyles.skipButtonTextEmphasized]}>
              {i18n.step1.error_skip_button}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

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
          // 端末バック (TourOverlay の hardwareBackPress) で呼ばれる。showSkip: false なので画面のスキップボタンからは呼ばれない
          onSkip: handleHardBack,
          accessibilityLabel: i18n.step1.a11y_title,
        }}
        childProps={{
          mode: 'sandbox',
          initialStep: 'result',
          prefilled: MOCK_PHOTO_RESPONSE,
          isSaving,
        }}
        onSandboxComplete={handleSave}
      >
        <MealSandboxEmbed />
      </TourSandboxWrapper>
    </View>
  );
}

// エラー画面 (設計書 03-step1 §3.10)。見た目は Step 0 (app/handson-tour/index.tsx) のモーダルに合わせる
const errorStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  modal: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    width: '100%',
    maxWidth: 400,
    paddingHorizontal: 24,
    paddingVertical: 32,
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#4B5563',
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    width: '100%',
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  skipButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  skipButtonText: {
    color: '#6B7280',
    fontSize: 14,
  },
  skipButtonTextEmphasized: {
    color: '#111827',
    fontWeight: '700',
  },
});
