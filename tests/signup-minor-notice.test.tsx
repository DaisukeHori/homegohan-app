/**
 * サインアップ画面 (Web) の 18 歳未満の注記 (#1173 / 設計書 docs/design/cross/14-parental-consent.md §6.5.6 の 7・T-EM2)
 * 同意のチェックの有無に関わらず、SIGNUP_MINOR_NOTICE を常に出す。年齢の確認そのものは登録後の同意画面で行う。
 * モバイルの同じ注記は apps/mobile/__tests__/auth/signup.test.tsx。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNUP_MINOR_NOTICE } from '@homegohan/shared';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signUp: vi.fn(), signInWithOAuth: vi.fn() } }),
}));

const { default: SignupPage } = await import('@/app/(auth)/signup/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SignupPage />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('サインアップ画面 (Web) の 18 歳未満の注記 (T-EM2)', () => {
  it('SIGNUP_MINOR_NOTICE が出て、同意のチェックを入れても消えない', async () => {
    expect(container.textContent).toContain(SIGNUP_MINOR_NOTICE);

    const box = container.querySelector<HTMLInputElement>('input#agree-legal')!;
    await act(async () => {
      box.click();
    });
    expect(box.checked).toBe(true);
    expect(container.textContent).toContain(SIGNUP_MINOR_NOTICE);
  });

  it('注記は「みなされ」を含まない (#1174 の方針)', () => {
    expect(SIGNUP_MINOR_NOTICE).not.toContain('みなされ');
  });
});
