/**
 * #1625: モバイルのハンズオンツアー Step 1 の保存 (app/handson-tour/photo.tsx)。Web の #1604 と同じ形にそろえる。
 *
 * 以前は MOCK_PHOTO_RESPONSE をそのまま送っていて mealType が無く、POST /api/meal-plans/add-from-photo の検証で 400 になり、
 * その失敗も握りつぶして Step 2 へ進んでいた。吹き出しの【保存】は保存の API を呼ばずに 1 秒後に進むだけだった。
 * 設計書 docs/design/family/09-onboarding-handson-tour/03-step1-photo.md:
 *   - §3.7 保存は共有の buildTourPhotoSaveBody (夕食・料理・カロリー・写真 null・sandbox true) を ?source=handson_tour で送る。
 *     成功したら Step 2 へ。sandbox_not_eligible はエラーにせず Step 2 へ
 *   - §3.10 失敗はエラー画面 (もう一度 / あとで)。連続 3 回の失敗で【あとで】を強調。【あとで】はホームへ + skip API
 *   - §9 handson_tour_skipped は【あとで】が reason 'user_action'、端末バックが reason 'hard_back'
 *     (01-trigger-flow §2.2: Step 1〜3 の端末バックは skipped{reason:'hard_back'} + skipped_at + /home。エラー画面でも同じ)
 *
 * 失敗の例外は、モバイルが実際に使う @homegohan/core の createHttpClient (fetch だけ差し替え) から作る
 * (エラーの文面 "HTTP <状態> <statusText>: <本文>" が変わったときにここで気付ける)。
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import { createHttpClient, HttpNetworkError, type HttpClient } from '@homegohan/core';
import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  TOUR_PHOTO_SAVE_URL,
  buildTourPhotoSaveBody,
} from '@homegohan/handson-tour-shared';

import { tourPhotoSaveErrorOutcomeOf } from '../../src/handson-tour/photo-save-failure';

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

let mockClient: HttpClient;
jest.mock('../../src/lib/api', () => ({
  getApi: () => mockClient,
}));

const mockFireAnalytics = jest.fn();
jest.mock('@homegohan/handson-tour-shared', () => ({
  ...jest.requireActual('@homegohan/handson-tour-shared'),
  fireAnalytics: (...args: unknown[]) => mockFireAnalytics(...args),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../src/handson-tour/useTourOverlayLogic', () => ({
  registerTourTarget: jest.fn(),
  unregisterTourTarget: jest.fn(),
}));

// 吹き出しのオーバーレイ (TourOverlay) は位置の計測やアニメーションを持つので、進行ボタン (primaryAction) と端末バックだけを持つ形に差し替える。
// 端末バックは本物の TourOverlay.tsx と同じく、hardwareBackPress で overlay.onSkip を呼んで true を返す。
// 子 (画面) への注入 (childProps + mode + onSandboxComplete) は本物の TourSandboxWrapper と同じ
jest.mock('../../src/handson-tour/TourSandboxWrapper', () => {
  const ReactActual = jest.requireActual('react');
  const { BackHandler: BackHandlerActual, Pressable, Text, View } = jest.requireActual('react-native');
  function MockTourSandboxWrapper(props: {
    children: React.ReactElement;
    childProps: object;
    subStep: string;
    onSandboxComplete: (result: unknown) => void;
    overlay: { primaryAction?: { label: string; onPress: () => void; disabled?: boolean }; onSkip?: () => void };
  }) {
    const { onSkip } = props.overlay;
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
      { testID: `overlay-sub-step-${props.subStep}` },
      ReactActual.cloneElement(props.children, {
        ...props.childProps,
        mode: 'sandbox',
        onSandboxComplete: props.onSandboxComplete,
      }),
      props.overlay.primaryAction
        ? ReactActual.createElement(
            Pressable,
            {
              testID: 'overlay-primary',
              onPress: props.overlay.primaryAction.onPress,
              disabled: props.overlay.primaryAction.disabled,
            },
            ReactActual.createElement(Text, null, props.overlay.primaryAction.label),
          )
        : null,
    );
  }
  return { TourSandboxWrapper: MockTourSandboxWrapper };
});

import HandsonTourPhoto from '../../app/handson-tour/photo';

const i18n = HANDSON_TOUR_I18N_JA.tour.step1;
const API_BASE_URL = 'https://api.example.com';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_ERROR = 500;
/** 1.1 → 1.5 の自動進行の各段の待ち (photo.tsx のタイマー表と同じ定数)。次の段のタイマーは描き直しのあとに張られるので 1 段ずつ進める */
const AUTO_STEP_DURATIONS_MS = [
  HANDSON_TOUR_CONSTANTS.STEP1_INTRO_AUTO_MS,
  HANDSON_TOUR_CONSTANTS.STEP1_CAMERA_AUTO_MS,
  HANDSON_TOUR_CONSTANTS.STEP1_ANALYZING_DURATION_MS,
  HANDSON_TOUR_CONSTANTS.STEP1_RESULT_TO_SPOTLIGHT_MS,
];
const AUTO_STEPS_TOTAL_MS = AUTO_STEP_DURATIONS_MS.reduce((sum, ms) => sum + ms, 0);

type FakeResponse = { ok: boolean; status: number; statusText: string; text: () => Promise<string> };

function jsonResponse(status: number, statusText: string, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, statusText, text: async () => JSON.stringify(body) };
}

const SUCCESS = jsonResponse(HTTP_OK, 'OK', { success: true, sandbox: true, mealId: 'sandbox-meal-1' });
const NOT_ELIGIBLE = jsonResponse(HTTP_CONFLICT, 'Conflict', {
  error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason: 'already_finished' },
});
const VALIDATION_FAILED = jsonResponse(HTTP_BAD_REQUEST, 'Bad Request', { error: 'Invalid mealType' });
const SAVE_FAILED = jsonResponse(HTTP_INTERNAL_ERROR, 'Internal Server Error', { error: 'Failed to save sandbox meal' });

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

/** fetch の呼び出しのうち、保存 (add-from-photo) のものだけ */
function saveCalls(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/meal-plans/add-from-photo'));
}

function skipCalls(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/handson-tour/skip'));
}

type HardwareBackListener = Parameters<typeof BackHandler.addEventListener>[1];
/** 端末バックの event (react-native 0.88 の HardwareBackPressEvent。受け手は値を見ない) */
const HARDWARE_BACK_EVENT: Parameters<HardwareBackListener>[0] = { type: 'hardwareBackPress', timeStamp: 0 };
/** BackHandler.addEventListener で登録された端末バックの受け手 (登録順)。jest の preset は iOS なので本物の BackHandler は何も持たない */
let hardwareBackListeners: HardwareBackListener[] = [];
let addBackListenerSpy: jest.SpyInstance | null = null;

/** Android の端末バックを 1 回押す。本物と同じく、後に登録したものから順に呼び、true を返したところで止める。止まらなければ false (= 既定の戻る) */
function pressHardwareBack(): boolean {
  for (const listener of [...hardwareBackListeners].reverse()) {
    if (listener(HARDWARE_BACK_EVENT)) return true;
  }
  return false;
}

function analyticsCalls(eventName: string): unknown[] {
  return mockFireAnalytics.mock.calls.filter(([name]) => name === eventName).map(([, payload]) => payload);
}

beforeEach(() => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockFireAnalytics.mockReset();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  // 5xx のやり直し (待ち時間が入る) はしない。POST はもともとやり直さない
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
});

describe('#1625: 保存で送る本文', () => {
  it('画面の保存ボタンは、共有の本文 (夕食・料理・カロリー・写真 null・sandbox) を ?source=handson_tour の add-from-photo へ送り、成功したら Step 2 へ', async () => {
    fetchMock.mockResolvedValue(SUCCESS);
    const screen = render(<HandsonTourPhoto />);

    fireEvent.press(screen.getByTestId('meal-save-button-press'));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step2));
    const calls = saveCalls();
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`${API_BASE_URL}${TOUR_PHOTO_SAVE_URL}`);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual(buildTourPhotoSaveBody());
    expect(sent).toEqual({
      sandbox: true,
      mealType: 'dinner',
      dishes: [{ name: '鶏の唐揚げ定食', cal: 780, role: 'main' }],
      totalCalories: 780,
      imageUrl: null,
    });
    // 以前の本文 (MOCK_PHOTO_RESPONSE の項目) を混ぜない
    expect(sent).not.toHaveProperty('dishName');
    expect(sent).not.toHaveProperty('source');
    expect(analyticsCalls('handson_tour_step_completed')).toEqual([
      expect.objectContaining({ step: 1, user_id: 'user-1' }),
    ]);
    expect(screen.queryByTestId('tour-step-1-error')).toBeNull();
  });
});

describe('#1625: 吹き出しの【保存】は保存してから進む (以前は API を呼ばずに 1 秒後に進むだけ)', () => {
  it('1.5【次へ】→ 1.6【保存】で保存を送り、応答が返るまでは Step 2 へ進まない', async () => {
    jest.useFakeTimers();
    let resolveSave: (response: FakeResponse) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<FakeResponse>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const screen = render(<HandsonTourPhoto />);

    for (const ms of AUTO_STEP_DURATIONS_MS) {
      act(() => {
        jest.advanceTimersByTime(ms);
      });
    }
    expect(screen.getByTestId('overlay-sub-step-1.5')).toBeTruthy();
    expect(screen.getByText(i18n.next_button)).toBeTruthy();
    fireEvent.press(screen.getByTestId('overlay-primary'));

    expect(screen.getByTestId('overlay-sub-step-1.6')).toBeTruthy();
    expect(screen.getByText(i18n.save_button)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('overlay-primary'));
    });

    // 保存中 (1.7): 送ったが、応答が返るまでは進まない。時間が経っても進まない (以前の setTimeout で進む動きが無い)
    expect(saveCalls()).toHaveLength(1);
    expect(screen.getByTestId('overlay-sub-step-1.7')).toBeTruthy();
    expect(screen.getByTestId('tour-step-1-saving')).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(AUTO_STEPS_TOTAL_MS);
    });
    expect(mockPush).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave(SUCCESS);
    });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step2));
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('保存中にもう一度押しても、保存は 1 回だけ送る', async () => {
    let resolveSave: (response: FakeResponse) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<FakeResponse>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const screen = render(<HandsonTourPhoto />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('meal-save-button-press'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('meal-save-button-press'));
    });
    expect(saveCalls()).toHaveLength(1);

    await act(async () => {
      resolveSave(SUCCESS);
    });
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
  });
});

describe('#1625: 失敗はエラー画面 (設計書 03-step1 §3.10)', () => {
  it('400 の失敗は Step 2 へ進まずにエラー画面を出し、handson_tour_step_error に状態つきで記録する', async () => {
    fetchMock.mockResolvedValue(VALIDATION_FAILED);
    const screen = render(<HandsonTourPhoto />);

    fireEvent.press(screen.getByTestId('meal-save-button-press'));

    expect(await screen.findByTestId('tour-step-1-error')).toBeTruthy();
    expect(screen.getByText(`⚠ ${i18n.error_title}`)).toBeTruthy();
    expect(screen.getByText(i18n.error_subtitle)).toBeTruthy();
    expect(screen.getByText(i18n.error_retry_button)).toBeTruthy();
    expect(screen.getByText(i18n.error_skip_button)).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    expect(analyticsCalls('handson_tour_step_completed')).toEqual([]);
    expect(analyticsCalls('handson_tour_step_error')).toEqual([
      expect.objectContaining({
        step: 1,
        sub_step: '1.6',
        error_code: 'sandbox_save_failed',
        error_message: 'POST /api/meal-plans/add-from-photo failed',
        http_status: HTTP_BAD_REQUEST,
      }),
    ]);
  });

  it('通信できなかったときもエラー画面 (error_code は sandbox_save_network_error)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const screen = render(<HandsonTourPhoto />);

    fireEvent.press(screen.getByTestId('meal-save-button-press'));

    expect(await screen.findByTestId('tour-step-1-error')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    expect(analyticsCalls('handson_tour_step_error')).toEqual([
      expect.objectContaining({ error_code: 'sandbox_save_network_error', step: 1 }),
    ]);
    const [payload] = analyticsCalls('handson_tour_step_error') as Array<Record<string, unknown>>;
    expect(payload).not.toHaveProperty('http_status');
  });

  it('【もう一度】は保存を送り直し、成功したら Step 2 へ', async () => {
    fetchMock.mockResolvedValueOnce(SAVE_FAILED).mockResolvedValueOnce(SUCCESS);
    const screen = render(<HandsonTourPhoto />);

    fireEvent.press(screen.getByTestId('meal-save-button-press'));
    fireEvent.press(await screen.findByTestId('tour-step-1-error-retry'));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step2));
    expect(saveCalls()).toHaveLength(2);
    expect(JSON.parse(String(saveCalls()[1][1].body))).toEqual(buildTourPhotoSaveBody());
  });

  it('連続 3 回の失敗で【あとで】を強調し、【あとで】は skip API を呼んでホームへ (Step 2 へは進まない)', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/handson-tour/skip') ? jsonResponse(HTTP_OK, 'OK', { success: true }) : SAVE_FAILED,
    );
    const screen = render(<HandsonTourPhoto />);

    fireEvent.press(screen.getByTestId('meal-save-button-press'));
    await screen.findByTestId('tour-step-1-error');
    expect(screen.getByText(i18n.error_skip_button)).not.toHaveStyle({ fontWeight: '700' });

    for (let attempt = 1; attempt < HANDSON_TOUR_CONSTANTS.ERROR_CONSECUTIVE_THRESHOLD; attempt += 1) {
      fireEvent.press(screen.getByTestId('tour-step-1-error-retry'));
      await waitFor(() => expect(saveCalls()).toHaveLength(attempt + 1));
      await screen.findByTestId('tour-step-1-error');
    }
    await waitFor(() => expect(screen.getByText(i18n.error_skip_button)).toHaveStyle({ fontWeight: '700' }));
    expect(analyticsCalls('handson_tour_step_error')).toHaveLength(HANDSON_TOUR_CONSTANTS.ERROR_CONSECUTIVE_THRESHOLD);

    fireEvent.press(screen.getByTestId('tour-step-1-error-skip'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 1, reason: 'user_action' });
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({ step: 1, reason: 'user_action' }),
    ]);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('#1625: 保存の対象でない利用者 (sandbox_not_eligible) は Step 2 へ', () => {
  it('409 sandbox_not_eligible はエラー画面を出さずに Step 2 へ進む', async () => {
    fetchMock.mockResolvedValue(NOT_ELIGIBLE);
    const screen = render(<HandsonTourPhoto />);

    fireEvent.press(screen.getByTestId('meal-save-button-press'));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(HANDSON_TOUR_ROUTES.step2));
    expect(screen.queryByTestId('tour-step-1-error')).toBeNull();
    expect(analyticsCalls('handson_tour_step_error')).toEqual([]);
    expect(analyticsCalls('handson_tour_step_completed')).toHaveLength(1);
  });
});

describe('#1625: 端末バック (Android) は hard_back でツアーを抜ける (設計書 01-trigger-flow §2.2・03-step1 §9)', () => {
  const SKIP_OK = jsonResponse(HTTP_OK, 'OK', { skipped_at: '2026-10-15T00:00:00.000Z' });

  it('吹き出しの画面での端末バックは、skip API と handson_tour_skipped を reason hard_back で送り、ホームへ', async () => {
    fetchMock.mockResolvedValue(SKIP_OK);
    render(<HandsonTourPhoto />);

    let handled = false;
    await act(async () => {
      handled = pressHardwareBack();
    });

    expect(handled).toBe(true);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 1, reason: 'hard_back' });
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({ step: 1, reason: 'hard_back', user_id: 'user-1' }),
    ]);
    expect(saveCalls()).toHaveLength(0);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('エラー画面での端末バックも、既定の戻る (Step 0) にせず、reason hard_back で skip してホームへ', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/handson-tour/skip') ? SKIP_OK : SAVE_FAILED,
    );
    const screen = render(<HandsonTourPhoto />);

    fireEvent.press(screen.getByTestId('meal-save-button-press'));
    await screen.findByTestId('tour-step-1-error');
    // エラー画面ではオーバーレイを外すので、受け手はエラー画面の 1 つだけ
    expect(hardwareBackListeners).toHaveLength(1);

    let handled = false;
    await act(async () => {
      handled = pressHardwareBack();
    });

    expect(handled).toBe(true);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 1, reason: 'hard_back' });
    expect(analyticsCalls('handson_tour_skipped')).toEqual([
      expect.objectContaining({ step: 1, reason: 'hard_back' }),
    ]);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('エラー画面の【もう一度】で吹き出しの画面に戻ると、エラー画面の受け手は外れ、端末バックはオーバーレイが受ける (skip は 1 回)', async () => {
    let resolveRetry: (response: FakeResponse) => void = () => undefined;
    fetchMock
      .mockResolvedValueOnce(SAVE_FAILED)
      .mockImplementationOnce(
        () =>
          new Promise<FakeResponse>((resolve) => {
            resolveRetry = resolve;
          }),
      )
      .mockResolvedValue(SKIP_OK);
    const screen = render(<HandsonTourPhoto />);

    fireEvent.press(screen.getByTestId('meal-save-button-press'));
    fireEvent.press(await screen.findByTestId('tour-step-1-error-retry'));
    await waitFor(() => expect(screen.queryByTestId('tour-step-1-error')).toBeNull());
    expect(hardwareBackListeners).toHaveLength(1);

    await act(async () => {
      pressHardwareBack();
    });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));

    // 抜けたあとに保存の応答 (成功) が返っても、Step 2 へ進めない
    await act(async () => {
      resolveRetry(SUCCESS);
    });
    expect(mockPush).not.toHaveBeenCalled();
    expect(analyticsCalls('handson_tour_step_completed')).toEqual([]);
    expect(skipCalls()).toHaveLength(1);
    expect(JSON.parse(String(skipCalls()[0][1].body))).toEqual({ step: 1, reason: 'hard_back' });
  });

  it('端末バックを続けて押しても skip は 1 回だけ', async () => {
    fetchMock.mockResolvedValue(SKIP_OK);
    render(<HandsonTourPhoto />);

    await act(async () => {
      pressHardwareBack();
      pressHardwareBack();
    });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(skipCalls()).toHaveLength(1);
    expect(analyticsCalls('handson_tour_skipped')).toHaveLength(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });
});

describe('#1625: tourPhotoSaveErrorOutcomeOf (保存の例外の読み方)', () => {
  async function rejectionOf(response: FakeResponse): Promise<unknown> {
    fetchMock.mockResolvedValue(response);
    try {
      await mockClient.post(TOUR_PHOTO_SAVE_URL, buildTourPhotoSaveBody());
    } catch (error) {
      return error;
    }
    throw new Error('rejected されませんでした');
  }

  it('本物のクライアントの 409 sandbox_not_eligible は対象外と読む', async () => {
    expect(tourPhotoSaveErrorOutcomeOf(await rejectionOf(NOT_ELIGIBLE))).toEqual({ kind: 'not_eligible' });
  });

  it('HTTP/2 で statusText が空の形 ("HTTP 409 : {...}") も対象外と読む', async () => {
    const response = { ...NOT_ELIGIBLE, statusText: '' };
    expect(tourPhotoSaveErrorOutcomeOf(await rejectionOf(response))).toEqual({ kind: 'not_eligible' });
  });

  it('ほかの code の 409・JSON でない本文は、状態つきの失敗', async () => {
    const otherConflict = jsonResponse(HTTP_CONFLICT, 'Conflict', { error: { code: 'profile_not_found' } });
    expect(tourPhotoSaveErrorOutcomeOf(await rejectionOf(otherConflict))).toEqual({
      kind: 'failed',
      failure: {
        error_code: 'sandbox_save_failed',
        error_message: 'POST /api/meal-plans/add-from-photo failed',
        http_status: HTTP_CONFLICT,
      },
    });
    const html: FakeResponse = {
      ok: false,
      status: HTTP_INTERNAL_ERROR,
      statusText: 'Internal Server Error',
      text: async () => '<html>sandbox_not_eligible</html>',
    };
    expect(tourPhotoSaveErrorOutcomeOf(await rejectionOf(html))).toEqual({
      kind: 'failed',
      failure: expect.objectContaining({ error_code: 'sandbox_save_failed', http_status: HTTP_INTERNAL_ERROR }),
    });
  });

  it('通信の失敗 (HttpNetworkError) は sandbox_save_network_error。HTTP の形でない例外は状態なしの失敗', () => {
    expect(tourPhotoSaveErrorOutcomeOf(new HttpNetworkError('offline', 'Network request failed'))).toEqual({
      kind: 'failed',
      failure: { error_code: 'sandbox_save_network_error', error_message: 'POST /api/meal-plans/add-from-photo threw' },
    });
    expect(tourPhotoSaveErrorOutcomeOf(new Error('今日の AI の利用回数の上限に達しました'))).toEqual({
      kind: 'failed',
      failure: { error_code: 'sandbox_save_failed', error_message: 'POST /api/meal-plans/add-from-photo failed' },
    });
    expect(tourPhotoSaveErrorOutcomeOf(null)).toEqual({
      kind: 'failed',
      failure: { error_code: 'sandbox_save_failed', error_message: 'POST /api/meal-plans/add-from-photo failed' },
    });
  });
});
