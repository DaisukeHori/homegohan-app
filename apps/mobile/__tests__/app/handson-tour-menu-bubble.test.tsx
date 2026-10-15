/**
 * #1660: モバイルのハンズオンツアー Step 2 (app/handson-tour/menu.tsx) の 2.6 の吹き出しと analytics の app_version。
 *
 * 以前は 2.6 の吹き出しが result_bubble_no_exclude の {cooking_experience_text} を埋めずに出しており、
 * 利用者に「{cooking_experience_text} の手順」と見えていた。また analytics の app_version は '1.0.0' の直書きだった。
 * 設計書 docs/design/family/09-onboarding-handson-tour/04-step2-menu.md:
 *   - §3.7 2.6 の本文は除外する食材 (diet_flags の allergies → dislikes、最大 3 件) と料理の経験から組み立てる
 *   - §6 取れない・未回答なら除外なし・beginner 扱い (「初心者でも作れる の手順」)
 *
 * 画面を実際に描き、2.1 → 2.6 まで進めて、吹き出しに出る文を確かめる。
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { HANDSON_TOUR_CONSTANTS } from '@homegohan/handson-tour-shared';

const EXPO_VERSION = '3.2.1';
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '3.2.1' } } }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const USER_ID = '00000000-0000-4000-8000-000000000001';
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ profile: { id: '00000000-0000-4000-8000-000000000001', nickname: 'テスト' } }),
}));

type QueryResult = { data: unknown; error: unknown };
let mockQueryResult: QueryResult = { data: null, error: null };
const mockSelect = jest.fn();
const mockEq = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: (columns: string) => {
        mockSelect(columns);
        return {
          eq: (column: string, value: string) => {
            mockEq(column, value);
            return { maybeSingle: async () => mockQueryResult };
          },
        };
      },
    }),
  },
}));

const mockFireAnalytics = jest.fn();
jest.mock('@homegohan/handson-tour-shared', () => ({
  ...jest.requireActual('@homegohan/handson-tour-shared'),
  fireAnalytics: (...args: unknown[]) => mockFireAnalytics(...args),
}));

// 献立の生成モーダルは中身を描かない (吹き出しの文だけを見る)
jest.mock('../../src/components/menu/V4GenerateModal', () => ({
  V4GenerateModal: () => null,
}));

// 吹き出しのオーバーレイは位置の計測やアニメーションを持つので、タイトル・本文・進行ボタンだけを描く形に差し替える
jest.mock('../../src/handson-tour/TourOverlay', () => {
  const ReactActual = jest.requireActual('react');
  const { Pressable, Text, View } = jest.requireActual('react-native');
  function MockTourOverlay(props: {
    bubble: { title?: string; body: string };
    primaryAction?: { label: string; onPress: () => void };
  }) {
    return ReactActual.createElement(
      View,
      null,
      ReactActual.createElement(Text, { testID: 'bubble-title' }, props.bubble.title ?? ''),
      ReactActual.createElement(Text, { testID: 'bubble-body' }, props.bubble.body),
      props.primaryAction
        ? ReactActual.createElement(
            Pressable,
            { testID: 'overlay-primary', onPress: props.primaryAction.onPress },
            ReactActual.createElement(Text, null, props.primaryAction.label),
          )
        : null,
    );
  }
  return { TourOverlay: MockTourOverlay };
});

import HandsonTourMenu from '../../app/handson-tour/menu';

/** 2.1 (自動) → 2.2 → 2.3 → 2.4 (各【次へ】/【生成する】) → 2.5 (自動) → 2.6 */
async function advanceToResultBubble(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP2_INTRO_AUTO_MS);
  });
  for (let i = 0; i < 3; i += 1) {
    fireEvent.press(screen.getByTestId('overlay-primary'));
  }
  await act(async () => {
    jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS);
  });
}

function bubbleText(): string {
  const title = screen.getByTestId('bubble-title').props.children as string;
  const body = screen.getByTestId('bubble-body').props.children as string;
  return `${title}\n${body}`;
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  mockFireAnalytics.mockReset();
  mockSelect.mockReset();
  mockEq.mockReset();
  mockQueryResult = { data: null, error: null };
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  jest.useRealTimers();
});

describe('Step 2 の 2.6 の吹き出し (#1660)', () => {
  it('プロフィールの除外する食材と料理の経験で本文を埋める ({ } が残らない)', async () => {
    mockQueryResult = {
      data: { diet_flags: { allergies: ['卵'], dislikes: ['セロリ'] }, cooking_experience: 'advanced' },
      error: null,
    };
    render(<HandsonTourMenu />);
    await act(async () => {});
    expect(mockSelect).toHaveBeenCalledWith('diet_flags,cooking_experience');
    expect(mockEq).toHaveBeenCalledWith('id', USER_ID);

    await advanceToResultBubble();

    expect(screen.getByTestId('bubble-body').props.children).toBe('卵・セロリ は除外、シェフの腕前を活かせる の手順');
    expect(screen.getByTestId('bubble-title').props.children).toBe('テスト さんに合わせた献立');
    expect(bubbleText()).not.toMatch(/[{}]/);
  });

  it('プロフィールが空 (未回答) なら「初心者でも作れる の手順」', async () => {
    mockQueryResult = { data: { diet_flags: null, cooking_experience: null }, error: null };
    render(<HandsonTourMenu />);
    await act(async () => {});
    await advanceToResultBubble();

    expect(screen.getByTestId('bubble-body').props.children).toBe('初心者でも作れる の手順');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('取得に失敗しても止めずに既定の文で進み、失敗を記録する (コードだけ)', async () => {
    mockQueryResult = { data: null, error: { code: '42703', message: 'column does not exist' } };
    render(<HandsonTourMenu />);
    await act(async () => {});
    await advanceToResultBubble();

    expect(screen.getByTestId('bubble-body').props.children).toBe('初心者でも作れる の手順');
    expect(warnSpy).toHaveBeenCalledWith('[handson-tour] step 2 profile fetch: user_profiles select failed (42703)');
    expect(mockFireAnalytics).toHaveBeenCalledWith(
      'handson_tour_step_error',
      expect.objectContaining({
        user_id: USER_ID,
        step: 2,
        error_code: 'profile_fetch_failed',
        error_message: 'user_profiles select failed (42703)',
        app_version: EXPO_VERSION,
      }),
    );
  });
});

describe('Step 2 の analytics の app_version (#1660)', () => {
  it('step_viewed / step_completed の app_version は Expo の設定の版 (直書きの 1.0.0 ではない)', async () => {
    render(<HandsonTourMenu />);
    await act(async () => {});
    await advanceToResultBubble();
    // 2.6 → 2.7 → 【献立に追加】(sandbox の完了) で step_completed
    fireEvent.press(screen.getByTestId('overlay-primary'));
    fireEvent.press(screen.getByTestId('overlay-primary'));

    const events = mockFireAnalytics.mock.calls.map(([name, payload]) => [name, (payload as { app_version: string }).app_version]);
    expect(events).toEqual(
      expect.arrayContaining([
        ['handson_tour_step_viewed', EXPO_VERSION],
        ['handson_tour_step_completed', EXPO_VERSION],
      ]),
    );
    for (const [, appVersion] of events) expect(appVersion).toBe(EXPO_VERSION);
  });
});
