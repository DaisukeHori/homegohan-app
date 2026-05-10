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
  type SubStepOfStep1,
} from '@homegohan/handson-tour-shared';
import { createClient } from '@/lib/supabase/client';

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

type UserProfile = {
  nickname: string | null;
  target_kcal_per_day: number | null;
};

function buildBubble(subStep: SubStepOfStep1, profile: UserProfile) {
  const i18n = HANDSON_TOUR_I18N_JA.tour.step1;
  const nickname = safeNickname(profile.nickname);

  switch (subStep) {
    case '1.1':
      return {
        body: i18n.intro_title,
        position: 'auto' as const,
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
      const targetKcal = profile.target_kcal_per_day;
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
  const [profile, setProfile] = useState<UserProfile>({ nickname: null, target_kcal_per_day: null });
  const [isSaving, setIsSaving] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const mountTimeRef = useRef(Date.now());

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);
      supabase
        .from('user_profiles')
        .select('nickname, target_kcal_per_day')
        .eq('id', user.id)
        .single()
        .then(({ data }) => {
          if (data) {
            setProfile({
              nickname: data.nickname ?? null,
              target_kcal_per_day: (data as unknown as Record<string, unknown>).target_kcal_per_day != null
                ? Number((data as unknown as Record<string, unknown>).target_kcal_per_day)
                : null,
            });
          }
        });
    });
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

  const handleSandboxComplete = async () => {
    setSubStep('1.7');
    setIsSaving(true);
    if (userId) {
      const now = new Date().toISOString();
      const dwell_ms = Date.now() - mountTimeRef.current;
      try {
        fireAnalytics('handson_tour_step_completed', {
          user_id: userId,
          timestamp: now,
          platform: 'web' as const,
          app_version: '1.0.0',
          step: 1,
          dwell_ms,
        });
      } catch {
        // analytics エラーは無視
      }
    }
    try {
      await fetch('/api/meal-plans/add-from-photo?source=handson_tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...MOCK_PHOTO_RESPONSE,
          sandbox: true,
          source: 'handson_tour',
        }),
      });
    } catch {
      // ネットワークエラーはスキップして次へ
    } finally {
      setIsSaving(false);
      router.push(HANDSON_TOUR_ROUTES.step2);
    }
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
          showSkip: false,
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
