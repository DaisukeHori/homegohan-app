'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TourSandboxWrapper } from '@/components/handson-tour/TourSandboxWrapper';
import {
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  HANDSON_TOUR_CONSTANTS,
  MOCK_MENU_RESPONSE,
  STEP2_SUB_STEP_TO_TARGET,
  personalize,
  type SubStepOfStep2,
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
  allergies: string[] | null;
  dislikes: string[] | null;
  cooking_experience: string | null;
};

const COOKING_EXP_TEXT: Record<string, string> = {
  beginner: '初心者でも作れる',
  intermediate: 'いつもの手順で作れる',
  advanced: 'シェフの腕前を活かせる',
};

function buildBubble(subStep: SubStepOfStep2, profile: UserProfile) {
  const i18n = HANDSON_TOUR_I18N_JA.tour.step2;
  const nickname = safeNickname(profile.nickname);

  switch (subStep) {
    case '2.1':
      return { body: i18n.intro_title, position: 'auto' as const };
    case '2.2':
      return { body: i18n.flags_bubble, position: 'auto' as const };
    case '2.3':
      return { body: i18n.note_bubble, position: 'auto' as const };
    case '2.4':
      return { body: i18n.generate_bubble, position: 'auto' as const };
    case '2.5':
      return { body: i18n.generate_bubble, position: 'auto' as const };
    case '2.6': {
      const allergies = profile.allergies ?? [];
      const dislikes = profile.dislikes ?? [];
      const excludeList = [...allergies, ...dislikes].slice(0, 3);
      const cookingExp = profile.cooking_experience ?? 'beginner';
      const cookingExpText = COOKING_EXP_TEXT[cookingExp] ?? '初心者でも作れる';

      if (excludeList.length > 0) {
        return {
          title: personalize(i18n.result_title, { nickname }),
          body: personalize(i18n.result_bubble_full, {
            exclude_list: excludeList.join('・'),
            cooking_experience_text: cookingExpText,
          }),
          position: 'bottom' as const,
        };
      }
      return {
        title: personalize(i18n.result_title, { nickname }),
        body: personalize(i18n.result_bubble_no_exclude, {
          cooking_experience_text: cookingExpText,
        }),
        position: 'bottom' as const,
      };
    }
    case '2.7':
      return { body: i18n.add_bubble, position: 'auto' as const };
    case '2.8':
    case '2.9':
      return { body: '', position: 'auto' as const };
    default:
      return { body: '', position: 'auto' as const };
  }
}

export default function HandsonTourMenuPage() {
  const router = useRouter();
  const [subStep, setSubStep] = useState<SubStepOfStep2>('2.1');
  const [profile, setProfile] = useState<UserProfile>({
    nickname: null,
    allergies: null,
    dislikes: null,
    cooking_experience: null,
  });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase
        .from('user_profiles')
        .select('nickname, allergies, dislikes, cooking_experience')
        .eq('user_id', user.id)
        .single()
        .then(({ data }) => {
          if (data) {
            const d = data as unknown as Record<string, unknown>;
            setProfile({
              nickname: (d.nickname as string | null) ?? null,
              allergies: Array.isArray(d.allergies) ? (d.allergies as string[]) : null,
              dislikes: Array.isArray(d.dislikes) ? (d.dislikes as string[]) : null,
              cooking_experience: (d.cooking_experience as string | null) ?? null,
            });
          }
        });
    });
  }, []);

  const advanceSubStep = (next: SubStepOfStep2) => setSubStep(next);

  const handleSandboxComplete = async () => {
    setSubStep('2.8');
    setIsSaving(true);
    try {
      await fetch('/api/menu-plans/add?source=handson_tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...MOCK_MENU_RESPONSE,
          sandbox: true,
          source: 'handson_tour',
        }),
      });
    } catch {
      // ネットワークエラーはスキップして次へ
    } finally {
      setIsSaving(false);
      router.push(HANDSON_TOUR_ROUTES.step3);
    }
  };

  const bubble = buildBubble(subStep, profile);
  const i18n = HANDSON_TOUR_I18N_JA.tour.step2;

  const autoAdvanceMs: number | undefined = (() => {
    if (subStep === '2.1') return HANDSON_TOUR_CONSTANTS.STEP2_INTRO_AUTO_MS;
    if (subStep === '2.5') return HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS;
    return undefined;
  })();

  const onAutoAdvance = (() => {
    if (subStep === '2.1') return () => advanceSubStep('2.2');
    if (subStep === '2.5') return () => advanceSubStep('2.6');
    return undefined;
  })();

  const primaryAction = (() => {
    if (subStep === '2.2') {
      return { label: i18n.next_button, onPress: () => advanceSubStep('2.3') };
    }
    if (subStep === '2.3') {
      return { label: i18n.next_button, onPress: () => advanceSubStep('2.4') };
    }
    if (subStep === '2.4') {
      return { label: i18n.generate_button, onPress: () => advanceSubStep('2.5') };
    }
    if (subStep === '2.6') {
      return { label: i18n.next_button, onPress: () => advanceSubStep('2.7') };
    }
    if (subStep === '2.7') {
      return {
        label: i18n.add_button,
        onPress: handleSandboxComplete,
        disabled: isSaving,
        showSpinner: isSaving,
      };
    }
    return undefined;
  })();

  // sandbox 用インライン UI — data-testid が TourOverlay の spotlight と連動する
  const MenuSandboxInline = () => (
    <div
      className="w-full min-h-screen flex flex-col"
      style={{ background: '#F7F6F3' }}
      data-testid="v4-generate-modal"
    >
      {/* ヘッダー */}
      <div
        className="sticky top-0 z-10 px-4 py-3 flex items-center gap-2"
        style={{ background: '#FFFFFF', borderBottom: '1px solid #E8E8E8' }}
      >
        <span style={{ fontSize: 18, color: '#E07A5F' }}>✨</span>
        <span style={{ fontSize: 16, fontWeight: 700, color: '#2D2D2D' }}>AIアシスタント（体験）</span>
      </div>

      <div className="flex-1 p-4 overflow-auto">
        {/* 体験モードバナー */}
        <div className="mb-4 p-3 rounded-xl" style={{ background: '#FDF0ED' }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#E07A5F', margin: '0 0 4px 0' }}>
            ハンズオン体験モード
          </p>
          <p style={{ fontSize: 12, color: '#6B6B6B', margin: 0 }}>
            サンプル献立でAIアシスタントを体験できます
          </p>
        </div>

        {/* 入力フォーム (2.1〜2.4) */}
        {subStep <= '2.4' && (
          <>
            {/* 条件フラグ */}
            <div className="mb-4">
              <p style={{ fontSize: 13, fontWeight: 600, color: '#6B6B6B', marginBottom: 8 }}>生成条件</p>
              <div className="flex flex-wrap gap-2">
                <button
                  data-testid="v4-no-cook-toggle"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border"
                  style={{
                    borderColor: '#E07A5F',
                    background: '#FDF0ED',
                    cursor: 'default',
                  }}
                  aria-pressed="true"
                >
                  <span
                    className="w-5 h-5 rounded flex items-center justify-center"
                    style={{ background: '#E07A5F' }}
                  >
                    <span style={{ color: '#fff', fontSize: 12 }}>✓</span>
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#E07A5F' }}>
                    調理しなくていい
                  </span>
                </button>
              </div>
            </div>

            {/* 自由メモ */}
            <div className="mb-4">
              <p style={{ fontSize: 13, fontWeight: 600, color: '#6B6B6B', marginBottom: 8 }}>
                自由メモ（任意）
              </p>
              <textarea
                data-testid="v4-note-textarea"
                className="w-full p-3 rounded-xl text-sm resize-none"
                style={{
                  border: '1px solid #E8E8E8',
                  background: '#FFFFFF',
                  color: '#2D2D2D',
                  outline: 'none',
                  fontSize: 13,
                }}
                placeholder="例: 野菜多め、辛くない、15分以内で作れる..."
                rows={3}
                readOnly
              />
            </div>

            {/* 生成ボタン */}
            <button
              data-testid="v4-generate-button"
              className="w-full py-4 rounded-xl flex items-center justify-center gap-2"
              style={{ background: '#E07A5F' }}
              aria-label="AI で献立を生成"
            >
              <span style={{ fontSize: 16, color: '#fff' }}>✨</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>AI で献立を生成</span>
            </button>
          </>
        )}

        {/* ローディング (2.5) */}
        {subStep === '2.5' && (
          <div
            className="flex flex-col items-center justify-center py-16"
            data-testid="v4-loading-spinner"
          >
            <div
              className="w-12 h-12 border-4 rounded-full animate-spin mb-4"
              style={{ borderColor: '#E07A5F', borderTopColor: 'transparent' }}
            />
            <p style={{ fontSize: 16, fontWeight: 600, color: '#2D2D2D' }}>AI が考え中...</p>
            <p style={{ fontSize: 13, color: '#A0A0A0', marginTop: 8 }}>最適な献立を生成しています</p>
          </div>
        )}

        {/* 生成結果 (2.6〜2.7) */}
        {(subStep === '2.6' || subStep === '2.7') && (
          <div
            data-testid="v4-result-card"
            className="p-4 rounded-2xl"
            style={{ background: '#FFFFFF', border: '1px solid #E8E8E8' }}
          >
            <p style={{ fontSize: 12, fontWeight: 700, color: '#A0A0A0', marginBottom: 8 }}>
              生成された献立（サンプル）
            </p>
            <p
              style={{ fontSize: 18, fontWeight: 700, color: '#2D2D2D', marginBottom: 4 }}
              data-testid="v4-result-dish-name"
            >
              {MOCK_MENU_RESPONSE.dish_name}
            </p>
            <div className="flex gap-3 text-sm" style={{ color: '#6B6B6B', marginBottom: 8 }}>
              <span data-testid="v4-result-calories">{MOCK_MENU_RESPONSE.calories} kcal</span>
              <span>P: {MOCK_MENU_RESPONSE.protein_g}g</span>
              <span>F: {MOCK_MENU_RESPONSE.fat_g}g</span>
              <span>C: {MOCK_MENU_RESPONSE.carbs_g}g</span>
            </div>
            <div className="flex gap-2 flex-wrap mb-4">
              <span
                className="text-xs px-2 py-1 rounded-full"
                style={{ background: '#FDF0ED', color: '#E07A5F' }}
              >
                {MOCK_MENU_RESPONSE.cooking_time_minutes}分
              </span>
              <span
                className="text-xs px-2 py-1 rounded-full"
                style={{ background: '#EDF5ED', color: '#6B9B6B' }}
              >
                {MOCK_MENU_RESPONSE.difficulty === 'easy' ? '簡単' : MOCK_MENU_RESPONSE.difficulty === 'medium' ? '普通' : '本格'}
              </span>
              <span
                className="text-xs px-2 py-1 rounded-full"
                style={{ background: '#EEF4FB', color: '#5B8BC7' }}
              >
                {MOCK_MENU_RESPONSE.servings}人分
              </span>
            </div>

            {/* 材料一覧 */}
            <p style={{ fontSize: 12, fontWeight: 700, color: '#A0A0A0', marginBottom: 6 }}>材料</p>
            <div className="grid grid-cols-2 gap-1 mb-4">
              {MOCK_MENU_RESPONSE.ingredients.slice(0, 4).map((ing, i) => (
                <div key={i} style={{ fontSize: 12, color: '#2D2D2D' }}>
                  {ing.name} {ing.quantity_g}{ing.unit}
                </div>
              ))}
            </div>

            {/* 献立に追加ボタン */}
            {subStep === '2.7' && (
              <button
                data-testid="v4-add-to-menu-button"
                onClick={handleSandboxComplete}
                disabled={isSaving}
                className="w-full py-4 rounded-xl flex items-center justify-center gap-2"
                style={{
                  background: isSaving ? '#A0A0A0' : '#E07A5F',
                  opacity: isSaving ? 0.8 : 1,
                }}
                aria-label="献立に追加"
              >
                {isSaving ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>追加中...</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>献立に追加</span>
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40">
      {/* Step 2 intro マーカー: subStep 2.1 の間 DOM に存在 (E2E testID) */}
      {subStep === '2.1' && (
        <span
          data-testid="tour-step-2-intro"
          aria-hidden="true"
          style={{ display: 'none' }}
        />
      )}
      <TourSandboxWrapper
        subStep={subStep}
        subStepToTarget={STEP2_SUB_STEP_TO_TARGET}
        overlay={{
          bubble,
          progress: { current: 3, total: 5 },
          autoAdvanceMs,
          onAutoAdvance,
          primaryAction,
          showSkip: false,
          accessibilityLabel: HANDSON_TOUR_I18N_JA.tour.step2.intro_title,
        }}
        childProps={{
          initialFlags: { no_cook: true },
          prefilled: MOCK_MENU_RESPONSE,
          loadingDurationMs: HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS,
          apiOptions: { source: 'handson_tour' as const, sandbox: true as const },
        }}
        onSandboxComplete={handleSandboxComplete}
      >
        <MenuSandboxInline />
      </TourSandboxWrapper>
    </div>
  );
}
