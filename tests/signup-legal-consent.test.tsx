/**
 * #1174 サインアップ画面の「利用規約・プライバシーポリシーへの明示的な同意」
 *
 * 以前は、画面の下に「続行することで、利用規約およびプライバシーポリシーに同意したものとみなされます」と書いてあるだけの
 * みなし同意だった。これを、必須のチェックボックスに変える。
 *   - 文面 (みなし同意) は無くなる
 *   - チェックするまで、Google 登録・メール登録のどちらのボタンも押せない
 *   - チェックの文面から、利用規約 (/terms)・プライバシーポリシー (/privacy) を開ける
 *   - 押せないボタンを何らかの方法で動かされても、登録の処理 (signUp / signInWithOAuth) は呼ばない
 *
 * このチェックは同意の記録 (版・日時) を残さない。記録は同意画面 /legal-consent で同意したときだけ残り、
 * 登録後に同意画面へ回すのは同意ゲートを強制 (LEGAL_CONSENT_ENFORCE=on) にしたときだけ (既定では回さない)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signUp: vi.fn(),
  signInWithOAuth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signUp: mocks.signUp, signInWithOAuth: mocks.signInWithOAuth },
  }),
}));

const { default: SignupPage } = await import('@/app/(auth)/signup/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.signUp.mockResolvedValue({ data: { user: { identities: [{}] }, session: null }, error: null });
  mocks.signInWithOAuth.mockResolvedValue({ error: null });

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

const consentBox = () => container.querySelector<HTMLInputElement>('input#agree-legal')!;
const googleButton = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Googleで登録'))!;
const submitButton = () => container.querySelector<HTMLButtonElement>('form button[type="submit"]')!;

describe('サインアップ画面: 明示的な同意 (#1174)', () => {
  it('★「同意したものとみなされます」という、みなし同意の文面は無い', () => {
    expect(container.textContent).not.toContain('みなされ');
    expect(container.textContent).not.toContain('続行することで');
  });

  it('同意のチェックボックスがあり、最初は未チェック', () => {
    const box = consentBox();
    expect(box).not.toBeNull();
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
  });

  it('チェックボックスの文面に、利用規約 (/terms) とプライバシーポリシー (/privacy) へのリンクがあり、「同意」と書いてある', () => {
    const label = container.querySelector<HTMLLabelElement>('label[for="agree-legal"]')!;
    expect(label.textContent).toContain('同意');
    expect(label.querySelector('a[href="/terms"]')?.textContent).toBe('利用規約');
    expect(label.querySelector('a[href="/privacy"]')?.textContent).toBe('プライバシーポリシー');
  });

  it('★チェックするまで、Google 登録も、メールで登録するボタンも押せない', () => {
    expect(googleButton().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
  });

  it('チェックすると、どちらのボタンも押せるようになる。外すとまた押せない', async () => {
    await act(async () => {
      consentBox().click();
    });
    expect(consentBox().checked).toBe(true);
    expect(googleButton().disabled).toBe(false);
    expect(submitButton().disabled).toBe(false);

    await act(async () => {
      consentBox().click();
    });
    expect(googleButton().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
  });

  it('押せない間は、理由 (チェックして同意する) を案内し、チェックボックスの説明として結びつける', () => {
    const hint = container.querySelector('#agree-legal-hint');
    expect(hint?.textContent).toContain('チェックして同意');
    expect(consentBox().getAttribute('aria-describedby')).toBe('agree-legal-hint');
  });

  it('チェックしたら、案内は消え、存在しない要素を指す aria-describedby も残らない', async () => {
    await act(async () => {
      consentBox().click();
    });
    expect(container.querySelector('#agree-legal-hint')).toBeNull();
    expect(consentBox().hasAttribute('aria-describedby')).toBe(false);
  });

  it('★未チェックのままフォームが送られても (Enter キーなど)、登録の処理は呼ばない。理由を案内する', async () => {
    const email = container.querySelector<HTMLInputElement>('#email')!;
    const password = container.querySelector<HTMLInputElement>('#password')!;
    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
    };
    setValue(email, 'new-user@example.com');
    setValue(password, 'Password1!');

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(container.querySelector('p[role="alert"]')?.textContent).toContain('同意が必要');
  });

  it('未チェックのまま Google 登録を押しても (押せない)、OAuth は始めない', async () => {
    await act(async () => {
      googleButton().click();
    });

    expect(mocks.signInWithOAuth).not.toHaveBeenCalled();
  });

  it('チェックしてから Google 登録を押すと、OAuth を始める', async () => {
    await act(async () => {
      consentBox().click();
    });
    await act(async () => {
      googleButton().click();
    });

    expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithOAuth.mock.calls[0][0].provider).toBe('google');
  });

  it('チェックして、メールとパスワードを入れて送ると、signUp を呼ぶ', async () => {
    await act(async () => {
      consentBox().click();
    });
    const setValue = (selector: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(selector)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    };
    setValue('#email', 'New-User@Example.com');
    setValue('#password', 'Password1!');

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mocks.signUp).toHaveBeenCalledTimes(1);
    expect(mocks.signUp.mock.calls[0][0]).toMatchObject({ email: 'new-user@example.com', password: 'Password1!' });
  });

  it('未チェックのときの案内を出したあと、チェックすると、その案内は消える', async () => {
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('p[role="alert"]')).not.toBeNull();

    await act(async () => {
      consentBox().click();
    });
    expect(container.querySelector('p[role="alert"]')).toBeNull();
  });
});
