/**
 * ログイン中の端末の画面 (src/app/(main)/settings/security/sessions/page.tsx) のテスト
 * (#1189・#1190。設計 docs/design/cross/16-auth-history-sessions.md §15・§20.4)
 *
 * 通信の包み (src/lib/auth/sessions/client.ts) を作り物にし、一覧・解除・他の端末のログアウト・最近のログイン・読み込み失敗・未ログインを見る。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listLoginHistory: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));

vi.mock('@/lib/auth/sessions/client', () => ({
  listSessions: mocks.listSessions,
  listLoginHistory: mocks.listLoginHistory,
  revokeSession: mocks.revokeSession,
  revokeOtherSessions: mocks.revokeOtherSessions,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: SessionsSettingsPage } = await import('@/app/(main)/settings/security/sessions/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CURRENT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const base = {
  created_at: '2026-10-15T01:00:00.000Z',
  last_active_at: '2026-10-15T02:00:00.000Z',
  ip_address: '203.0.113.10',
  country_code: 'JP',
};
const sessions = [
  { ...base, session_id: CURRENT_ID, device_label: 'Windows の Chrome', device_name: null, is_current: true },
  { ...base, session_id: OTHER_ID, device_label: 'ほめゴハンのアプリ (iPhone・iPad)', device_name: 'iPhone 15 Pro (iOS 18.0)', is_current: false },
];
const history = [
  {
    ...base,
    session_id: OTHER_ID,
    device_label: 'ほめゴハンのアプリ (iPhone・iPad)',
    device_name: 'iPhone 15 Pro (iOS 18.0)',
    ended_at: null,
    ended_reason: null,
    is_new_device: true,
    is_new_ip: false,
    is_new_country: true,
    alert_sent_at: '2026-10-15T01:01:00.000Z',
  },
  {
    ...base,
    session_id: '55555555-5555-4555-8555-555555555555',
    device_label: 'Mac の Safari',
    device_name: null,
    ended_at: '2026-10-14T01:00:00.000Z',
    ended_reason: 'revoked_by_user',
    is_new_device: false,
    is_new_ip: false,
    is_new_country: false,
    alert_sent_at: null,
  },
];

let container: HTMLDivElement;
let root: Root;
let confirmSpy: ReturnType<typeof vi.fn>;

async function renderPage() {
  await act(async () => {
    root.render(<SessionsSettingsPage />);
  });
  await act(async () => {});
}

const byTestId = (id: string) => Array.from(container.querySelectorAll(`[data-testid="${id}"]`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue({ ok: true, data: sessions });
  mocks.listLoginHistory.mockResolvedValue({ ok: true, data: history });
  mocks.revokeSession.mockResolvedValue({ ok: true, data: { ok: true } });
  mocks.revokeOtherSessions.mockResolvedValue({ ok: true, data: { ok: true, remaining: 1 } });
  confirmSpy = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmSpy);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('/settings/security/sessions (§15)', () => {
  it('ログイン中の端末を一覧し、この端末にはバッジを出して解除のボタンを出さない', async () => {
    await renderPage();
    const items = byTestId('sessions-item');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('[data-testid="sessions-current-badge"]')?.textContent).toBe('この端末');
    expect(items[0].querySelector('[data-testid="sessions-revoke-button"]')).toBeNull();
    expect(items[1].querySelector('[data-testid="sessions-current-badge"]')).toBeNull();
    expect(items[1].querySelector('[data-testid="sessions-revoke-button"]')?.textContent).toBe('この端末をログアウトさせる');
  });

  it('解除は確認のあと DELETE を呼び、成功したら一覧から消す', async () => {
    await renderPage();
    const button = byTestId('sessions-revoke-button')[0] as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mocks.revokeSession).toHaveBeenCalledWith(OTHER_ID);
    expect(byTestId('sessions-item')).toHaveLength(1);
    expect(byTestId('sessions-notice')[0]?.textContent).toContain('ログアウトさせました');

    // 確認で「キャンセル」を選べば呼ばない
    mocks.listSessions.mockResolvedValue({ ok: true, data: sessions });
    confirmSpy.mockReturnValue(false);
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderPage();
    mocks.revokeSession.mockClear();
    await act(async () => {
      (byTestId('sessions-revoke-button')[0] as HTMLButtonElement).click();
    });
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it('他の端末をすべてログアウトは確認のあと POST を呼ぶ', async () => {
    await renderPage();
    const button = byTestId('sessions-revoke-others-button')[0] as HTMLButtonElement;
    expect(button.textContent).toBe('他の端末をすべてログアウト');
    mocks.listSessions.mockResolvedValue({ ok: true, data: [sessions[0]] });
    await act(async () => {
      button.click();
    });
    await act(async () => {});
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mocks.revokeOtherSessions).toHaveBeenCalledTimes(1);
    expect(byTestId('sessions-item')).toHaveLength(1);
  });

  it('最近のログインの印 (新しい端末・地域) を出す', async () => {
    await renderPage();
    const items = byTestId('login-history-item');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('[data-testid="login-history-marks"]')?.textContent).toBe('新しい端末新しい地域');
    expect(items[1].querySelector('[data-testid="login-history-marks"]')).toBeNull();
    expect(items[1].textContent).toContain('この一覧から解除');
  });

  it('端末の見出しは device_label で、device_name は『端末名: …』として添え、見出しにしない (S-31)', async () => {
    await renderPage();
    const other = byTestId('sessions-item')[1];
    expect(other.querySelector('[data-testid="sessions-item-label"]')?.textContent).toBe('ほめゴハンのアプリ (iPhone・iPad)');
    expect(other.querySelector('[data-testid="sessions-item-device-name"]')?.textContent).toBe('端末名: iPhone 15 Pro (iOS 18.0)');
    expect(byTestId('login-history-item')[0].textContent).toContain('ほめゴハンのアプリ (iPhone・iPad) (端末名: iPhone 15 Pro (iOS 18.0))');
  });

  it('読み込み失敗ともう一度読み込む', async () => {
    mocks.listSessions.mockResolvedValueOnce({ ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    await renderPage();
    const error = byTestId('sessions-load-error')[0];
    expect(error).toBeDefined();
    expect(byTestId('sessions-item')).toHaveLength(0);

    const retry = Array.from(error.querySelectorAll('button')).find((b) => b.textContent === 'もう一度読み込む') as HTMLButtonElement;
    await act(async () => {
      retry.click();
    });
    await act(async () => {});
    expect(mocks.listSessions).toHaveBeenCalledTimes(2);
    expect(byTestId('sessions-item')).toHaveLength(2);
  });

  it('未ログインの案内', async () => {
    mocks.listSessions.mockResolvedValue({ ok: false, status: 401, error: { code: 'AUTH_UNAUTHENTICATED', message: 'ログインが切れました。' } });
    await renderPage();
    const signedOut = byTestId('sessions-signed-out')[0];
    expect(signedOut).toBeDefined();
    expect(signedOut.querySelector('a')?.getAttribute('href')).toBe('/login?next=%2Fsettings%2Fsecurity%2Fsessions');
  });
});
