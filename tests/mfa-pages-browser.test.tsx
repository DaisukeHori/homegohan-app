/**
 * #1176 運営ロールの MFA の画面 (ブラウザ) の動き。docs/design/cross/12-operator-mfa.md §15.2 の表・§15.3・§21.1 (mfa-pages-browser.test.tsx)
 *
 * @/lib/auth/mfa/client の通信の関数 (getMfaStatus など) だけを vi.fn にし、mfaErrorMessage・MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE・定数は本物を使う。
 * window.ReactNativeWebView の無いブラウザで描く。段 B・C の it は (B)・(C) の describe に置く。
 */
import { StrictMode, act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MfaClientResult } from '@/lib/auth/mfa/client';
import { UNAUTHENTICATED_SCREEN_MESSAGE } from '@/lib/admin/api-error-message';
import type { MfaEnrollResponse, MfaResetResponse, MfaStatusResponse, MfaVerifyResponse } from '@/lib/auth/mfa/schemas';

const mocks = vi.hoisted(() => ({
  getMfaStatus: vi.fn(),
  startMfaEnrollment: vi.fn(),
  verifyMfaCode: vi.fn(),
  recoverWithBackupCode: vi.fn(),
  regenerateBackupCodes: vi.fn(),
  unenrollMfaFactor: vi.fn(),
  resetOperatorMfa: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  searchParams: { value: new URLSearchParams('next=%2Fadmin') },
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: null } }),
      signOut: async () => ({}),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
      update: () => ({ eq: async () => ({}) }),
    }),
  },
}));

vi.mock('@/lib/auth/mfa/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/mfa/client')>();
  return {
    ...actual,
    getMfaStatus: mocks.getMfaStatus,
    startMfaEnrollment: mocks.startMfaEnrollment,
    verifyMfaCode: mocks.verifyMfaCode,
    recoverWithBackupCode: mocks.recoverWithBackupCode,
    regenerateBackupCodes: mocks.regenerateBackupCodes,
    unenrollMfaFactor: mocks.unenrollMfaFactor,
    resetOperatorMfa: mocks.resetOperatorMfa,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => mocks.searchParams.value,
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

// 設定画面 (/settings) の入口の行のテストで描く設定画面の依存 (src/__tests__/app/settings/account-link.test.ts と同じ差し替え)
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => mocks.supabase }));
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const motion = new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, className, onClick, role }: Record<string, unknown>) =>
          react.createElement(tag, { className, onClick, role }, children as ReactNode),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: ReactNode }) => react.createElement(react.Fragment, null, children),
  };
});

const { default: MfaStatusPage } = await import('@/app/(main)/settings/security/mfa/page');
const { default: MfaSetupPage } = await import('@/app/(main)/settings/security/mfa/setup/page');
const { default: MfaVerifyPage } = await import('@/app/(main)/settings/security/mfa/verify/page');
const { default: MfaRecoverPage } = await import('@/app/(main)/settings/security/mfa/recover/page');
const { default: SettingsPage } = await import('@/app/(main)/settings/page');
const { TotpCodeForm } = await import('@/components/auth/mfa/TotpCodeForm');
const { BackupCodesPanel, BACKUP_CODES_DOWNLOAD_FILENAME } = await import('@/components/auth/mfa/BackupCodesPanel');
const { OperatorMfaResetSection, MFA_RESET_IDENTITY_CHECK_LABELS } = await import('@/components/admin/OperatorMfaResetSection');
const { MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE, MFA_CLIENT_NO_STATUS, MFA_CLIENT_UNKNOWN_CODE, mfaErrorMessage } = await import(
  '@/lib/auth/mfa/client'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FACTOR_ID = '33333333-3333-4333-8333-333333333333';
const ENROLL_FACTOR_ID = '44444444-4444-4444-8444-444444444444';
const CODES = ['ABCDE-FGHJK', 'LMNPQ-RSTUV'];

function statusOf(overrides: Partial<MfaStatusResponse> = {}): MfaStatusResponse {
  return {
    ok: true,
    required: true,
    enrolled: true,
    aal: 'aal1',
    factor: { id: FACTOR_ID, friendly_name: 'authenticator', created_at: '2026-10-01T03:04:00Z' },
    backup_codes_remaining: 8,
    enforce_from: null,
    grace: false,
    ...overrides,
  };
}

const UNENROLLED = statusOf({ enrolled: false, factor: null, backup_codes_remaining: 0 });
const ENROLLMENT: MfaEnrollResponse = {
  ok: true,
  factor_id: ENROLL_FACTOR_ID,
  // enroll の route の応答の形 (素の SVG。auth-js が付けた data URL の前置きは route が外す)
  qr_code_svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  secret: 'JBSWY3DPEHPK3PXP',
  uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
};

function ok<T>(data: T): MfaClientResult<T> {
  return { ok: true, data };
}
function fail(status: number, code: string, retryAfterSec: number | null = null): MfaClientResult<never> {
  return { ok: false, status, code, retryAfterSec };
}

let container: HTMLDivElement;
let root: Root;
let locationMock: { pathname: string; search: string; assign: ReturnType<typeof vi.fn> };

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function render(Page: ComponentType, strict = false) {
  await act(async () => {
    root.render(strict ? createElement(StrictMode, null, createElement(Page)) : createElement(Page));
  });
  await flush();
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return container.querySelector<T>(`[data-testid="${id}"]`);
}

async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    el?.click();
  });
  await flush();
}

/** React の制御された入力に値を入れる (onChange を起こす) */
async function typeInto(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** React の制御された textarea / select に値を入れる (textarea は input、select は change で onChange を起こす) */
async function setFieldValue(field: HTMLTextAreaElement | HTMLSelectElement | null, value: string) {
  expect(field).not.toBeNull();
  await act(async () => {
    const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    field?.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function submitForm(button: HTMLButtonElement | null) {
  expect(button).not.toBeNull();
  await act(async () => {
    button?.form?.requestSubmit(button);
  });
  await flush();
}

function setLocation(pathname: string, search: string) {
  locationMock = { pathname, search, assign: vi.fn() };
  vi.stubGlobal('location', locationMock);
}

beforeEach(() => {
  for (const fn of [
    mocks.getMfaStatus,
    mocks.startMfaEnrollment,
    mocks.verifyMfaCode,
    mocks.recoverWithBackupCode,
    mocks.regenerateBackupCodes,
    mocks.unenrollMfaFactor,
    mocks.resetOperatorMfa,
  ])
    fn.mockReset();
  mocks.router.push.mockReset();
  mocks.router.replace.mockReset();
  mocks.router.refresh.mockReset();
  mocks.searchParams.value = new URLSearchParams('next=%2Fadmin');
  setLocation('/settings/security/mfa', '');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('MFA の 4 画面 (ブラウザ)', () => {
  it("4 画面とも、関数の 401 の失敗で window.location.assign('/login?next=' + encodeURIComponent(この画面の pathname + search)) へ移る", async () => {
    const pages: Array<[ComponentType, string, string]> = [
      [MfaStatusPage, '/settings/security/mfa', ''],
      [MfaSetupPage, '/settings/security/mfa/setup', '?next=%2Fadmin'],
      [MfaVerifyPage, '/settings/security/mfa/verify', '?next=%2Fadmin'],
    ];
    for (const [Page, pathname, search] of pages) {
      setLocation(pathname, search);
      mocks.getMfaStatus.mockResolvedValueOnce(fail(401, 'AUTH_UNAUTHENTICATED'));
      await render(Page);
      expect(locationMock.assign, pathname).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(pathname + search)}`);
      act(() => root.unmount());
      root = createRoot(container);
    }

    // setup の enroll の 401
    setLocation('/settings/security/mfa/setup', '?next=%2Fadmin');
    mocks.getMfaStatus.mockResolvedValueOnce(ok(UNENROLLED));
    mocks.startMfaEnrollment.mockResolvedValueOnce(fail(401, 'AUTH_UNAUTHENTICATED'));
    await render(MfaSetupPage);
    expect(locationMock.assign).toHaveBeenCalledWith('/login?next=' + encodeURIComponent('/settings/security/mfa/setup?next=%2Fadmin'));
    act(() => root.unmount());
    root = createRoot(container);

    // recover は送ったときの 401
    setLocation('/settings/security/mfa/recover', '');
    mocks.recoverWithBackupCode.mockResolvedValueOnce(fail(401, 'AUTH_UNAUTHENTICATED'));
    await render(MfaRecoverPage);
    await typeInto(byTestId<HTMLInputElement>('mfa-recover-code-input'), 'ABCDE-FGHJK');
    await submitForm(byTestId<HTMLButtonElement>('mfa-recover-submit'));
    expect(locationMock.assign).toHaveBeenCalledWith('/login?next=' + encodeURIComponent('/settings/security/mfa/recover'));
  });

  it('状態: 未登録なら [登録する] が /settings/security/mfa/setup?next=%2Fsettings%2Fsecurity%2Fmfa へ移る。403 PERM_DENIED は運営ロールだけの文言', async () => {
    mocks.getMfaStatus.mockResolvedValueOnce(ok(UNENROLLED));
    await render(MfaStatusPage);
    await click(byTestId('mfa-status-enroll'));
    expect(mocks.router.push).toHaveBeenCalledWith('/settings/security/mfa/setup?next=%2Fsettings%2Fsecurity%2Fmfa');

    act(() => root.unmount());
    root = createRoot(container);
    mocks.getMfaStatus.mockResolvedValueOnce(fail(403, 'PERM_DENIED'));
    await render(MfaStatusPage);
    expect(byTestId('mfa-status-error')?.textContent).toBe('この画面は運営ロールの方だけが使えます。');
    expect(byTestId('mfa-status-enroll')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    mocks.getMfaStatus.mockResolvedValueOnce(ok(statusOf({ backup_codes_remaining: 7 })));
    await render(MfaStatusPage);
    expect(byTestId('mfa-status-enrolled')).not.toBeNull();
    expect(byTestId('mfa-status-backup-codes-remaining')?.textContent).toBe('7 個');
    // 登録日は日本時間 (2026-10-01T03:04Z = 12:04 JST)
    expect(byTestId('mfa-status-enrolled')?.textContent).toContain('2026/10/01 12:04');
    expect(mocks.getMfaStatus).toHaveBeenCalledTimes(3);
  });

  it('登録: status の enrolled が true なら /settings/security/mfa へ戻し startMfaEnrollment を呼ばない。enroll の 409 AUTH_2FA_ALREADY_ENROLLED も /settings/security/mfa へ。effect が 2 回動いても startMfaEnrollment は 1 回', async () => {
    mocks.getMfaStatus.mockResolvedValueOnce(ok(statusOf()));
    await render(MfaSetupPage);
    expect(mocks.router.replace).toHaveBeenCalledWith('/settings/security/mfa');
    expect(mocks.startMfaEnrollment).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    mocks.router.replace.mockReset();
    mocks.getMfaStatus.mockResolvedValueOnce(ok(UNENROLLED));
    mocks.startMfaEnrollment.mockResolvedValueOnce(fail(409, 'AUTH_2FA_ALREADY_ENROLLED'));
    await render(MfaSetupPage);
    expect(mocks.router.replace).toHaveBeenCalledWith('/settings/security/mfa');

    act(() => root.unmount());
    root = createRoot(container);
    mocks.startMfaEnrollment.mockReset();
    mocks.getMfaStatus.mockResolvedValue(ok(UNENROLLED));
    mocks.startMfaEnrollment.mockResolvedValue(ok(ENROLLMENT));
    await render(MfaSetupPage, true);
    expect(mocks.startMfaEnrollment).toHaveBeenCalledTimes(1);
    // qr_code_svg は素の SVG (enroll の route が auth-js の前置きを外す)。画面は前置きを 1 回だけ足す (#1707)
    const qrSrc = byTestId<HTMLImageElement>('mfa-setup-qr')?.getAttribute('src') ?? '';
    expect(qrSrc).toBe(`data:image/svg+xml;utf-8,${ENROLLMENT.qr_code_svg}`);
    expect(qrSrc.split('data:image/svg+xml;utf-8,').length - 1).toBe(1);
    expect(qrSrc.startsWith('data:image/svg+xml;utf-8,<svg')).toBe(true);
    const secret = byTestId<HTMLInputElement>('mfa-setup-secret');
    expect(secret?.value).toBe(ENROLLMENT.secret);
    expect(secret?.type).toBe('password');
    await click(byTestId('mfa-setup-secret-toggle'));
    expect(byTestId<HTMLInputElement>('mfa-setup-secret')?.type).toBe('text');

    // enroll のそれ以外の失敗は文言
    act(() => root.unmount());
    root = createRoot(container);
    mocks.startMfaEnrollment.mockResolvedValueOnce(fail(500, 'INTERNAL_ERROR'));
    await render(MfaSetupPage);
    expect(byTestId('mfa-setup-error')?.textContent).toBe(mfaErrorMessage('INTERNAL_ERROR'));
  });

  async function renderSetupReadyForCode() {
    mocks.searchParams.value = new URLSearchParams('next=%2Fsuper-admin%2Fplans');
    mocks.getMfaStatus.mockResolvedValue(ok(UNENROLLED));
    mocks.startMfaEnrollment.mockResolvedValue(ok(ENROLLMENT));
    await render(MfaSetupPage);
    await typeInto(byTestId<HTMLInputElement>('totp-code-input'), '123456');
  }

  it('登録: verify の成功の backup_codes を BackupCodesPanel に出し、「保存した」の後の [続ける] で next へ', async () => {
    await renderSetupReadyForCode();
    mocks.verifyMfaCode.mockResolvedValueOnce(ok<MfaVerifyResponse>({ ok: true, aal: 'aal2', backup_codes: CODES }));
    await submitForm(byTestId<HTMLButtonElement>('totp-code-submit'));
    expect(mocks.verifyMfaCode).toHaveBeenCalledWith({ factor_id: ENROLL_FACTOR_ID, code: '123456' });
    expect(byTestId('backup-codes-list')?.textContent).toContain(CODES[0]);
    expect(byTestId('backup-codes-not-shown')).toBeNull();

    const done = byTestId<HTMLButtonElement>('backup-codes-done');
    expect(done?.disabled).toBe(true);
    await click(byTestId('backup-codes-saved'));
    expect(byTestId<HTMLButtonElement>('backup-codes-done')?.disabled).toBe(false);
    await click(byTestId('backup-codes-done'));
    expect(mocks.router.push).toHaveBeenCalledWith('/super-admin/plans');
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it('登録: verify の成功に backup_codes が無ければ (コードの発行の失敗・応答が届かず打ち直した 2 回目)、BackupCodesPanel を出さず MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE を出し、[二段階認証の設定へ] で /settings/security/mfa へ・[続ける] で next へ移る', async () => {
    await renderSetupReadyForCode();
    mocks.verifyMfaCode.mockResolvedValueOnce(ok<MfaVerifyResponse>({ ok: true, aal: 'aal2' }));
    await submitForm(byTestId<HTMLButtonElement>('totp-code-submit'));
    expect(byTestId('backup-codes-list')).toBeNull();
    expect(byTestId('backup-codes-not-shown')?.textContent).toBe(MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE);

    await click(byTestId('backup-codes-not-shown-settings'));
    expect(mocks.router.push).toHaveBeenLastCalledWith('/settings/security/mfa');
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    await click(byTestId('backup-codes-not-shown-continue'));
    expect(mocks.router.push).toHaveBeenLastCalledWith('/super-admin/plans');
    expect(mocks.router.refresh).toHaveBeenCalledTimes(2);

    // 空の配列も「表示できなかった」扱い
    act(() => root.unmount());
    root = createRoot(container);
    await renderSetupReadyForCode();
    mocks.verifyMfaCode.mockResolvedValueOnce(ok<MfaVerifyResponse>({ ok: true, aal: 'aal2', backup_codes: [] }));
    await submitForm(byTestId<HTMLButtonElement>('totp-code-submit'));
    expect(byTestId('backup-codes-not-shown')).not.toBeNull();
  });

  it('登録: 1 回目の verifyMfaCode が通信の失敗 (MFA_CLIENT_NO_STATUS) なら TotpCodeForm に文言を出して欄を空にし、打ち直した 2 回目の成功が backup_codes 無しなら上の案内になる', async () => {
    await renderSetupReadyForCode();
    mocks.verifyMfaCode.mockResolvedValueOnce(fail(MFA_CLIENT_NO_STATUS, MFA_CLIENT_UNKNOWN_CODE));
    await submitForm(byTestId<HTMLButtonElement>('totp-code-submit'));
    expect(byTestId('totp-code-error')?.textContent).toBe(mfaErrorMessage(MFA_CLIENT_UNKNOWN_CODE));
    expect(byTestId<HTMLInputElement>('totp-code-input')?.value).toBe('');
    expect(locationMock.assign).not.toHaveBeenCalled();

    await typeInto(byTestId<HTMLInputElement>('totp-code-input'), '654321');
    mocks.verifyMfaCode.mockResolvedValueOnce(ok<MfaVerifyResponse>({ ok: true, aal: 'aal2' }));
    await submitForm(byTestId<HTMLButtonElement>('totp-code-submit'));
    expect(mocks.verifyMfaCode).toHaveBeenLastCalledWith({ factor_id: ENROLL_FACTOR_ID, code: '654321' });
    expect(byTestId('backup-codes-not-shown')?.textContent).toBe(MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE);
  });

  it('確認: status の aal が aal2 なら next へ・enrolled が false なら setup?next= へ。verify の 400 は TotpCodeForm に AUTH_2FA_INVALID の文言', async () => {
    mocks.getMfaStatus.mockResolvedValueOnce(ok(statusOf({ aal: 'aal2' })));
    await render(MfaVerifyPage);
    expect(mocks.router.replace).toHaveBeenCalledWith('/admin');

    act(() => root.unmount());
    root = createRoot(container);
    mocks.router.replace.mockReset();
    mocks.searchParams.value = new URLSearchParams('next=%2Fsupport');
    mocks.getMfaStatus.mockResolvedValueOnce(ok(UNENROLLED));
    await render(MfaVerifyPage);
    expect(mocks.router.replace).toHaveBeenCalledWith('/settings/security/mfa/setup?next=%2Fsupport');

    act(() => root.unmount());
    root = createRoot(container);
    mocks.router.replace.mockReset();
    // 外のサイトを指す next は使わず /admin
    mocks.searchParams.value = new URLSearchParams('next=https%3A%2F%2Fevil.example%2F');
    mocks.getMfaStatus.mockResolvedValueOnce(ok(statusOf()));
    await render(MfaVerifyPage);
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(byTestId('mfa-verify-recover-link')?.getAttribute('href')).toBe('/settings/security/mfa/recover');
    await typeInto(byTestId<HTMLInputElement>('totp-code-input'), '111111');
    mocks.verifyMfaCode.mockResolvedValueOnce(fail(400, 'AUTH_2FA_INVALID'));
    await submitForm(byTestId<HTMLButtonElement>('totp-code-submit'));
    expect(mocks.verifyMfaCode).toHaveBeenCalledWith({ factor_id: FACTOR_ID, code: '111111' });
    expect(byTestId('totp-code-error')?.textContent).toBe(
      '確認コードが正しくありません。認証アプリの最新のコードを入力してください。',
    );

    await typeInto(byTestId<HTMLInputElement>('totp-code-input'), '222222');
    mocks.verifyMfaCode.mockResolvedValueOnce(ok<MfaVerifyResponse>({ ok: true, aal: 'aal2' }));
    await submitForm(byTestId<HTMLButtonElement>('totp-code-submit'));
    expect(mocks.router.push).toHaveBeenCalledWith('/admin');
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it('回復: 成功で応答の next (getSafeRedirectPath を通した値) へ window.location.assign', async () => {
    setLocation('/settings/security/mfa/recover', '');
    mocks.recoverWithBackupCode.mockResolvedValueOnce(
      ok({ ok: true as const, next: '/login?next=%2Fsettings%2Fsecurity%2Fmfa%2Fsetup' }),
    );
    await render(MfaRecoverPage);
    expect(byTestId<HTMLButtonElement>('mfa-recover-submit')?.disabled).toBe(true);
    await typeInto(byTestId<HTMLInputElement>('mfa-recover-code-input'), 'abcde-fghjk');
    await submitForm(byTestId<HTMLButtonElement>('mfa-recover-submit'));
    expect(mocks.recoverWithBackupCode).toHaveBeenCalledWith({ code: 'abcde-fghjk' });
    expect(locationMock.assign).toHaveBeenCalledWith('/login?next=/settings/security/mfa/setup');

    // 外のサイトを指す next は使わず /login
    act(() => root.unmount());
    root = createRoot(container);
    setLocation('/settings/security/mfa/recover', '');
    mocks.recoverWithBackupCode.mockResolvedValueOnce(ok({ ok: true as const, next: '//evil.example/' }));
    await render(MfaRecoverPage);
    await typeInto(byTestId<HTMLInputElement>('mfa-recover-code-input'), 'ABCDE-FGHJK');
    await submitForm(byTestId<HTMLButtonElement>('mfa-recover-submit'));
    expect(locationMock.assign).toHaveBeenCalledWith('/login');

    // 失敗は文言 (画面は移らない)
    act(() => root.unmount());
    root = createRoot(container);
    setLocation('/settings/security/mfa/recover', '');
    mocks.recoverWithBackupCode.mockResolvedValueOnce(fail(409, 'AUTH_2FA_NOT_ENROLLED'));
    await render(MfaRecoverPage);
    await typeInto(byTestId<HTMLInputElement>('mfa-recover-code-input'), 'ABCDE-FGHJK');
    await submitForm(byTestId<HTMLButtonElement>('mfa-recover-submit'));
    expect(byTestId('mfa-recover-error')?.textContent).toBe(mfaErrorMessage('AUTH_2FA_NOT_ENROLLED'));
    expect(locationMock.assign).not.toHaveBeenCalled();
  });
});

describe('状態の画面の再発行と解除 (段 B)', () => {
  const VERIFY_FROM_STATUS = '/settings/security/mfa/verify?next=%2Fsettings%2Fsecurity%2Fmfa';
  const SETUP_FROM_STATUS = '/settings/security/mfa/setup?next=%2Fsettings%2Fsecurity%2Fmfa';

  it('状態の [再発行] と [解除] は 403 AUTH_2FA_REQUIRED で /settings/security/mfa/verify?next=%2Fsettings%2Fsecurity%2Fmfa へ。[解除] の成功で /settings/security/mfa/setup?next=%2Fsettings%2Fsecurity%2Fmfa へ (応答の aal が aal1 でも aal2 でも同じ)', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    mocks.getMfaStatus.mockResolvedValue(ok(statusOf()));
    await render(MfaStatusPage);

    mocks.regenerateBackupCodes.mockResolvedValueOnce(fail(403, 'AUTH_2FA_REQUIRED'));
    await click(byTestId('mfa-status-regenerate'));
    expect(mocks.router.push).toHaveBeenLastCalledWith(VERIFY_FROM_STATUS);

    mocks.unenrollMfaFactor.mockResolvedValueOnce(fail(403, 'AUTH_2FA_REQUIRED'));
    await click(byTestId('mfa-status-unenroll'));
    expect(mocks.unenrollMfaFactor).toHaveBeenLastCalledWith(FACTOR_ID);
    expect(mocks.router.push).toHaveBeenLastCalledWith(VERIFY_FROM_STATUS);

    for (const aal of ['aal1', 'aal2'] as const) {
      mocks.router.push.mockClear();
      mocks.router.refresh.mockClear();
      mocks.unenrollMfaFactor.mockResolvedValueOnce(ok({ ok: true as const, aal }));
      await click(byTestId('mfa-status-unenroll'));
      expect(mocks.router.push).toHaveBeenCalledWith(SETUP_FROM_STATUS);
      expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    }

    // 再発行の成功は BackupCodesPanel に出し、「保存した」→ [続ける] で状態を呼び直す
    mocks.getMfaStatus.mockClear();
    mocks.regenerateBackupCodes.mockResolvedValueOnce(ok({ ok: true as const, backup_codes: CODES }));
    await click(byTestId('mfa-status-regenerate'));
    expect(byTestId('backup-codes-list')?.textContent).toContain(CODES[0]);
    await click(byTestId('backup-codes-saved'));
    await click(byTestId('backup-codes-done'));
    expect(byTestId('backup-codes-list')).toBeNull();
    expect(mocks.getMfaStatus).toHaveBeenCalledTimes(1);

    // 確認ダイアログで取り消すと呼ばない
    confirm.mockReturnValue(false);
    mocks.regenerateBackupCodes.mockClear();
    mocks.unenrollMfaFactor.mockClear();
    await click(byTestId('mfa-status-regenerate'));
    await click(byTestId('mfa-status-unenroll'));
    expect(mocks.regenerateBackupCodes).not.toHaveBeenCalled();
    expect(mocks.unenrollMfaFactor).not.toHaveBeenCalled();
  });

  it('状態の [再発行] と [解除] の 500 は mfaErrorMessage の文を出し、getMfaStatus をもう 1 回呼んで表示を出し直す (解除の 500 の後の status が未登録なら [登録する] を出す)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    mocks.getMfaStatus.mockResolvedValueOnce(ok(statusOf({ backup_codes_remaining: 8 })));
    await render(MfaStatusPage);
    expect(mocks.getMfaStatus).toHaveBeenCalledTimes(1);

    mocks.regenerateBackupCodes.mockResolvedValueOnce(fail(500, 'INTERNAL_ERROR'));
    mocks.getMfaStatus.mockResolvedValueOnce(ok(statusOf({ backup_codes_remaining: 0 })));
    await click(byTestId('mfa-status-regenerate'));
    expect(byTestId('mfa-status-action-error')?.textContent).toBe(mfaErrorMessage('INTERNAL_ERROR'));
    expect(mocks.getMfaStatus).toHaveBeenCalledTimes(2);
    expect(byTestId('mfa-status-backup-codes-remaining')?.textContent).toBe('0 個');
    expect(mocks.router.push).not.toHaveBeenCalled();

    mocks.unenrollMfaFactor.mockResolvedValueOnce(fail(500, 'INTERNAL_ERROR'));
    mocks.getMfaStatus.mockResolvedValueOnce(ok(UNENROLLED));
    await click(byTestId('mfa-status-unenroll'));
    expect(mocks.getMfaStatus).toHaveBeenCalledTimes(3);
    expect(byTestId('mfa-status-action-error')?.textContent).toBe(mfaErrorMessage('INTERNAL_ERROR'));
    expect(byTestId('mfa-status-enroll')).not.toBeNull();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });
});

describe('部品', () => {
  it('TotpCodeForm: 値が TOTP_CODE_PATTERN に合うまで [確認] が押せず、送信中は 2 回目を送らない。失敗で欄を空にして文言を出す', async () => {
    const onVerified = vi.fn();
    await act(async () => {
      root.render(createElement(TotpCodeForm, { factorId: FACTOR_ID, onVerified }));
    });
    const input = () => byTestId<HTMLInputElement>('totp-code-input');
    const submit = () => byTestId<HTMLButtonElement>('totp-code-submit');
    expect(input()?.getAttribute('inputmode')).toBe('numeric');
    expect(input()?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(input()?.maxLength).toBe(6);
    expect(submit()?.disabled).toBe(true);
    await typeInto(input(), '12345');
    expect(submit()?.disabled).toBe(true);
    await typeInto(input(), '12345a');
    expect(submit()?.disabled).toBe(true);
    await typeInto(input(), '123456');
    expect(submit()?.disabled).toBe(false);

    let resolveVerify: (value: MfaClientResult<MfaVerifyResponse>) => void = () => undefined;
    mocks.verifyMfaCode.mockImplementationOnce(
      () =>
        new Promise<MfaClientResult<MfaVerifyResponse>>((resolve) => {
          resolveVerify = resolve;
        }),
    );
    await act(async () => {
      submit()?.form?.requestSubmit(submit());
    });
    expect(submit()?.disabled).toBe(true);
    await act(async () => {
      submit()?.form?.requestSubmit(submit());
    });
    expect(mocks.verifyMfaCode).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveVerify(fail(429, 'RATE_LIMITED', 30));
    });
    await flush();
    expect(onVerified).not.toHaveBeenCalled();
    expect(input()?.value).toBe('');
    expect(byTestId('totp-code-error')?.textContent).toBe('試行回数が多すぎます。しばらくしてから再度お試しください。');

    await typeInto(input(), '000000');
    mocks.verifyMfaCode.mockResolvedValueOnce(ok<MfaVerifyResponse>({ ok: true, aal: 'aal2' }));
    await submitForm(submit());
    expect(onVerified).toHaveBeenCalledWith({ ok: true, aal: 'aal2' });
  });

  it('BackupCodesPanel: 「保存した」のチェックを入れるまで [続ける] が押せない。[コピー] は codes を改行でつないで clipboard に書く', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onDone = vi.fn();
    await act(async () => {
      root.render(createElement(BackupCodesPanel, { codes: CODES, onDone }));
    });
    expect(Array.from(byTestId('backup-codes-list')?.querySelectorAll('li') ?? []).map((li) => li.textContent)).toEqual(CODES);
    const done = byTestId<HTMLButtonElement>('backup-codes-done');
    expect(done?.disabled).toBe(true);
    await act(async () => {
      done?.click();
    });
    expect(onDone).not.toHaveBeenCalled();

    const copy = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'コピー') ?? null;
    await click(copy);
    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));

    await click(byTestId('backup-codes-saved'));
    await click(byTestId('backup-codes-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(BACKUP_CODES_DOWNLOAD_FILENAME).toBe('homegohan-mfa-backup-codes.txt');
  });
});

describe('二段階認証の解除 (段 C)', () => {
  const TARGET_USER_ID = '88888888-8888-4888-8888-888888888888';
  const REASON = '端末の紛失。ビデオ通話で本人を確認した';

  it('OperatorMfaResetSection: 理由・本人確認の方法・チェックがそろうまで [解除する] が押せず、window.confirm の後に resetOperatorMfa を 1 回呼び、成功で消した数を、失敗で mfaErrorMessage(code) を出す (confirm で取り消すと呼ばない)', async () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    await act(async () => {
      root.render(createElement(OperatorMfaResetSection, { userId: TARGET_USER_ID }));
    });
    const submit = () => byTestId<HTMLButtonElement>('operator-mfa-reset-submit');
    const reason = () => byTestId<HTMLTextAreaElement>('operator-mfa-reset-reason');
    const identityCheck = () => byTestId<HTMLSelectElement>('operator-mfa-reset-identity-check');

    expect(container.querySelector('h2')?.textContent).toBe('二段階認証を解除');
    expect(reason()?.maxLength).toBe(500);
    expect(Array.from(identityCheck()?.options ?? []).slice(1).map((o) => [o.value, o.textContent])).toEqual([
      ['video_call', 'ビデオ通話で確認'],
      ['in_person', '対面で確認'],
      ['id_document_shown', '身分証を見せてもらい確認 (画像は預からない)'],
      ['other', 'その他'],
    ]);
    expect(MFA_RESET_IDENTITY_CHECK_LABELS.other).toBe('その他');

    // 3 つがそろうまで押せない (空白だけの理由も押せない)
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(reason(), '   ');
    await setFieldValue(identityCheck(), 'video_call');
    await click(byTestId('operator-mfa-reset-identity-confirmed'));
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(reason(), REASON);
    expect(submit()?.disabled).toBe(false);
    await setFieldValue(identityCheck(), '');
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(identityCheck(), 'video_call');
    await click(byTestId('operator-mfa-reset-identity-confirmed'));
    expect(submit()?.disabled).toBe(true);
    await click(byTestId('operator-mfa-reset-identity-confirmed'));
    expect(submit()?.disabled).toBe(false);

    // confirm で取り消すと呼ばない
    await submitForm(submit());
    expect(confirmMock).toHaveBeenCalledWith(
      'この利用者の認証アプリとバックアップコードを消します。対象はすべての端末でログアウトされます。続けますか?',
    );
    expect(mocks.resetOperatorMfa).not.toHaveBeenCalled();

    // OK で 1 回呼び、送信中は 2 回目を送らない
    confirmMock.mockReturnValue(true);
    let resolveReset: (value: MfaClientResult<MfaResetResponse>) => void = () => undefined;
    mocks.resetOperatorMfa.mockImplementationOnce(
      () =>
        new Promise<MfaClientResult<MfaResetResponse>>((resolve) => {
          resolveReset = resolve;
        }),
    );
    await act(async () => {
      submit()?.form?.requestSubmit(submit());
    });
    expect(submit()?.disabled).toBe(true);
    await act(async () => {
      submit()?.form?.requestSubmit(submit());
    });
    expect(mocks.resetOperatorMfa).toHaveBeenCalledTimes(1);
    expect(mocks.resetOperatorMfa).toHaveBeenCalledWith(TARGET_USER_ID, {
      reason: REASON,
      identity_check: 'video_call',
      identity_confirmed: true,
    });
    await act(async () => {
      resolveReset(ok<MfaResetResponse>({ data: { user_id: TARGET_USER_ID, factors_deleted: 1, backup_codes_deleted: 7 } }));
    });
    await flush();
    expect(byTestId('operator-mfa-reset-result')?.textContent).toBe('認証アプリ 1 件・バックアップコード 7 件を消しました');
    expect(byTestId('operator-mfa-reset-error')).toBeNull();

    // 失敗は mfaErrorMessage(code) (403 OP_SELF_MODIFY・500 の既定の文)。401 は運営の画面で揃えた文 (下の it。#2112 Z4)
    for (const [status, code] of [
      [403, 'OP_SELF_MODIFY'],
      [500, 'INTERNAL_ERROR'],
    ] as const) {
      mocks.resetOperatorMfa.mockResolvedValueOnce(fail(status, code));
      await submitForm(submit());
      expect(byTestId('operator-mfa-reset-error')?.textContent, code).toBe(mfaErrorMessage(code));
      expect(byTestId('operator-mfa-reset-result'), code).toBeNull();
    }
    expect(mfaErrorMessage('INTERNAL_ERROR')).toBe('処理中にエラーが発生しました。しばらくしてからお試しください。');
    expect(locationMock.assign).not.toHaveBeenCalled();
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(mocks.resetOperatorMfa).toHaveBeenCalledTimes(3);
  });

  it('OperatorMfaResetSection: 解除が 401 なら、code に関わらず同じページのほかの運営の form (凍結・手動のプラン付与) と同じ「ログインし直してください」を出し、利用者の画面の言い回し (mfaErrorMessage の 401 の文) は出さない。画面は移らない (#2112 Z4)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    await act(async () => {
      root.render(createElement(OperatorMfaResetSection, { userId: TARGET_USER_ID }));
    });
    const submit = () => byTestId<HTMLButtonElement>('operator-mfa-reset-submit');
    await setFieldValue(byTestId<HTMLTextAreaElement>('operator-mfa-reset-reason'), REASON);
    await setFieldValue(byTestId<HTMLSelectElement>('operator-mfa-reset-identity-check'), 'video_call');
    await click(byTestId('operator-mfa-reset-identity-confirmed'));
    expect(submit()?.disabled).toBe(false);

    // reset の route の 401 は UNAUTHORIZED (authFailureNested)。本文が読めない 401 (UNKNOWN)・AUTH_UNAUTHENTICATED でも同じ文
    const codes = ['UNAUTHORIZED', 'AUTH_UNAUTHENTICATED', MFA_CLIENT_UNKNOWN_CODE];
    for (const code of codes) {
      mocks.resetOperatorMfa.mockResolvedValueOnce(fail(401, code));
      await submitForm(submit());
      const shown = byTestId('operator-mfa-reset-error')?.textContent ?? '';
      expect(shown, code).toBe(UNAUTHENTICATED_SCREEN_MESSAGE);
      expect(shown, code).not.toBe(mfaErrorMessage(code));
      expect(byTestId('operator-mfa-reset-result'), code).toBeNull();
    }
    expect(UNAUTHENTICATED_SCREEN_MESSAGE).toBe('ログインし直してください');
    // 利用者の二段階認証の画面の文の表は変えない (§15 の表。運営の画面だけ揃える)
    expect(mfaErrorMessage('UNAUTHORIZED')).toBe('ログインが切れました。もう一度ログインしてください。');
    expect(mocks.resetOperatorMfa).toHaveBeenCalledTimes(codes.length);
    expect(locationMock.assign).not.toHaveBeenCalled();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });
});

describe('設定 /settings の入口の行', () => {
  type WindowWithBridge = Window & { ReactNativeWebView?: unknown };

  it('設定 /settings の入口の行: ブラウザでは getMfaStatus の成功のときだけ出し、401 / 403 でも画面を移らない。window.ReactNativeWebView があれば getMfaStatus を呼ばず行も出さない', async () => {
    mocks.getMfaStatus.mockResolvedValueOnce(ok(statusOf()));
    await render(SettingsPage);
    expect(mocks.getMfaStatus).toHaveBeenCalledTimes(1);
    const row = byTestId('settings-mfa-link');
    expect(row?.textContent).toContain('セキュリティ (二段階認証)');
    await click(row);
    expect(mocks.router.push).toHaveBeenCalledWith('/settings/security/mfa');

    for (const failure of [fail(401, 'AUTH_UNAUTHENTICATED'), fail(403, 'PERM_DENIED'), fail(500, 'INTERNAL_ERROR')]) {
      act(() => root.unmount());
      root = createRoot(container);
      mocks.router.push.mockReset();
      mocks.getMfaStatus.mockResolvedValueOnce(failure);
      await render(SettingsPage);
      expect(byTestId('settings-mfa-link'), String(failure.ok)).toBeNull();
      expect(mocks.router.push).not.toHaveBeenCalled();
      expect(mocks.router.replace).not.toHaveBeenCalled();
      expect(locationMock.assign).not.toHaveBeenCalled();
    }

    act(() => root.unmount());
    root = createRoot(container);
    mocks.getMfaStatus.mockReset();
    (window as WindowWithBridge).ReactNativeWebView = { postMessage: vi.fn() };
    try {
      await render(SettingsPage);
      expect(mocks.getMfaStatus).not.toHaveBeenCalled();
      expect(byTestId('settings-mfa-link')).toBeNull();
    } finally {
      delete (window as WindowWithBridge).ReactNativeWebView;
    }
  });
});
