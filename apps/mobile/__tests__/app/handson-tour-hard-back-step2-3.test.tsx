/**
 * #1642: モバイルのハンズオンツアー Step 2 (app/handson-tour/menu.tsx) と Step 3 (app/handson-tour/badges.tsx) の端末のバック (Android)。
 *
 * 以前は、Step 2・3 の端末のバックが router.replace('/home') をするだけで、skip の API (handson_tour_skipped_at を付ける) も
 * handson_tour_skipped{reason:'hard_back'} も送っていなかった。Step 1 は #1625 で設計どおりになっていた
 * (handson-tour-photo-save.test.tsx の「端末バック (Android) は hard_back でツアーを抜ける」)。
 * analytics の platform も、Android の端末でも 'ios' を直接書いていた。
 * 設計書 docs/design/family/09-onboarding-handson-tour/:
 *   - 01-trigger-flow §2.2: Step 1〜3 の端末バックは handson_tour_skipped{reason:'hard_back'} + skipped_at + /home
 *   - 22-analytics §2.2: 共通 properties の platform は 'web' | 'ios' | 'android'
 *
 * 通信は、モバイルが実際に使う @homegohan/core の createHttpClient (fetch だけ差し替え) で流す (Step 1 のテストと同じ)。
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { BackHandler, Modal, Platform } from 'react-native';
import { createHttpClient, type HttpClient } from '@homegohan/core';
import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  buildStep2ResultBubbleBody,
  personalize,
} from '@homegohan/handson-tour-shared';

import { tourAnalyticsPlatformOf } from '../../src/handson-tour/tour-platform';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: (...args: unknown[]) => mockPush(...args),
    replace: (...args: unknown[]) => mockReplace(...args),
  }),
}));

jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ profile: { id: 'user-1', nickname: 'テスト' } }),
}));

// analytics の app_version は Expo の設定 (app.json の expo.version) から取る (#1660)。直書きの '1.0.0' と見分けられる版にする
const EXPO_APP_VERSION = '3.2.1';
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '3.2.1' } } }));

// Step 2 の 2.6 の吹き出しに使うプロフィール (menu-tour-profile.ts の fetchMenuTourProfile。#1660)。
// このテストは端末バックだけを見るので、行が無い (除外なし・料理の経験なし = beginner 扱い) で返し、外へ問い合わせない
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  },
}));

let mockClient: HttpClient;
jest.mock('../../src/lib/api', () => ({
  getApi: () => mockClient,
}));

const mockFireAnalytics = jest.fn();
jest.mock('@homegohan/handson-tour-shared', () => ({
  ...jest.requireActual('@homegohan/handson-tour-shared'),
  fireAnalytics: (...args: unknown[]) => mockFireAnalytics(...args),
}));

// Step 2 の献立の生成のモーダル (V4GenerateModal) は、このテストでは中身を見ない (吹き出しの進行と端末バックだけを見る)
jest.mock('../../src/components/menu/V4GenerateModal', () => ({
  V4GenerateModal: () => null,
}));

// 吹き出しのオーバーレイ (TourOverlay) は位置の計測やアニメーションを持つので、吹き出しの本文・進行ボタン (primaryAction)・端末バックだけを持つ形に差し替える。
// 端末バックは本物の TourOverlay.tsx と同じく、hardwareBackPress で onSkip を呼んで true を返す
jest.mock('../../src/handson-tour/TourOverlay', () => {
  const ReactActual = jest.requireActual('react');
  const { BackHandler: BackHandlerActual, Pressable, Text, View } = jest.requireActual('react-native');
  function MockTourOverlay(props: {
    bubble: { title?: string; body: string };
    primaryAction?: { label: string; onPress: () => void; disabled?: boolean };
    onSkip?: () => void;
  }) {
    const { onSkip } = props;
    ReactActual.useEffect(() => {
      const sub = BackHandlerActual.addEventListener('hardwareBackPress', () => {
        if (onSkip) {
          onSkip();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [onSkip]);
    return ReactActual.createElement(
      View,
      { testID: 'mock-tour-overlay' },
      props.bubble.title ? ReactActual.createElement(Text, { testID: 'overlay-title' }, props.bubble.title) : null,
      ReactActual.createElement(Text, { testID: 'overlay-body' }, props.bubble.body),
      props.primaryAction
        ? ReactActual.createElement(
            Pressable,
            {
              testID: 'overlay-primary',
              onPress: props.primaryAction.onPress,
              disabled: props.primaryAction.disabled,
            },
            ReactActual.createElement(Text, null, props.primaryAction.label),
          )
        : null,
    );
  }
  return { TourOverlay: MockTourOverlay };
});

import HandsonTourMenu from '../../app/handson-tour/menu';
import HandsonTourBadges from '../../app/handson-tour/badges';

const i18n = HANDSON_TOUR_I18N_JA.tour;
const API_BASE_URL = 'https://api.example.com';
const HTTP_OK = 200;
const HTTP_INTERNAL_ERROR = 500;
/** menu.tsx の 2.8 (追加の吹き出し) から 2.9 (Step 3 へ遷移) までの待ち */
const STEP2_ADD_TO_NEXT_STEP_MS = 500;

type FakeResponse = { ok: boolean; status: number; statusText: string; text: () => Promise<string> };

function jsonResponse(status: number, statusText: string, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, statusText, text: async () => JSON.stringify(body) };
}

const SKIP_OK = jsonResponse(HTTP_OK, 'OK', { skipped_at: '2026-10-15T00:00:00.000Z' });
const BADGES_OK = jsonResponse(HTTP_OK, 'OK', { badges: [] });
const BADGES_FAILED = jsonResponse(HTTP_INTERNAL_ERROR, 'Internal Server Error', { error: 'failed' });

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

function skipCalls(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/handson-tour/skip'));
}

function analyticsCalls(eventName: string): unknown[] {
  return mockFireAnalytics.mock.calls.filter(([name]) => name === eventName).map(([, payload]) => payload);
}

type HardwareBackListener = Parameters<typeof BackHandler.addEventListener>[1];
/** 端末バックの event (react-native 0.88 の HardwareBackPressEvent。受け手は値を見ない) */
const HARDWARE_BACK_EVENT: Parameters<HardwareBackListener>[0] = { type: 'hardwareBackPress', timeStamp: 0 };
/** BackHandler.addEventListener で登録された端末バックの受け手 (登録順)。jest の preset は iOS なので本物の BackHandler は何も持たない */
let hardwareBackListeners: HardwareBackListener[] = [];
let addBackListenerSpy: jest.SpyInstance | null = null;
let platformOsReplaced: jest.ReplaceProperty<typeof Platform.OS> | null = null;

/** Android の端末バックを 1 回押す。本物と同じく、後に登録したものから順に呼び、true を返したところで止める。止まらなければ false (= 既定の戻る) */
function pressHardwareBack(): boolean {
  for (const listener of [...hardwareBackListeners].reverse()) {
    if (listener(HARDWARE_BACK_EVENT)) return true;
  }
  return false;
}

/** 端末を Android にする (Platform.OS)。afterEach で戻す */
function runOnAndroid(): void {
  platformOsReplaced = jest.replaceProperty(Platform, 'OS', 'android');
}

beforeEach(() => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockFireAnalytics.mockReset();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockClient = createHttpClient({ baseUrl: API_BASE_URL, retry: false });
  hardwareBackListeners = [];
  addBackListenerSpy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((eventName, listener) => {
    if (eventName === 'hardwareBackPress') hardwareBackListeners.push(listener);
    return {
      remove: () => {
        hardwareBackListeners = hardwareBackListeners.filter((registered) => registered !== listener);
      },
    };
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
  addBackListenerSpy?.mockRestore();
  addBackListenerSpy = null;
  platformOsReplaced?.restore();
  platformOsReplaced = null;
});

describe('#1642: tourAnalyticsPlatformOf (端末の Platform.OS を analytics の platform に読み替える)', () => {
  it("android は 'android'・ios は 'ios'・web は 'web'", () => {
    expect(tourAnalyticsPlatformOf('android')).toBe('android');
    expect(tourAnalyticsPlatformOf('ios')).toBe('ios');
    expect(tourAnalyticsPlatformOf('web')).toBe('web');
  });
});

describe('#1642: Step 2 (献立) の端末バックは hard_back でツアーを抜ける (設計書 01-trigger-flow §2.2)', () => {
  /** 2.1 の自動進行を待ってから、吹き出しの【次へ】【生成する】で 2.5 (読み込み中) まで進める */
  function advanceToLoading(screen: ReturnType<typeof render>): void {
    act(() => {
      jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP2_INTRO_AUTO_MS);
    });
    expect(screen.getByTestId('overlay-body')).toHaveTextContent(i18n.step2.flags_bubble);
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.2 → 2.3
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.3 → 2.4
    expect(screen.getByTestId('overlay-primary')).toHaveTextContent(i18n.step2.generate_button);
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.4 → 2.5
  }

  it('吹き出しの画面での端末バックは、skip API と handson_tour_skipped を step 2・reason hard_back で送り、ホームへ', async () => {
    fetchMock.mockResolvedValue(SKIP_OK);
    render(<HandsonTourMenu />);

    let handled = false;
    await act(async () => {
      handled = pressHardwareBack();
    });

    expect(handled).toBe(true);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    const [url, init] = skipCalls()[0];
    expect(url).toBe(`${API_BASE_URL}/api/handson-tour/skip`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ step: 2, reason: 'hard_back' });
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({
        step: 2,
        reason: 'hard_back',
        user_id: 'user-1',
        platform: 'ios',
        app_version: EXPO_APP_VERSION,
      }),
    ]);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('吹き出しを包むモーダルの onRequestClose (Android でモーダルを出している間の端末バック) も、同じく hard_back で skip してホームへ', async () => {
    fetchMock.mockResolvedValue(SKIP_OK);
    const screen = render(<HandsonTourMenu />);

    const modals = screen.UNSAFE_getAllByType(Modal);
    expect(modals).toHaveLength(1);
    await act(async () => {
      modals[0].props.onRequestClose();
    });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 2, reason: 'hard_back' });
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({ step: 2, reason: 'hard_back' }),
    ]);
  });

  it('モーダルの onRequestClose と オーバーレイの端末バックが続けて来ても、skip は 1 回だけ', async () => {
    fetchMock.mockResolvedValue(SKIP_OK);
    const screen = render(<HandsonTourMenu />);

    await act(async () => {
      screen.UNSAFE_getAllByType(Modal)[0].props.onRequestClose();
      pressHardwareBack();
      pressHardwareBack();
    });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    expect(analyticsCalls('handson_tour_skipped')).toHaveLength(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('【献立に追加】のあと (2.8 → 2.9 の待ちの間) に抜けたら、待ちが明けても Step 3 へ進まない', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(SKIP_OK);
    const screen = render(<HandsonTourMenu />);

    advanceToLoading(screen);
    act(() => {
      jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS);
    });
    // 2.6 の吹き出しは {cooking_experience_text} を埋めた文 (除外なし・beginner 扱い。#1660)
    const resultBubble = buildStep2ResultBubbleBody({ allergies: [], dislikes: [], cooking_experience: null });
    expect(resultBubble).not.toContain('{');
    expect(screen.getByTestId('overlay-body')).toHaveTextContent(resultBubble);
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.6 → 2.7
    expect(screen.getByTestId('overlay-primary')).toHaveTextContent(i18n.step2.add_button);
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.7 → 2.8 (Step 2 の完了)
    expect(analyticsCalls('handson_tour_step_completed')).toEqual([expect.objectContaining({ step: 2 })]);

    await act(async () => {
      pressHardwareBack();
    });
    await act(async () => {
      jest.advanceTimersByTime(STEP2_ADD_TO_NEXT_STEP_MS);
    });

    expect(mockReplace).toHaveBeenCalledWith('/home');
    expect(mockPush).not.toHaveBeenCalled();
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 2, reason: 'hard_back' });
  });

  it('読み込み中 (2.5) に抜けたら、読み込みの待ちが明けても結果 (2.6) へ進まない', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(SKIP_OK);
    const screen = render(<HandsonTourMenu />);

    advanceToLoading(screen);
    expect(screen.getByTestId('overlay-body')).toHaveTextContent(i18n.step2.generate_bubble);
    await act(async () => {
      pressHardwareBack();
    });
    act(() => {
      jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS);
    });

    expect(screen.getByTestId('overlay-body')).toHaveTextContent(i18n.step2.generate_bubble);
    expect(screen.queryByTestId('overlay-primary')).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith('/home');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('端末を抜けずに最後まで進めたときは、これまでどおり Step 3 へ (skip は送らない)', async () => {
    jest.useFakeTimers();
    const screen = render(<HandsonTourMenu />);

    advanceToLoading(screen);
    act(() => {
      jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS);
    });
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.6 → 2.7
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.7 → 2.8
    act(() => {
      jest.advanceTimersByTime(STEP2_ADD_TO_NEXT_STEP_MS);
    });

    expect(mockPush).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step3);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(skipCalls()).toHaveLength(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("Android の端末では、analytics の platform を 'android' で送る (step_viewed・step_completed・skipped)", async () => {
    runOnAndroid();
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(SKIP_OK);
    const screen = render(<HandsonTourMenu />);

    advanceToLoading(screen);
    act(() => {
      jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS);
    });
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.6 → 2.7
    fireEvent.press(screen.getByTestId('overlay-primary')); // 2.7 → 2.8
    await act(async () => {
      pressHardwareBack();
    });

    expect(analyticsCalls('handson_tour_step_viewed')).toEqual([
      expect.objectContaining({ step: 2, platform: 'android' }),
    ]);
    expect(analyticsCalls('handson_tour_step_completed')).toEqual([
      expect.objectContaining({ step: 2, platform: 'android' }),
    ]);
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({ step: 2, reason: 'hard_back', platform: 'android' }),
    ]);
  });
});

describe('#1642: Step 3 (バッジ) の端末バックは hard_back でツアーを抜ける (設計書 01-trigger-flow §2.2)', () => {
  /**
   * バッジの取得 (GET /api/badges) と skip を分けて応答する。バッジの応答は resolveBadges で返す
   * (クライアントは認証のヘッダーを作ってから fetch を呼ぶので、fetch が呼ばれるのを待ってから返す)
   */
  function holdBadges(): { resolveBadges: (response: FakeResponse) => Promise<void> } {
    let pendingBadges: ((response: FakeResponse) => void) | null = null;
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/api/handson-tour/skip')
        ? Promise.resolve(SKIP_OK)
        : new Promise<FakeResponse>((resolve) => {
            pendingBadges = resolve;
          }),
    );
    return {
      resolveBadges: async (response) => {
        await waitFor(() => expect(pendingBadges).not.toBeNull());
        await act(async () => {
          pendingBadges?.(response);
        });
      },
    };
  }

  it('吹き出しの画面での端末バックは、skip API と handson_tour_skipped を step 3・reason hard_back で送り、ホームへ', async () => {
    const { resolveBadges } = holdBadges();
    const screen = render(<HandsonTourBadges />);
    await resolveBadges(BADGES_OK);
    expect(await screen.findByTestId('tour-step-3')).toBeTruthy();
    // 吹き出しを出したら、受け手はオーバーレイの 1 つだけ (読み込み中の受け手は外れる)
    expect(hardwareBackListeners).toHaveLength(1);

    let handled = false;
    await act(async () => {
      handled = pressHardwareBack();
    });

    expect(handled).toBe(true);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 3, reason: 'hard_back' });
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({
        step: 3,
        reason: 'hard_back',
        user_id: 'user-1',
        platform: 'ios',
        app_version: EXPO_APP_VERSION,
      }),
    ]);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('読み込み中の端末バックも、既定の戻る (Step 2) にせず hard_back で skip してホームへ。抜けたあとにバッジの応答が届いても吹き出しを出さない', async () => {
    const { resolveBadges } = holdBadges();
    const screen = render(<HandsonTourBadges />);
    expect(screen.getByTestId('tour-step-3-loading')).toBeTruthy();
    expect(hardwareBackListeners).toHaveLength(1);

    let handled = false;
    await act(async () => {
      handled = pressHardwareBack();
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));

    await resolveBadges(BADGES_OK);

    expect(screen.queryByTestId('tour-step-3')).toBeNull();
    expect(screen.getByTestId('tour-step-3-loading')).toBeTruthy();
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 3, reason: 'hard_back' });
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({ step: 3, reason: 'hard_back' }),
    ]);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('バッジの取得に失敗した画面の端末バックも、hard_back で skip してホームへ', async () => {
    const { resolveBadges } = holdBadges();
    const screen = render(<HandsonTourBadges />);
    await resolveBadges(BADGES_FAILED);
    expect(await screen.findByText(i18n.step3.error_title)).toBeTruthy();
    expect(hardwareBackListeners).toHaveLength(1);

    let handled = false;
    await act(async () => {
      handled = pressHardwareBack();
    });

    expect(handled).toBe(true);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 3, reason: 'hard_back' });
  });

  // #1626: 文言は Web と共有 (packages/handson-tour-shared)。お試しの記録は first_bite に数えないので、Step 3 の時点で付いているのは planner の 1 つ
  it('Step 3 の intro は「もう 1 つ獲得しています」をニックネームで埋めて出し、本文に {nickname} の波括弧を残さない', async () => {
    const { resolveBadges } = holdBadges();
    const screen = render(<HandsonTourBadges />);
    await resolveBadges(BADGES_OK);

    expect(screen.getByTestId('overlay-title')).toHaveTextContent('テスト さん、もう 1 つ獲得しています!');
    expect(screen.getByTestId('overlay-title')).toHaveTextContent(
      personalize(i18n.step3.intro_title, { nickname: 'テスト' }),
    );
    expect(screen.getByTestId('overlay-body')).toHaveTextContent(i18n.step3.intro_hint);
    expect(screen.getByTestId('overlay-body').props.children).not.toContain('{nickname}');
  });

  // #1626: first_bite は、ツアーを通しただけなら未獲得、本物の食事の記録がある人のやり直しのツアーでは獲得済み。
  // 吹き出し (3.2) はどちらでも同じ文言なので、獲得済みの言い方 (「…しました」) も未獲得の言い方 (「…もらえます」) もしない
  it('Step 3 の first_bite の吹き出しは、獲得の有無を言わない共有の文言を出す', async () => {
    jest.useFakeTimers();
    const { resolveBadges } = holdBadges();
    const screen = render(<HandsonTourBadges />);
    await resolveBadges(BADGES_OK);
    act(() => {
      jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP3_INTRO_AUTO_MS);
    });

    expect(screen.getByTestId('overlay-title')).toHaveTextContent(i18n.step3.first_bite_title);
    expect(screen.getByTestId('overlay-body')).toHaveTextContent(i18n.step3.first_bite_bubble);
    expect(screen.getByTestId('overlay-body').props.children).not.toMatch(/しました|もらえます/);
  });

  it('最後の吹き出し (3.4) で抜けたあとに【次へ】が押されても、Step 4 へ進まず完了も記録しない', async () => {
    jest.useFakeTimers();
    const { resolveBadges } = holdBadges();
    const screen = render(<HandsonTourBadges />);
    await resolveBadges(BADGES_OK);
    expect(screen.getByTestId('tour-step-3')).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP3_INTRO_AUTO_MS);
    });
    expect(screen.getByTestId('overlay-title')).toHaveTextContent(i18n.step3.first_bite_title);
    fireEvent.press(screen.getByTestId('overlay-primary')); // 3.2 → 3.3
    fireEvent.press(screen.getByTestId('overlay-primary')); // 3.3 → 3.4
    expect(screen.getByTestId('overlay-title')).toHaveTextContent(i18n.step3.tutorial_complete_title);

    await act(async () => {
      pressHardwareBack();
    });
    fireEvent.press(screen.getByTestId('overlay-primary'));

    expect(mockReplace).toHaveBeenCalledWith('/home');
    expect(mockPush).not.toHaveBeenCalled();
    expect(analyticsCalls('handson_tour_step_completed')).toEqual([]);
    expect(skipCalls()).toHaveLength(1);
  });

  it('抜けずに【次へ】で最後まで進めたときは、これまでどおり Step 4 へ (skip は送らない)', async () => {
    jest.useFakeTimers();
    const { resolveBadges } = holdBadges();
    const screen = render(<HandsonTourBadges />);
    await resolveBadges(BADGES_OK);
    expect(screen.getByTestId('tour-step-3')).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(HANDSON_TOUR_CONSTANTS.STEP3_INTRO_AUTO_MS);
    });
    fireEvent.press(screen.getByTestId('overlay-primary')); // 3.2 → 3.3
    fireEvent.press(screen.getByTestId('overlay-primary')); // 3.3 → 3.4
    fireEvent.press(screen.getByTestId('overlay-primary')); // 3.4 → Step 4

    expect(mockPush).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step4);
    expect(analyticsCalls('handson_tour_step_completed')).toEqual([expect.objectContaining({ step: 3 })]);
    expect(skipCalls()).toHaveLength(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("Android の端末では、analytics の platform を 'android' で送る (step_viewed・skipped)", async () => {
    runOnAndroid();
    const { resolveBadges } = holdBadges();
    render(<HandsonTourBadges />);

    await act(async () => {
      pressHardwareBack();
    });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    await resolveBadges(BADGES_OK);

    expect(analyticsCalls('handson_tour_step_viewed')).toEqual([
      expect.objectContaining({ step: 3, platform: 'android' }),
    ]);
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({ step: 3, reason: 'hard_back', platform: 'android' }),
    ]);
  });
});
