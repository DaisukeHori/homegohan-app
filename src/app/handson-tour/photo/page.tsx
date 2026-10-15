'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { TourSandboxWrapper } from '@/components/handson-tour/TourSandboxWrapper';
import {
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  HANDSON_TOUR_CONSTANTS,
  MOCK_PHOTO_RESPONSE,
  STEP1_SUB_STEP_TO_TARGET,
  personalize,
  fireAnalytics,
  TOUR_PHOTO_SAVE_URL,
  buildTourPhotoSaveBody,
  isSandboxNotEligibleBody,
  type SubStepOfStep1,
} from '@homegohan/handson-tour-shared';
import { createClient } from '@/lib/supabase/client';
import {
  EMPTY_PHOTO_TOUR_PROFILE,
  fetchPhotoTourProfile,
  type PhotoTourProfile,
} from '@/lib/handson-tour/tour-profile';
import { reportTourProfileFailures } from '@/lib/handson-tour/tour-profile-report';

/** 保存の失敗の記録 (handson_tour_step_error の error_code / error_message / http_status) */
type SaveFailure = {
  error_code: 'sandbox_save_failed' | 'sandbox_save_network_error';
  error_message: string;
  http_status?: number;
};

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

function buildBubble(subStep: SubStepOfStep1, profile: PhotoTourProfile) {
  const i18n = HANDSON_TOUR_I18N_JA.tour.step1;
  const nickname = safeNickname(profile.nickname);

  switch (subStep) {
    case '1.1':
      return {
        body: i18n.intro_title,
        position: 'auto' as const,
        // E2E が各 Step の最初の intro 吹き出しを見分ける目印 (設計書 09-onboarding-handson-tour の testID 一覧。#846)
        testId: 'tour-step-1-intro',
      };
    case '1.2':
      return {
        body: i18n.camera_bubble,
        position: 'auto' as const,
      };
    case '1.3':
    case '1.4':
      return {
        body: i18n.camera_bubble,
        position: 'auto' as const,
      };
    case '1.5': {
      const targetKcal = profile.target_kcal;
      if (targetKcal) {
        const percent = Math.round((MOCK_PHOTO_RESPONSE.calories / targetKcal) * 100);
        return {
          title: i18n.result_title,
          body: personalize(i18n.result_bubble_with_target, {
            nickname,
            target_kcal: String(targetKcal),
            percent: String(percent),
          }),
          position: 'bottom' as const,
        };
      }
      return {
        title: i18n.result_title,
        body: i18n.result_bubble_no_target,
        position: 'bottom' as const,
      };
    }
    case '1.6':
      return {
        body: i18n.save_bubble,
        position: 'auto' as const,
      };
    case '1.7':
      return {
        body: i18n.camera_bubble,
        position: 'auto' as const,
      };
    default:
      return {
        body: '',
        position: 'auto' as const,
      };
  }
}

export default function HandsonTourPhotoPage() {
  const router = useRouter();
  const [subStep, setSubStep] = useState<SubStepOfStep1>('1.1');
  const [profile, setProfile] = useState<PhotoTourProfile>(EMPTY_PHOTO_TOUR_PROFILE);
  const [isSaving, setIsSaving] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  // 保存の失敗 (設計書 03-step1 §3.10 のエラー画面)。連続の失敗回数で【あとで】を強調する
  const [saveError, setSaveError] = useState(false);
  const [saveErrorCount, setSaveErrorCount] = useState(0);
  const savingRef = useRef(false);
  const mountTimeRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase.auth
      .getUser()
      .then(async ({ data: { user } }) => {
        if (!user || cancelled) return;
        setUserId(user.id);
        // #1040: 目標カロリーは nutrition_targets.daily_calories にある
        // (以前は存在しない user_profiles.target_kcal_per_day を select して 42703 で失敗し、ニックネームも空のままだった)
        const { profile: loaded, failures } = await fetchPhotoTourProfile(supabase, user.id);
        if (cancelled) return;
        setProfile(loaded);
        // 体験モードなので失敗してもブロックしないが、必ず記録する
        reportTourProfileFailures({ step: 1, userId: user.id, failures });
      })
      .catch(() => {
        // 認証情報の取得などに失敗してもパーソナライズなしで続ける(体験モードのため必須ではない)
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // mount 時に step_viewed (step=1) を発火
  useEffect(() => {
    if (!userId) return;
    fireAnalytics('handson_tour_step_viewed', {
      user_id: userId,
      timestamp: new Date().toISOString(),
      platform: 'web' as const,
      app_version: '1.0.0',
      step: 1,
      sub_step: '1.1',
    });
  }, [userId]);

  const advanceSubStep = (next: SubStepOfStep1) => {
    setSubStep(next);
  };

  // #1057 (UX1-03): ツアー中盤に途中離脱手段が無く完走を強制していたため、
  // Step0(page.tsx)と同じパターンでスキップを追加する
  const handleSkip = async () => {
    if (userId) {
      fireAnalytics('handson_tour_skipped', {
        user_id: userId,
        timestamp: new Date().toISOString(),
        platform: 'web' as const,
        app_version: '1.0.0',
        step: 1,
        reason: 'user_action',
      });
    }
    try {
      await fetch('/api/handson-tour/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 1, reason: 'user_action' }),
      });
    } catch {
      // ネットワークエラー時もローカルでスキップ
    }
    router.push('/home');
  };

  // 保存 (サブステップ 1.6 → 1.7 → 1.8)。設計書 03-step1 §3.7〜§3.10:
  // 成功したら Step 2 へ。失敗したら黙って進まずにエラー画面 (tour-step-1-error) を出し、【もう一度】で 1.7 から再実行、【あとで】でホームへ。
  // 以前は失敗しても Step 2 へ進んでいて (#1057 の時点で計測だけ足した)、保存が 400 で落ち続けても利用者にも見えなかった (#1604)。
  // ただし「この利用者はお試しの保存の対象ではない」(sandbox_not_eligible) は、通信や保存の失敗ではなく、何度送っても変わらない答えなので、
  // エラー画面を出さずに Step 2 へ進める。設定からのやり直し (完了・スキップ済み → 409 already_finished。設計書 17-security §2.1) は
  // 保存できないまま Step 4 まで通して見せる決め (設計書 01-trigger-flow §1.2 / §4.2) で、ここで止めると行き止まりになる。
  const handleSandboxComplete = async () => {
    // 二重送信を防ぐ (吹き出しの【保存】と、下の画面の保存ボタンの両方から呼ばれうる)
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveError(false);
    setSubStep('1.7');
    setIsSaving(true);

    let failure: SaveFailure | null = null;
    try {
      const res = await fetch(TOUR_PHOTO_SAVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTourPhotoSaveBody()),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (!isSandboxNotEligibleBody(body)) {
          failure = {
            error_code: 'sandbox_save_failed',
            error_message: 'POST /api/meal-plans/add-from-photo failed',
            http_status: res.status,
          };
        }
      }
    } catch {
      failure = {
        error_code: 'sandbox_save_network_error',
        error_message: 'POST /api/meal-plans/add-from-photo threw',
      };
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }

    if (failure) {
      // 失敗は必ず記録する (#1057 UX1-09)。そのうえでエラー画面を出す (設計書 03-step1 §3.10)
      if (userId) {
        fireAnalytics('handson_tour_step_error', {
          user_id: userId,
          timestamp: new Date().toISOString(),
          platform: 'web' as const,
          app_version: '1.0.0',
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
    // 保存の対象でない利用者 (sandbox_not_eligible) も Step 1 を終えて先へ進むので記録する (設計書 22-analytics: 各ステップ進む)
    if (userId) {
      try {
        fireAnalytics('handson_tour_step_completed', {
          user_id: userId,
          timestamp: new Date().toISOString(),
          platform: 'web' as const,
          app_version: '1.0.0',
          step: 1,
          dwell_ms: Date.now() - mountTimeRef.current,
        });
      } catch {
        // analytics エラーは無視
      }
    }
    router.push(HANDSON_TOUR_ROUTES.step2);
  };

  const bubble = buildBubble(subStep, profile);

  const i18n = HANDSON_TOUR_I18N_JA.tour.step1;

  const autoAdvanceMs: number | undefined = (() => {
    if (subStep === '1.1') return HANDSON_TOUR_CONSTANTS.STEP1_INTRO_AUTO_MS;
    if (subStep === '1.2') return HANDSON_TOUR_CONSTANTS.STEP1_CAMERA_AUTO_MS;
    if (subStep === '1.3') return HANDSON_TOUR_CONSTANTS.STEP1_ANALYZING_DURATION_MS;
    if (subStep === '1.4') return HANDSON_TOUR_CONSTANTS.STEP1_RESULT_TO_SPOTLIGHT_MS;
    return undefined;
  })();

  const onAutoAdvance = (() => {
    if (subStep === '1.1') return () => advanceSubStep('1.2');
    if (subStep === '1.2') return () => advanceSubStep('1.3');
    if (subStep === '1.3') return () => advanceSubStep('1.4');
    if (subStep === '1.4') return () => advanceSubStep('1.5');
    return undefined;
  })();

  const primaryAction = (() => {
    if (subStep === '1.5') {
      return {
        label: i18n.next_button,
        onPress: () => advanceSubStep('1.6'),
      };
    }
    if (subStep === '1.6') {
      return {
        label: i18n.save_button,
        onPress: handleSandboxComplete,
        disabled: isSaving,
        showSpinner: isSaving,
      };
    }
    return undefined;
  })();

  // sandbox 用インライン UI — data-testid が TourOverlay の spotlight と連動する
  const MealNewSandboxInline = () => (
    <div
      className="w-full h-full min-h-screen flex flex-col"
      style={{ background: '#F7F6F3' }}
      data-testid="meal-new-screen"
    >
      {/* ヘッダー */}
      <div
        className="sticky top-0 z-10 px-4 py-3 flex items-center justify-between"
        style={{ background: '#FFFFFF', borderBottom: '1px solid #E8E8E8' }}
      >
        <div className="w-10" />
        <span style={{ fontSize: 16, fontWeight: 600, color: '#2D2D2D' }}>
          {subStep <= '1.2' ? '食事を撮影' : subStep <= '1.3' ? '解析中...' : '解析結果'}
        </span>
        <div className="w-10" />
      </div>

      <div className="flex-1 p-4 overflow-auto">
        {/* Step 1.2 以前: カメラボタン表示 */}
        {subStep <= '1.2' && (
          <div className="flex flex-col items-center justify-center py-12">
            <p style={{ fontSize: 13, color: '#A0A0A0', marginBottom: 24, textAlign: 'center' }}>
              食事の写真を撮影してください。AIが料理を認識して栄養を推定します。
            </p>
            <div className="flex gap-4 w-full">
              <button
                data-testid="meal-camera-button"
                className="flex-1 p-8 rounded-2xl flex flex-col items-center gap-3"
                style={{ background: '#FFFFFF', border: '2px dashed #E8E8E8' }}
                aria-label="食事を撮影"
              >
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center"
                  style={{ background: '#FDF0ED' }}
                >
                  <span style={{ fontSize: 32 }}>📸</span>
                </div>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#2D2D2D' }}>食事を撮影</span>
              </button>
              <button
                className="flex-1 p-8 rounded-2xl flex flex-col items-center gap-3"
                style={{ background: '#FFFFFF', border: '2px dashed #E8E8E8' }}
                aria-label="写真を選ぶ"
              >
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center"
                  style={{ background: '#EEF4FB' }}
                >
                  <span style={{ fontSize: 32 }}>🖼️</span>
                </div>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#2D2D2D' }}>写真を選ぶ</span>
              </button>
            </div>
          </div>
        )}

        {/* Step 1.3: 解析中スピナー */}
        {subStep === '1.3' && (
          <div
            className="flex flex-col items-center justify-center py-16"
            data-testid="meal-analyzing-view"
          >
            <div
              className="w-12 h-12 border-4 rounded-full animate-spin mb-4"
              style={{ borderColor: '#E07A5F', borderTopColor: 'transparent' }}
            />
            <p style={{ fontSize: 16, fontWeight: 600, color: '#2D2D2D' }}>AIが食事を解析中...</p>
            <p style={{ fontSize: 13, color: '#A0A0A0', marginTop: 8 }}>料理を認識して栄養素を推定しています</p>
          </div>
        )}

        {/* Step 1.4以降: 解析結果 */}
        {subStep >= '1.4' && (
          <div data-testid="meal-result-screen">
            {/* 料理写真プレビュー (サンプル) */}
            <div
              className="w-full h-40 rounded-2xl mb-4 flex items-center justify-center"
              style={{ background: '#E8E8E8' }}
            >
              <span style={{ fontSize: 48 }}>🍱</span>
            </div>

            {/* スコア */}
            <div className="flex items-center gap-4 mb-4 p-4 rounded-2xl" style={{ background: '#EDF5ED' }}>
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white"
                style={{ background: '#6B9B6B' }}
              >
                80
              </div>
              <div>
                <p style={{ fontSize: 16, fontWeight: 700, color: '#6B9B6B', margin: 0 }}>いいね！👍</p>
                <p style={{ fontSize: 13, color: '#6B6B6B', margin: 0 }}>{MOCK_PHOTO_RESPONSE.dishName}</p>
              </div>
            </div>

            {/* 栄養素 */}
            <div className="grid grid-cols-5 gap-2 mb-4">
              {[
                { label: 'カロリー', value: MOCK_PHOTO_RESPONSE.calories, unit: 'kcal', color: '#E07A5F' },
                { label: 'タンパク質', value: MOCK_PHOTO_RESPONSE.protein_g, unit: 'g', color: '#5B8BC7' },
                { label: '炭水化物', value: MOCK_PHOTO_RESPONSE.carbs_g, unit: 'g', color: '#E5A84B' },
                { label: '脂質', value: MOCK_PHOTO_RESPONSE.fat_g, unit: 'g', color: '#7C6BA0' },
                { label: '野菜', value: 60, unit: '点', color: '#6B9B6B' },
              ].map((n, i) => (
                <div key={i} className="p-2 rounded-xl text-center" style={{ background: '#F7F6F3' }}>
                  <p style={{ fontSize: 9, color: '#A0A0A0', margin: '0 0 2px 0' }}>{n.label}</p>
                  <p
                    style={{ fontSize: 14, fontWeight: 700, color: n.color, margin: 0 }}
                    data-testid={i === 0 ? 'meal-result-calories' : undefined}
                  >
                    {n.value}
                  </p>
                  <p style={{ fontSize: 9, color: '#A0A0A0', margin: 0 }}>{n.unit}</p>
                </div>
              ))}
            </div>

            {/* 料理名 */}
            <div className="mb-4">
              <p style={{ fontSize: 13, fontWeight: 600, color: '#6B6B6B', marginBottom: 8 }}>検出された料理</p>
              <div
                className="p-3 rounded-xl flex items-center gap-3"
                style={{ background: '#FFFFFF' }}
                data-testid="meal-result-dish-name"
              >
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center"
                  style={{ background: '#EDF5ED' }}
                >
                  <span style={{ fontSize: 18 }}>🍽️</span>
                </div>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 500, color: '#2D2D2D', margin: 0 }}>
                    {MOCK_PHOTO_RESPONSE.dishName}
                  </p>
                  <p style={{ fontSize: 11, color: '#A0A0A0', margin: 0 }}>
                    {MOCK_PHOTO_RESPONSE.calories} kcal
                  </p>
                </div>
              </div>
            </div>

            {/* AI コメント */}
            <div className="p-4 rounded-2xl mb-4" style={{ background: '#FDF0ED' }}>
              <div className="flex items-start gap-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: '#E07A5F' }}
                >
                  <span style={{ fontSize: 14, color: '#fff' }}>✨</span>
                </div>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 600, color: '#E07A5F', margin: '0 0 4px 0' }}>
                    記録コメント
                  </p>
                  <p style={{ fontSize: 13, color: '#2D2D2D', margin: 0, lineHeight: 1.6 }}>
                    {MOCK_PHOTO_RESPONSE.ai_comment}
                  </p>
                </div>
              </div>
            </div>

            {/* 保存ボタン */}
            <button
              data-testid="meal-save-button"
              onClick={handleSandboxComplete}
              disabled={isSaving}
              className="w-full py-4 rounded-xl flex items-center justify-center gap-2"
              style={{
                background: isSaving ? '#A0A0A0' : '#E07A5F',
                opacity: isSaving ? 0.8 : 1,
              }}
              aria-label="保存"
            >
              {isSaving ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>保存中...</span>
                </>
              ) : (
                <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>日時を選んで保存</span>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (saveError) {
    // 設計書 03-step1 §3.10: フルスクリーンのエラー画面。吹き出しのオーバーレイ (フォーカスを閉じ込める) は出さない
    const emphasizeSkip = saveErrorCount >= HANDSON_TOUR_CONSTANTS.ERROR_CONSECUTIVE_THRESHOLD;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/60" aria-hidden="true" />
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="tour-step-1-error-title"
          aria-describedby="tour-step-1-error-subtitle"
          data-testid="tour-step-1-error"
          className="relative bg-white rounded-2xl mx-4 w-full max-w-[400px] p-8 flex flex-col items-center gap-4 text-center shadow-2xl"
        >
          <p id="tour-step-1-error-title" className="text-xl font-bold text-gray-900">
            <span aria-hidden="true">⚠ </span>
            {i18n.error_title}
          </p>
          <p id="tour-step-1-error-subtitle" className="text-gray-600 text-sm">
            {i18n.error_subtitle}
          </p>
          <button
            data-testid="tour-step-1-error-retry"
            onClick={handleSandboxComplete}
            className="bg-blue-600 text-white px-8 py-3 rounded-xl font-semibold w-full"
          >
            {i18n.error_retry_button}
          </button>
          <button
            data-testid="tour-step-1-error-skip"
            onClick={handleSkip}
            className={`text-sm ${emphasizeSkip ? 'font-bold text-gray-900' : 'text-gray-500'}`}
            style={{ minHeight: 44, padding: '8px 16px' }}
          >
            {i18n.error_skip_button}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40">
      <TourSandboxWrapper
        subStep={subStep}
        subStepToTarget={STEP1_SUB_STEP_TO_TARGET}
        overlay={{
          bubble,
          progress: { current: 2, total: 5 },
          autoAdvanceMs,
          onAutoAdvance,
          primaryAction,
          showSkip: true,
          onSkip: handleSkip,
          accessibilityLabel: i18n.a11y_title,
        }}
        childProps={{
          initialStep: 'result' as const,
          prefilled: MOCK_PHOTO_RESPONSE,
          apiOptions: { source: 'handson_tour' as const, sandbox: true as const },
        }}
        onSandboxComplete={handleSandboxComplete}
      >
        <MealNewSandboxInline />
      </TourSandboxWrapper>
    </div>
  );
}
