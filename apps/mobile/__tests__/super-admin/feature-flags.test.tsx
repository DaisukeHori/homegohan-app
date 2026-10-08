/**
 * feature-flags.test.tsx
 * 運営の機能フラグ画面 (app/(super-admin)/super-admin/feature-flags.tsx) のテスト (#1137)
 *
 * 以前の画面は GET / PUT /api/super-admin/feature-flags を呼んでいた (body は { flags: Record<string, boolean> })。
 * サーバーにそのパスは無く、実装は
 *   GET   /api/super-admin/flags          -> { data: [{ key, description, enabled, ... }], meta }
 *   PATCH /api/super-admin/flags/{key}    body { enabled } -> { data: {...} } / 失敗は { error: { code, message } }
 * だったため、画面は常に失敗していた。
 *
 * ここでは、画面が正しいパス・メソッド・body で API を呼び、サーバーの応答の形のまま画面に出せること、
 * 切り替えがすぐ画面に出て (楽観更新)、失敗したら元に戻ることを確かめる。
 * サーバー側にそのパスとメソッドが実在することは、tests/mobile-super-admin-api-contract.test.ts が確かめる。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

// --- モック設定 ---
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockPatch = jest.fn();
const mockDel = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    patch: mockPatch,
    del: mockDel,
  }),
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

import SuperAdminFeatureFlagsPage from '../../app/(super-admin)/super-admin/feature-flags';

/** src/app/api/super-admin/flags/route.ts の GET が返す形 */
function flagsResponse(overrides?: Array<Record<string, unknown>>) {
  const data = overrides ?? [
    {
      key: 'new_meal_ai_v2',
      description: '新しい食事 AI V2',
      enabled: true,
      rollout_strategy: { type: 'percentage', value: 25 },
      constraints: null,
      active_user_count: 0,
      updated_at: '2026-07-11T00:00:00.000Z',
    },
    {
      key: 'beta_banner',
      description: '',
      enabled: false,
      rollout_strategy: null,
      constraints: null,
      active_user_count: 0,
      updated_at: '2026-07-10T00:00:00.000Z',
    },
  ];
  return { data, meta: { total: data.length, page: 1, per_page: data.length } };
}

/** @homegohan/core の createHttpClient が投げるエラーと同じ文面 (api-error.test.ts が本物のクライアントで確認している) */
function httpError(status: number, statusText: string, body: unknown) {
  return new Error(`HTTP ${status} ${statusText}: ${JSON.stringify(body)}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const toggleOf = (key: string) => screen.getByTestId(`feature-flag-toggle-${key}`);
const isOn = (key: string) => toggleOf(key).props.accessibilityState.checked === true;
const isBusy = (key: string) => toggleOf(key).props.accessibilityState.disabled === true;
const rowOf = (key: string) => screen.getByTestId(`feature-flag-row-${key}`);

async function renderLoaded(response = flagsResponse()) {
  mockGet.mockResolvedValue(response);
  render(<SuperAdminFeatureFlagsPage />);
  await waitFor(() => {
    expect(screen.queryByText('読み込み中...')).toBeNull();
  });
}

beforeEach(() => {
  for (const mock of [mockGet, mockPost, mockPut, mockPatch, mockDel]) mock.mockReset();
  (Alert.alert as jest.Mock).mockClear();
});

describe('機能フラグ画面 — 一覧の取得と表示', () => {
  it('GET /api/super-admin/flags を呼ぶ (存在しない /api/super-admin/feature-flags は呼ばない)', async () => {
    await renderLoaded();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/api/super-admin/flags');
  });

  it('サーバーの応答 ({ data, meta }) の key / description / ON・OFF を、キー順に表示する', async () => {
    await renderLoaded();

    const rows = screen.getAllByTestId(/^feature-flag-row-/).map((row) => row.props.testID);
    expect(rows).toEqual(['feature-flag-row-beta_banner', 'feature-flag-row-new_meal_ai_v2']);

    // 説明があるフラグは説明も出す。説明が空のフラグは、空の行を出さない
    expect(within(rowOf('new_meal_ai_v2')).getByText('new_meal_ai_v2')).toBeTruthy();
    expect(within(rowOf('new_meal_ai_v2')).getByText('新しい食事 AI V2')).toBeTruthy();
    expect(within(rowOf('beta_banner')).getByText('beta_banner')).toBeTruthy();
    expect(within(rowOf('beta_banner')).queryByText('')).toBeNull();

    expect(isOn('new_meal_ai_v2')).toBe(true);
    expect(isOn('beta_banner')).toBe(false);
    expect(within(rowOf('new_meal_ai_v2')).getAllByText('ON').length).toBeGreaterThan(0);
    expect(within(rowOf('beta_banner')).getAllByText('OFF').length).toBeGreaterThan(0);
  });

  it('保存ボタンは無い (切り替えはすぐ保存される旨を案内し、段階公開などは Web で行うと案内する)', async () => {
    await renderLoaded();

    expect(screen.queryByText('変更を保存')).toBeNull();
    expect(screen.getByText(/すぐ保存されます/)).toBeTruthy();
    expect(screen.getByText(/Web の管理画面/)).toBeTruthy();
  });

  it('フラグが 0 件なら「機能フラグがありません。」を表示する', async () => {
    await renderLoaded(flagsResponse([]));

    expect(screen.getByText('機能フラグがありません。')).toBeTruthy();
  });

  it('取得に失敗したら、サーバーの { error: { message } } の message を表示する', async () => {
    mockGet.mockRejectedValue(
      httpError(403, 'Forbidden', { error: { code: 'FORBIDDEN', message: '権限がありません' } }),
    );
    render(<SuperAdminFeatureFlagsPage />);

    expect(await screen.findByText('権限がありません')).toBeTruthy();
    expect(screen.queryByText(/HTTP 403/)).toBeNull();
  });

  it('旧形式 { flags: {...} } のような想定外の応答は、空の一覧に見せかけずエラーとして表示する', async () => {
    mockGet.mockResolvedValue({ flags: { new_meal_ai_v2: true } });
    render(<SuperAdminFeatureFlagsPage />);

    expect(await screen.findByText('機能フラグの応答の形式が想定と異なります。')).toBeTruthy();
    expect(screen.queryByText('機能フラグがありません。')).toBeNull();
  });

  it('再読み込みボタンで一覧を取り直す', async () => {
    await renderLoaded();
    mockGet.mockResolvedValue(
      flagsResponse([{ key: 'only_flag', description: '', enabled: true }]),
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('feature-flags-refresh'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('feature-flag-row-only_flag')).toBeTruthy();
    });
    expect(screen.queryByTestId('feature-flag-row-beta_banner')).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenLastCalledWith('/api/super-admin/flags');
  });
});

describe('機能フラグ画面 — ON/OFF の切り替え', () => {
  it('OFF のフラグを押すと PATCH /api/super-admin/flags/{key} { enabled: true } を送る (PUT は使わない)', async () => {
    mockPatch.mockResolvedValue({ data: { key: 'beta_banner', enabled: true } });
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
    });

    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledWith('/api/super-admin/flags/beta_banner', { enabled: true });
    expect(mockPut).not.toHaveBeenCalled();
    expect(isOn('beta_banner')).toBe(true);
    // 切り替えの成功では一覧を取り直さない (他のフラグの表示を巻き込まない)
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('ON のフラグを押すと { enabled: false } を送る。他のフラグは変わらない', async () => {
    mockPatch.mockResolvedValue({ data: { key: 'new_meal_ai_v2', enabled: false } });
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('new_meal_ai_v2'));
    });

    expect(mockPatch).toHaveBeenCalledWith('/api/super-admin/flags/new_meal_ai_v2', { enabled: false });
    expect(isOn('new_meal_ai_v2')).toBe(false);
    expect(isOn('beta_banner')).toBe(false);
  });

  it('押した直後に表示が切り替わり (楽観更新)、完了するまでそのフラグのボタンは押せない', async () => {
    const pending = deferred<unknown>();
    mockPatch.mockReturnValue(pending.promise);
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
    });

    // PATCH はまだ完了していないが、表示はもう ON
    expect(isOn('beta_banner')).toBe(true);
    expect(isBusy('beta_banner')).toBe(true);
    // 他のフラグのボタンは押せる
    expect(isBusy('new_meal_ai_v2')).toBe(false);

    await act(async () => {
      pending.resolve({ data: { key: 'beta_banner', enabled: true } });
    });

    expect(isOn('beta_banner')).toBe(true);
    expect(isBusy('beta_banner')).toBe(false);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('実行中の同じフラグを続けて押しても、PATCH は 1 回だけ送る', async () => {
    const pending = deferred<unknown>();
    mockPatch.mockReturnValue(pending.promise);
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
      fireEvent.press(toggleOf('beta_banner'));
      fireEvent.press(toggleOf('beta_banner'));
    });

    expect(mockPatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ data: { key: 'beta_banner', enabled: true } });
    });
    expect(isOn('beta_banner')).toBe(true);
  });

  it('別々のフラグは、互いの完了を待たずに更新できる', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockPatch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
      fireEvent.press(toggleOf('new_meal_ai_v2'));
    });

    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(mockPatch).toHaveBeenNthCalledWith(1, '/api/super-admin/flags/beta_banner', { enabled: true });
    expect(mockPatch).toHaveBeenNthCalledWith(2, '/api/super-admin/flags/new_meal_ai_v2', { enabled: false });

    // 片方が失敗しても、もう片方の結果は巻き込まない
    await act(async () => {
      first.resolve({ data: { key: 'beta_banner', enabled: true } });
      second.reject(httpError(500, 'Internal Server Error', { error: { code: 'INTERNAL_ERROR', message: '更新できませんでした' } }));
    });

    expect(isOn('beta_banner')).toBe(true);
    expect(isOn('new_meal_ai_v2')).toBe(true);
    expect(isBusy('beta_banner')).toBe(false);
    expect(isBusy('new_meal_ai_v2')).toBe(false);
  });

  it('更新に失敗したら表示を元に戻し、サーバーの message を Alert で出す', async () => {
    const pending = deferred<unknown>();
    mockPatch.mockReturnValue(pending.promise);
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
    });
    expect(isOn('beta_banner')).toBe(true);

    await act(async () => {
      pending.reject(
        httpError(404, 'Not Found', {
          error: { code: 'OP_FEATURE_FLAG_NOT_FOUND', message: '指定されたフラグが見つかりません' },
        }),
      );
    });

    expect(isOn('beta_banner')).toBe(false);
    expect(isBusy('beta_banner')).toBe(false);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith('更新失敗', '指定されたフラグが見つかりません');
  });

  it('ON から OFF への更新に失敗したら ON に戻す (通信エラーは Error の message を出す)', async () => {
    mockPatch.mockRejectedValue(new TypeError('Network request failed'));
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('new_meal_ai_v2'));
    });

    expect(isOn('new_meal_ai_v2')).toBe(true);
    expect(Alert.alert).toHaveBeenCalledWith('更新失敗', 'Network request failed');
  });

  it('失敗したあとは、同じフラグをもう一度押して再試行できる', async () => {
    mockPatch
      .mockRejectedValueOnce(httpError(500, 'Internal Server Error', { error: { code: 'INTERNAL_ERROR', message: '一時的なエラー' } }))
      .mockResolvedValueOnce({ data: { key: 'beta_banner', enabled: true } });
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
    });
    expect(isOn('beta_banner')).toBe(false);

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
    });
    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(mockPatch).toHaveBeenLastCalledWith('/api/super-admin/flags/beta_banner', { enabled: true });
    expect(isOn('beta_banner')).toBe(true);
  });

  it('サーバーが保存した値 (応答の data.enabled) が送った値と違えば、サーバーの値に合わせる', async () => {
    mockPatch.mockResolvedValue({ data: { key: 'beta_banner', enabled: false } });
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
    });

    expect(isOn('beta_banner')).toBe(false);
  });

  it('応答に data.enabled が無くても、送った値のままにする', async () => {
    mockPatch.mockResolvedValue(null);
    await renderLoaded();

    await act(async () => {
      fireEvent.press(toggleOf('beta_banner'));
    });

    expect(isOn('beta_banner')).toBe(true);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('URL に使えない文字を含むキーは、エンコードしてパスに入れる', async () => {
    mockPatch.mockResolvedValue({ data: { key: 'odd key/1?', enabled: true } });
    await renderLoaded(flagsResponse([{ key: 'odd key/1?', description: '', enabled: false }]));

    await act(async () => {
      fireEvent.press(toggleOf('odd key/1?'));
    });

    expect(mockPatch).toHaveBeenCalledWith('/api/super-admin/flags/odd%20key%2F1%3F', { enabled: true });
  });
});
