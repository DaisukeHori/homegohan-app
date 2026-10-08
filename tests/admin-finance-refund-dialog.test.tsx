/**
 * #1185 請求書詳細 (/admin/finance/invoices/[id]) の「返金を記録して Stripe で開く」
 *
 * 確認すること:
 *   - ダイアログ: 返金額に請求書の支払済み金額が入っている / 理由が必須 / 送る内容 /
 *     記録できたときだけ Stripe を新しいタブで開く / 失敗したときは開かずにエラーを出す /
 *     記録中は二重に送れない
 *   - ページ: 記録に必要な情報 (ユーザー・請求書 ID・支払済みの金額) がそろっているときだけボタンを使える
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/price-change-page-impact.test.tsx と同じ方法)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'evt_1' }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: RefundRecordDialog } = await import('@/components/operator/finance/RefundRecordDialog');
const { default: InvoiceDetailPage } = await import('@/app/admin/finance/invoices/[id]/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER_ID = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID = 'in_1MtHbELkdIwHu7ixl4OzzPMv';
const STRIPE_URL = `https://dashboard.stripe.com/invoices/${INVOICE_ID}`;
const PAGE_BUTTON = '返金を記録して Stripe で開く';
const SUBMIT_BUTTON = '記録して Stripe で開く';
const REASON = '二重に請求されたため';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let openSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** 呼び出しを保留にして、テスト側で好きなタイミングに結果を返せる fetch の応答 */
function deferredResponse() {
  let resolve!: (value: ReturnType<typeof jsonResponse>) => void;
  const promise = new Promise<ReturnType<typeof jsonResponse>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function allText() {
  return document.body.textContent ?? '';
}

function buttonByText(label: string, exact = false): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) =>
    exact ? b.textContent?.trim() === label : b.textContent?.includes(label),
  );
}

function fieldByLabel(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelEl = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.includes(label));
  expect(labelEl, `${label} のラベルが見つからない`).toBeDefined();
  return document.getElementById(labelEl!.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
}

async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement | undefined) {
  expect(button, 'クリック対象のボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  openSpy.mockRestore();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
});

describe('RefundRecordDialog', () => {
  type DialogProps = Partial<React.ComponentProps<typeof RefundRecordDialog>>;

  async function renderDialog(props: DialogProps = {}) {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <RefundRecordDialog
          isOpen
          onClose={onClose}
          userId={USER_ID}
          stripeInvoiceId={INVOICE_ID}
          amountPaid={1200}
          currency="jpy"
          invoiceNumber="HG-0001"
          {...props}
        />,
      );
    });
    return { onClose };
  }

  it('開くと role="dialog" で、返金額に支払済みの金額が入り、理由は空', async () => {
    await renderDialog();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    expect(allText()).toContain('HG-0001');
    expect(fieldByLabel('返金額').value).toBe('1200');
    expect(fieldByLabel('返金額').closest('div')!.textContent).toContain('(円)');
    expect(fieldByLabel('返金の理由').value).toBe('');
    expect(allText()).toContain('返金の理由 (必須)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('閉じている間は何も出さない', async () => {
    await renderDialog({ isOpen: false });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('理由が空のまま送ろうとするとエラー。API は呼ばない', async () => {
    await renderDialog();

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(allText()).toContain('返金の理由を入力してください');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('理由が空白だけでもエラー', async () => {
    await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), '  \n  ');

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(allText()).toContain('返金の理由を入力してください');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([['abc'], ['0'], [''], ['12.5'], ['-100']])('返金額が %j のときはエラー。API は呼ばない', async (value) => {
    await renderDialog();
    await typeInto(fieldByLabel('返金額'), value);
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(allText()).toContain('返金額は 1 以上の整数 (円) で入力してください');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上限を超える返金額はエラー。API は呼ばない', async () => {
    await renderDialog();
    await typeInto(fieldByLabel('返金額'), '100000000');
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(allText()).toContain('返金額が大きすぎます');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('記録できたら、記録済みの表示にして Stripe を新しいタブで開く。送る内容は API の仕様どおり', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { stripe_dashboard_url: STRIPE_URL } }));
    await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), `  ${REASON}  `);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/finance/refunds');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      user_id: USER_ID,
      stripe_invoice_id: INVOICE_ID,
      amount: 1200,
      currency: 'JPY',
      reason: REASON,
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(STRIPE_URL, '_blank', 'noopener,noreferrer');

    // 記録済みの表示。新しいタブがブロックされたときのために同じリンクも出している
    expect(document.querySelector('[role="status"]')?.textContent).toContain('監査ログに記録しました');
    const link = Array.from(document.querySelectorAll('a')).find((a) => a.textContent?.includes('Stripe ダッシュボードを開く'));
    expect(link?.getAttribute('href')).toBe(STRIPE_URL);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('一部だけ返金する: 書き換えた金額がそのまま送られる', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { stripe_dashboard_url: STRIPE_URL } }));
    await renderDialog();
    await typeInto(fieldByLabel('返金額'), '500');
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).amount).toBe(500);
  });

  it('JPY 以外は小数で表示し、最小単位 (セント) に直して送る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { stripe_dashboard_url: STRIPE_URL } }));
    await renderDialog({ amountPaid: 1234, currency: 'usd' });
    expect(fieldByLabel('返金額').value).toBe('12.34');
    expect(allText()).toContain('返金額 (USD)');

    await typeInto(fieldByLabel('返金の理由'), REASON);
    await click(buttonByText(SUBMIT_BUTTON, true));

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.amount).toBe(1234);
    expect(sent.currency).toBe('USD');
  });

  it('記録できなかったら (500)、Stripe は開かずエラーを出す。入力は残り、もう一度送れる', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: '監査ログに記録できませんでした。返金はまだ行わず、もう一度お試しください' } }),
    );
    await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('返金はまだ行わず');
    expect(openSpy).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(fieldByLabel('返金の理由').value).toBe(REASON);

    // もう一度送ると成功する
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { stripe_dashboard_url: STRIPE_URL } }));
    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('権限がないとき (403) は API のメッセージを出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }));
    await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('権限がありません');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('応答が JSON でない失敗でも、返金はまだ行わないよう伝える', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) });
    await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('返金はまだ行わず');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('通信に失敗したら、Stripe は開かずエラーを出す', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('通信に失敗しました');
    expect(openSpy).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it.each([
    ['Stripe 以外の URL', 'https://evil.example.com/invoices/in_1'],
    ['リンクが無い', undefined],
    ['Stripe に似た別のホスト', 'https://dashboard.stripe.com.evil.example.com/x'],
  ])('API が返したリンクが %s のときは開かない (記録はされているので、その旨を伝える)', async (_label, url) => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { stripe_dashboard_url: url } }));
    await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    expect(openSpy).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('監査ログには記録しました');
    expect(Array.from(document.querySelectorAll('a')).some((a) => a.getAttribute('href') === url && url)).toBe(false);
  });

  it('記録中はボタンを押せず、続けて押しても送るのは 1 回だけ。閉じることもできない', async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValue(pending.promise);
    const { onClose } = await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), REASON);

    await click(buttonByText(SUBMIT_BUTTON, true));

    const submitting = buttonByText('記録中', false) as HTMLButtonElement;
    expect(submitting).toBeDefined();
    expect(submitting.disabled).toBe(true);
    expect((buttonByText('キャンセル') as HTMLButtonElement).disabled).toBe(true);

    // 無効化されたボタンを押しても、フォームを直接送っても、2 回目は送られない
    await click(submitting);
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Escape でも閉じない
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(jsonResponse(200, { data: { stripe_dashboard_url: STRIPE_URL } }));
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('キャンセルで onClose。閉じて開き直すと、前回の理由やエラーは残らない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: '失敗' } }));
    const { onClose } = await renderDialog();
    await typeInto(fieldByLabel('返金の理由'), REASON);
    await click(buttonByText(SUBMIT_BUTTON, true));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    await click(buttonByText('キャンセル'));
    expect(onClose).toHaveBeenCalledTimes(1);

    // 閉じて、開き直す
    const props = {
      onClose,
      userId: USER_ID,
      stripeInvoiceId: INVOICE_ID,
      amountPaid: 1200,
      currency: 'jpy',
    };
    await act(async () => {
      root.render(<RefundRecordDialog isOpen={false} {...props} />);
    });
    await act(async () => {
      root.render(<RefundRecordDialog isOpen {...props} />);
    });

    expect(fieldByLabel('返金の理由').value).toBe('');
    expect(fieldByLabel('返金額').value).toBe('1200');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('請求書詳細ページの「返金を記録して Stripe で開く」ボタン', () => {
  const INVOICE = {
    id: 'evt_1',
    stripe_event_id: 'evt_1',
    event_type: 'invoice.paid',
    processing_status: 'completed',
    user_id: USER_ID,
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_123',
    stripe_invoice_id: INVOICE_ID,
    amount_paid: 1200,
    amount_due: 1200,
    currency: 'jpy',
    invoice_number: 'HG-0001',
    invoice_pdf: null,
    period_start: null,
    period_end: null,
    stripe_links: { customer: null, subscription: null, invoice: STRIPE_URL },
    received_at: '2026-10-01T00:00:00.000Z',
    processed_at: null,
    error_message: null,
  };

  async function renderPage(overrides: Record<string, unknown> = {}) {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { ...INVOICE, ...overrides } }));
    await act(async () => {
      root.render(<InvoiceDetailPage />);
    });
  }

  it('そろっているときはボタンが使え、押すとダイアログが開く', async () => {
    await renderPage();

    const button = buttonByText(PAGE_BUTTON, true);
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await click(button);

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(fieldByLabel('返金額').value).toBe('1200');
    // この時点では記録の API は呼んでいない (請求書の取得だけ)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/admin/finance/invoices/evt_1']);
  });

  it.each([
    ['ユーザーを特定できない', { user_id: null }, 'ユーザーを特定できない'],
    ['Stripe の請求書 ID が無い (upcoming など)', { stripe_invoice_id: null }, '請求書 ID が無い'],
    ['支払済みの金額が 0 (支払い失敗など)', { amount_paid: 0 }, '支払済みの金額が無い'],
    ['支払済みの金額が無い', { amount_paid: null }, '支払済みの金額が無い'],
    ['通貨が無い', { currency: null }, '支払済みの金額が無い'],
  ])('%s ときはボタンを使えず、理由を表示する。ダイアログも出さない', async (_label, overrides, expectedText) => {
    await renderPage(overrides);

    const button = buttonByText(PAGE_BUTTON, true);
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
    expect(allText()).toContain(expectedText);

    await click(button);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
