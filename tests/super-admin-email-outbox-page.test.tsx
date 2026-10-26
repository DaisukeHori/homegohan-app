/**
 * #1708 (#1193) メール送信の画面 (/super-admin/email-outbox) の表示テスト
 *
 * 正本: docs/design/operator/10-logs-and-mail-retry.md §9.2 (画面)。確かめること:
 *   - 初回表示: 届けられなかったもの (dead) を 50 件ずつ取る。宛先は API がマスクした形のまま表示する
 *   - 状態の切り替え・文面の名前で絞り込む (「絞り込む」を押したときだけ)
 *   - dead の行にだけ「再送」。伏せ字の行は無効にして理由を出す
 *   - 再送の成功で行を queued に描き替え、role="status" で知らせる。409 / 404 は API の説明を出す
 *   - 再送の通信の reject は一覧を読み直し、自分の再送が済んでいたときにも合う文を出す (#2073。詳しくは super-admin-status-reject-reload-2073.test.tsx)
 *   - 再送は 1 行ずつで、一覧の読み込みと重ねない (#2073。同じく super-admin-status-reject-reload-2073.test.tsx)
 *   - さらに読み込む (カーソル)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: EmailOutboxPage } = await import('@/app/super-admin/email-outbox/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Item {
  id: string;
  created_at: string;
  updated_at: string;
  status: 'queued' | 'sent' | 'dead';
  template: string;
  recipient: string;
  redacted: boolean;
  user_id: string | null;
  attempts: number;
  requeue_count: number;
  next_attempt_at: string;
  lease_expires_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_status_code: number | null;
  sent_at: string | null;
  dead_at: string | null;
  requeued_at: string | null;
}

const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** i 秒目 (UTC 05:00:ii = 日本時間 14:00:ii) の dead の行 */
function item(i: number, overrides: Partial<Item> = {}): Item {
  const at = `2026-10-16T05:00:${String(i).padStart(2, '0')}.123456+00:00`;
  return {
    id: idOf(i),
    created_at: at,
    updated_at: at,
    status: 'dead',
    template: 'family_invite',
    recipient: `t***@example${i}.com`,
    redacted: false,
    user_id: null,
    attempts: 1,
    requeue_count: 0,
    next_attempt_at: at,
    lease_expires_at: null,
    last_error_code: 'validation_error',
    last_error_message: 'The domain is not verified',
    last_status_code: 403,
    sent_at: null,
    dead_at: at,
    requeued_at: null,
    ...overrides,
  };
}

function page(rows: Item[], nextCursor: string | null = null) {
  return { data: rows, meta: { limit: 50, has_more: nextCursor !== null, next_cursor: nextCursor } };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const text = () => container.textContent ?? '';
const listCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).startsWith('/api/super-admin/email-outbox?'));
const requeueCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/requeue'));
const paramsOf = (url: unknown) => new URL(String(url), 'http://localhost').searchParams;
const lastListParams = () => paramsOf(listCalls().at(-1)![0]);

function rows(): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

function buttonsIn(element: Element, label: string): HTMLButtonElement[] {
  return Array.from(element.querySelectorAll('button')).filter((b) => b.textContent?.trim() === label);
}

function button(label: string): HTMLButtonElement {
  const found = buttonsIn(container, label)[0];
  expect(found, `ボタン「${label}」が見つからない`).toBeDefined();
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

async function type(id: string, value: string) {
  const input = container.querySelector(`#${id}`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  fetchMock = vi.fn(async () => jsonResponse(page([item(2), item(1)])));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<EmailOutboxPage />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('メール送信の画面: 初回表示', () => {
  it('初回は dead を 50 件。見出しと説明を出す', async () => {
    expect(listCalls()).toHaveLength(1);
    expect(String(listCalls()[0][0])).toBe('/api/super-admin/email-outbox?status=dead&limit=50');
    expect(listCalls()[0][1]).toEqual({ cache: 'no-store' });
    expect(container.querySelector('h1')?.textContent).toBe('メール送信');
    expect(text()).toContain('宛先は伏せて表示します');
    expect(rows()).toHaveLength(2);
    expect(text()).toContain('2 件を表示中');
  });

  it('行に作成日時 (日本時間)・状態・文面の名前・マスクした宛先・試行 / 再送・失敗を出す', async () => {
    const first = rows()[0];
    expect(first.textContent).toContain('2026/10/16 14:00:02');
    expect(first.textContent).toContain('届けられなかった');
    expect(first.textContent).toContain('family_invite');
    expect(first.textContent).toContain('t***@example2.com');
    expect(first.textContent).toContain('1 / 0');
    expect(first.textContent).toContain('validation_error (403)');
    expect(first.textContent).toContain('The domain is not verified');
  });

  it('1 件も無ければ「条件に合うメールはありません」', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page([])));
    await click(button('再読み込み'));

    expect(text()).toContain('条件に合うメールはありません');
  });

  it('API の失敗 (403) は運用者に分かる説明を出す', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403));
    await click(button('再読み込み'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('権限がありません');
    expect(text()).not.toContain('条件に合うメールはありません');
  });

  it('403 の本文の文が二段階認証の文なら、「権限がありません」で上書きせずその文を出す (#1917 の続き・整合 1025b)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'FORBIDDEN', message: '二段階認証の確認が必要です' } }, 403));
    await click(button('再読み込み'));

    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('二段階認証の確認が必要です');
    expect(alert).not.toContain('権限がありません');
    expect(text()).not.toContain('条件に合うメールはありません');
  });
});

describe('メール送信の画面: 状態の切り替えと絞り込み', () => {
  it('状態を選んで「絞り込む」を押すと、その状態で取り直す (選んだだけでは取らない)', async () => {
    await click(container.querySelector('#email-outbox-status-queued') as HTMLInputElement);
    expect(listCalls()).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(jsonResponse(page([item(3, { status: 'queued', dead_at: null, last_error_code: null })])));
    await click(button('絞り込む'));

    expect(listCalls()).toHaveLength(2);
    expect(lastListParams().get('status')).toBe('queued');
    expect(rows()[0].textContent).toContain('送信待ち');
    expect(rows()[0].textContent).toContain('次の試行');
  });

  it('状態の選択肢は 3 つで、既定は届けられなかったもの', async () => {
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['dead', 'queued', 'sent']);
    expect(radios.find((r) => r.checked)?.value).toBe('dead');
  });

  it('文面の名前 (前後の空白を除く) を付けて絞り込む。候補 (datalist) は表示中の行から', async () => {
    const options = Array.from(container.querySelectorAll('#email-outbox-templates option')).map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual(['family_invite']);

    await type('email-outbox-template', '  support_ticket_reply  ');
    await click(button('絞り込む'));

    expect(lastListParams().get('template')).toBe('support_ticket_reply');
    expect(lastListParams().get('status')).toBe('dead');
  });
});

describe('メール送信の画面: 再送', () => {
  it('dead の行にだけ「再送」があり、伏せ字の行は無効で理由を出す', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        page([
          item(3, { redacted: true, recipient: '[redacted]' }),
          item(2),
          item(1, { status: 'sent', sent_at: '2026-10-16T05:00:01Z', dead_at: null, last_error_code: null }),
        ]),
      ),
    );
    await click(button('再読み込み'));

    const [redacted, dead, sent] = rows();
    const redactedButton = buttonsIn(redacted, '再送')[0];
    expect(redactedButton.disabled).toBe(true);
    expect(redacted.textContent).toContain('宛先を伏せた行は再送できません');
    expect(buttonsIn(dead, '再送')[0].disabled).toBe(false);
    expect(buttonsIn(sent, '再送')).toHaveLength(0);
  });

  it('再送の成功で POST し (確認なし)、行を queued に描き替え、role="status" で知らせる', async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: idOf(2), status: 'queued' } }));

    await click(buttonsIn(rows()[0], '再送')[0]);

    expect(requeueCalls()).toHaveLength(1);
    expect(String(requeueCalls()[0][0])).toBe(`/api/super-admin/email-outbox/${idOf(2)}/requeue`);
    expect(requeueCalls()[0][1]).toMatchObject({ method: 'POST' });
    expect(confirmSpy).not.toHaveBeenCalled();
    const first = rows()[0];
    expect(first.textContent).toContain('送信待ち');
    expect(first.textContent).toContain('0 / 1');
    expect(buttonsIn(first, '再送')).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('再送を受け付けました');
    // ほかの行は変えない
    expect(rows()[1].textContent).toContain('届けられなかった');
  });

  it.each([
    [409, { error: { code: 'OP_EMAIL_OUTBOX_NOT_REQUEUEABLE', message: '宛先を伏せた行は再送できません', details: { reason: 'redacted' } } }],
    [404, { error: { code: 'OP_EMAIL_OUTBOX_NOT_FOUND', message: '指定のメールが見つかりません' } }],
  ])('%i は API の説明を出し、行は描き替えない', async (status, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body, status));

    await click(buttonsIn(rows()[0], '再送')[0]);

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(body.error.message);
    expect(rows()[0].textContent).toContain('届けられなかった');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('通信の失敗 (reject) は、再送が済んだか分からないので一覧を読み直し、自分の再送が済んでいたときにも合う文を出す (#2073)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await click(buttonsIn(rows()[0], '再送')[0]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 初回の一覧 + 読み直しの一覧 (表示中の条件で先頭から)
    expect(listCalls()).toHaveLength(2);
    expect(lastListParams().get('status')).toBe('dead');
    expect(lastListParams().has('cursor')).toBe(false);
    expect(container.querySelector('[data-testid="email-outbox-reload-notice"] [role="status"]')?.textContent).toBe(
      '「family_invite」の再送の応答を受け取れませんでした（通信エラー）。一覧を読み込み直したので、今の状態を確かめてから、必要ならもう一度操作してください',
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('メール送信の画面: さらに読み込む', () => {
  it('API が返したカーソルと、検索に使った条件を渡して続きを足す。続きが無くなればボタンを消す', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page([item(4), item(3)], 'cursor-1')));
    await click(button('再読み込み'));
    expect(text()).toContain('(続きあり)');

    await type('email-outbox-template', 'typed-but-not-applied');
    fetchMock.mockResolvedValueOnce(jsonResponse(page([item(2), item(1)])));
    await click(button('さらに読み込む'));

    const params = lastListParams();
    expect(params.get('cursor')).toBe('cursor-1');
    expect(params.get('status')).toBe('dead');
    expect(params.has('template')).toBe(false);
    expect(rows()).toHaveLength(4);
    expect(buttonsIn(container, 'さらに読み込む')).toHaveLength(0);
  });
});
