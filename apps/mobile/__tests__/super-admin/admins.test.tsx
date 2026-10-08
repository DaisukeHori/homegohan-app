/**
 * admins.test.tsx
 * 運営の管理者管理画面 (app/(super-admin)/super-admin/admins.tsx) のテスト (#1137)
 *
 * 以前の画面は、ロールの変更に PUT /api/super-admin/admins/{id} を呼んでいた。
 * サーバーに admins/[id] は無く (src/app/api/super-admin/admins は GET の route.ts だけ)、常に失敗していた。
 * ロール変更の実体は PUT / PATCH /api/admin/users/{id}/role (super_admin 専用、body は { roles })。
 * このテストでは、画面がそちらを呼ぶこと、ロールの付与・剥奪の前に確認を挟むこと、
 * 失敗したときにサーバーの message を出すことを確かめる。
 * サーバー側にそのパスとメソッドが実在することは、tests/mobile-super-admin-api-contract.test.ts が確かめる。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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

import SuperAdminAdminsPage from '../../app/(super-admin)/super-admin/admins';

/** src/app/api/super-admin/admins/route.ts の GET が返す形 */
const ADMINS_RESPONSE = {
  admins: [
    { id: 'admin-1', nickname: 'ほり', roles: ['user', 'admin', 'super_admin'], created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'admin-2', nickname: null, roles: ['user', 'admin'], created_at: '2026-02-01T00:00:00.000Z' },
  ],
};

/** @homegohan/core の createHttpClient が投げるエラーと同じ文面 (api-error.test.ts が本物のクライアントで確認している) */
function httpError(status: number, statusText: string, body: unknown) {
  return new Error(`HTTP ${status} ${statusText}: ${JSON.stringify(body)}`);
}

type AlertButton = { text?: string; style?: string; onPress?: () => unknown };

/** 直近の Alert.alert を取り出す */
function lastAlert() {
  const calls = (Alert.alert as jest.Mock).mock.calls;
  const [title, message, buttons] = calls[calls.length - 1] as [string, string, AlertButton[] | undefined];
  return { title, message, buttons: buttons ?? [] };
}

async function renderLoaded() {
  mockGet.mockResolvedValue(ADMINS_RESPONSE);
  render(<SuperAdminAdminsPage />);
  await waitFor(() => {
    expect(screen.getByTestId('admin-row-admin-1')).toBeTruthy();
  });
}

beforeEach(() => {
  for (const mock of [mockGet, mockPost, mockPut, mockPatch, mockDel]) mock.mockReset();
  (Alert.alert as jest.Mock).mockClear();
});

describe('管理者管理画面 — 一覧', () => {
  it('GET /api/super-admin/admins で一覧を取得して表示する', async () => {
    await renderLoaded();

    expect(mockGet).toHaveBeenCalledWith('/api/super-admin/admins');
    expect(screen.getByText('ほり')).toBeTruthy();
    expect(screen.getByText('(no name)')).toBeTruthy();
    expect(screen.getByText('user, admin, super_admin')).toBeTruthy();
  });

  it('取得に失敗したら、サーバーの { error: { message } } の message を表示する', async () => {
    mockGet.mockRejectedValue(
      httpError(403, 'Forbidden', { error: { code: 'FORBIDDEN', message: '権限がありません' } }),
    );
    render(<SuperAdminAdminsPage />);

    expect(await screen.findByText('権限がありません')).toBeTruthy();
    expect(screen.queryByText(/HTTP 403/)).toBeNull();
  });
});

describe('管理者管理画面 — ロールの変更', () => {
  it('ロールのボタンを押すと、確認ダイアログを出すだけで、まだ API は呼ばない', async () => {
    await renderLoaded();

    await act(async () => {
      fireEvent.press(screen.getByTestId('admin-role-admin-2-support'));
    });

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const { title, message, buttons } = lastAlert();
    expect(title).toBe('ロールを付与');
    expect(message).toBe('admin-2 に support ロールを付与します。よろしいですか？');
    expect(buttons.map((b) => b.text)).toEqual(['キャンセル', '付与する']);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('付与を確認すると PUT /api/admin/users/{id}/role に { roles } を送り、一覧を取り直す', async () => {
    mockPut.mockResolvedValue({ data: { success: true, roles: ['user', 'admin', 'support'] } });
    await renderLoaded();

    await act(async () => {
      fireEvent.press(screen.getByTestId('admin-role-admin-2-support'));
    });
    await act(async () => {
      await lastAlert().buttons.find((b) => b.text === '付与する')?.onPress?.();
    });

    expect(mockPut).toHaveBeenCalledTimes(1);
    // サーバーに無い /api/super-admin/admins/{id} ではなく、実在する role API を呼ぶ
    expect(mockPut).toHaveBeenCalledWith('/api/admin/users/admin-2/role', { roles: ['user', 'admin', 'support'] });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('剥奪は destructive の確認になり、確認すると残りのロール (+ user) を送る', async () => {
    mockPut.mockResolvedValue({ data: { success: true, roles: ['user', 'admin'] } });
    await renderLoaded();

    await act(async () => {
      fireEvent.press(screen.getByTestId('admin-role-admin-1-super_admin'));
    });

    const { title, message, buttons } = lastAlert();
    expect(title).toBe('ロールを剥奪');
    expect(message).toBe('ほり に super_admin ロールを剥奪します。よろしいですか？');
    const revoke = buttons.find((b) => b.text === '剥奪する');
    expect(revoke?.style).toBe('destructive');

    await act(async () => {
      await revoke?.onPress?.();
    });

    expect(mockPut).toHaveBeenCalledWith('/api/admin/users/admin-1/role', { roles: ['user', 'admin'] });
  });

  it('キャンセルしたら何も送らない', async () => {
    await renderLoaded();

    await act(async () => {
      fireEvent.press(screen.getByTestId('admin-role-admin-2-super_admin'));
    });
    const cancel = lastAlert().buttons.find((b) => b.text === 'キャンセル');
    expect(cancel?.style).toBe('cancel');
    expect(cancel?.onPress).toBeUndefined();

    expect(mockPut).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('更新に失敗したら、サーバーの message (自分自身のロールは変更できません) を Alert で出す', async () => {
    mockPut.mockRejectedValue(
      httpError(403, 'Forbidden', { error: { code: 'OP_SELF_MODIFY', message: '自分自身のロールは変更できません' } }),
    );
    await renderLoaded();

    await act(async () => {
      fireEvent.press(screen.getByTestId('admin-role-admin-1-support'));
    });
    await act(async () => {
      await lastAlert().buttons.find((b) => b.text === '付与する')?.onPress?.();
    });

    expect(Alert.alert).toHaveBeenLastCalledWith('更新失敗', '自分自身のロールは変更できません');
    // 失敗したときは一覧を取り直さない
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
