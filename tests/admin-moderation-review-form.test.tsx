/**
 * #1101 個別審査画面 (/admin/moderation/{type}/{id}) の審査フォーム (ModerationReviewForm)
 *
 * 以前はサーバーコンポーネントの <form method="POST" action="/api/admin/moderation/..."> だった。ブラウザは本文を
 * application/x-www-form-urlencoded で送るが、API は JSON (request.json()) だけを受けるため、「審査を確定」を押すたびに
 * 400 INVALID_JSON になり、審査を確定できなかった。
 *
 * 確認すること:
 *   - 本文は JSON (Content-Type: application/json) で POST する。ban_duration_days は一時 BAN のときだけ (数値で)、
 *     resolution_note は入力があるときだけ付ける (空文字は API の検証で 400 になる)
 *   - 入力の誤り (アクション未選択・BAN 期間の範囲外) は送らずに画面で知らせる
 *   - 成功したら結果を表示し、左側の状態表示を更新する (router.refresh)
 *   - 失敗 (コンテンツを隠せなかった 500 OP_CONTENT_HIDE_FAILED など) は API の文面を出し、フォームを閉じない。
 *     隠せなかったとき API は判定を保存しない (pending のまま) ので、画面を開き直してもフォームが出て、やり直せる
 *   - 送信中は二重に送れない
 *   - 審査済み (pending 以外) ではフォームを出さない。永久 BAN の選択肢は super_admin だけ
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/admin-finance-refund-dialog.test.tsx と同じ方法)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: ModerationReviewForm } = await import('@/components/operator/moderation/ModerationReviewForm');
const { ModerationActions, ModerationDeleteActions, isModerationDeleteAction } = await import('@/lib/admin/moderation-schemas');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUBMIT_BUTTON = '審査を確定';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

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

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

function fieldByLabel(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const labelEl = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.includes(label));
  expect(labelEl, `${label} のラベルが見つからない`).toBeDefined();
  return document.getElementById(labelEl!.htmlFor) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectAction(value: string) {
  const select = fieldByLabel('アクション') as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function submit() {
  const button = buttonByText(SUBMIT_BUTTON);
  expect(button, '審査を確定のボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
}

function optionValues(): string[] {
  return Array.from((fieldByLabel('アクション') as HTMLSelectElement).options).map((o) => o.value);
}

/** 直近の fetch 呼び出しの [URL, 送った JSON] */
function lastCall(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

async function renderForm(props: Partial<React.ComponentProps<typeof ModerationReviewForm>> = {}) {
  await act(async () => {
    root.render(<ModerationReviewForm type="food" id="flag-1" status="pending" isSuperAdmin={false} {...props} />);
  });
}

beforeEach(() => {
  refreshMock.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ModerationReviewForm: 送る内容', () => {
  it('JSON で POST する (urlencoded ではない)。承認なら本文は { action } だけ', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, status: 'approved', ban_applied: null } }));
    await renderForm();

    await selectAction('approve');
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = lastCall();
    expect(url).toBe('/api/admin/moderation/food/flag-1');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(body).toEqual({ action: 'approve' });
  });

  it('削除 + 一時 BAN: ban_duration_days を数値で、解決メモは前後の空白を除いて送る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, status: 'rejected', ban_applied: true } }));
    await renderForm();

    await selectAction('delete_and_temp_ban');
    await typeInto(fieldByLabel('BAN 期間') as HTMLInputElement, '14');
    await typeInto(fieldByLabel('解決メモ') as HTMLTextAreaElement, '  規約違反の画像  ');
    await submit();

    expect(lastCall().body).toEqual({
      action: 'delete_and_temp_ban',
      ban_duration_days: 14,
      resolution_note: '規約違反の画像',
    });
  });

  it('一時 BAN 以外では BAN 期間の入力欄を出さず、ban_duration_days も送らない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, status: 'rejected', ban_applied: null } }));
    await renderForm();

    await selectAction('delete_and_temp_ban');
    expect(document.getElementById('ban_duration_days')).not.toBeNull();

    await selectAction('delete_only');
    expect(document.getElementById('ban_duration_days')).toBeNull();
    await submit();

    expect(lastCall().body).toEqual({ action: 'delete_only' });
  });

  it('解決メモが空 (空白だけ) のときは resolution_note を送らない (空文字は API が 400 にする)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, status: 'escalated', ban_applied: null } }));
    await renderForm();

    await selectAction('escalate');
    await typeInto(fieldByLabel('解決メモ') as HTMLTextAreaElement, '   ');
    await submit();

    expect(lastCall().body).toEqual({ action: 'escalate' });
  });

  it('type と id は URL に安全に埋め込む (recipe の通報)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, status: 'approved', ban_applied: null } }));
    await renderForm({ type: 'recipe', id: 'a/b c' });

    await selectAction('approve');
    await submit();

    expect(lastCall().url).toBe('/api/admin/moderation/recipe/a%2Fb%20c');
  });
});

describe('ModerationReviewForm: 入力の誤り (送らずに画面で知らせる)', () => {
  it('アクションを選ばずに確定すると、送らずにエラーを出す', async () => {
    await renderForm();

    await submit();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('アクションを選択してください');
  });

  it.each(['0', '366', '1.5', ''])('BAN 期間が %j のときは送らずにエラーを出す', async (days) => {
    await renderForm();

    await selectAction('delete_and_temp_ban');
    await typeInto(fieldByLabel('BAN 期間') as HTMLInputElement, days);
    await submit();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('BAN 期間は 1〜365');
  });

  it('解決メモが 5000 文字を超えるときは送らずにエラーを出す', async () => {
    await renderForm();

    await selectAction('approve');
    await typeInto(fieldByLabel('解決メモ') as HTMLTextAreaElement, 'x'.repeat(5001));
    await submit();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('5000 文字以内');
  });
});

describe('ModerationReviewForm: 結果の表示', () => {
  it('成功したら、結果 (ステータス・BAN) を表示し、左側の状態表示を更新する。フォームは閉じて一覧への導線を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, status: 'rejected', ban_applied: true } }));
    await renderForm({ isSuperAdmin: true });

    await selectAction('delete_and_perm_ban');
    await submit();

    expect(document.querySelector('[role="status"]')?.textContent).toContain('審査を確定しました');
    expect(allText()).toContain('投稿者を BAN しました');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(buttonByText(SUBMIT_BUTTON)).toBeUndefined();
    expect(document.querySelector('a[href="/admin/moderation"]')).not.toBeNull();
  });

  it('コンテンツを隠せなかった (判定は保存しない 500 OP_CONTENT_HIDE_FAILED) ときは、API の文面を出し、フォームを閉じない。成功表示も refresh もしない', async () => {
    const message =
      'コンテンツを非表示にできませんでした。モデレーション判定はまだ保存していません (審査待ちのままです)。もう一度同じ操作を実行してください。';
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: { code: 'OP_CONTENT_HIDE_FAILED', message },
        data: { status: 'pending', content_hidden: false, ban_applied: null },
      }),
    );
    await renderForm();

    await selectAction('delete_only');
    await submit();

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(refreshMock).not.toHaveBeenCalled();
    // 同じ操作をもう一度実行できる
    expect(buttonByText(SUBMIT_BUTTON)?.disabled).toBe(false);
    expect((fieldByLabel('アクション') as HTMLSelectElement).value).toBe('delete_only');
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, status: 'rejected', ban_applied: null } }));
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('審査を確定しました');
  });

  it.each([
    { status: 403, body: { error: { code: 'OP_PERMISSION_DENIED', message: '永久 BAN は super_admin のみ実行可能です' } }, text: '永久 BAN は super_admin のみ' },
    { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー' } }, text: 'バリデーションエラー' },
    { status: 404, body: { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } }, text: 'モデレーションアイテムが見つかりません' },
    { status: 422, body: { error: { code: 'OP_BAN_TARGET_UNRESOLVED', message: 'BAN 対象ユーザーを特定できませんでした' } }, text: 'BAN 対象ユーザーを特定できませんでした' },
  ])('HTTP $status は API の文面を出す', async ({ status, body, text }) => {
    fetchMock.mockResolvedValue(jsonResponse(status, body));
    await renderForm();

    await selectAction('approve');
    await submit();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(text);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('401 はログインし直す案内。本文が JSON でない失敗は HTTP ステータスを添えた案内', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }));
    await renderForm();
    await selectAction('approve');
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('ログインし直してください');

    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) });
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 502');
  });

  it('通信に失敗したら (fetch が reject)、エラーを出してフォームを残す', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderForm();

    await selectAction('approve');
    await submit();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('通信に失敗しました');
    expect(buttonByText(SUBMIT_BUTTON)?.disabled).toBe(false);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('送信中は二重に送れない (ボタンが無効になり、fetch は 1 回だけ)', async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValue(pending.promise);
    await renderForm();

    await selectAction('approve');
    await submit();
    expect(buttonByText('確定中')?.disabled).toBe(true);
    // 送信中にもう一度押しても、送らない
    await act(async () => {
      buttonByText('確定中')!.click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(jsonResponse(200, { data: { success: true, status: 'approved', ban_applied: null } }));
    });
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ModerationReviewForm: 表示', () => {
  it('コンテンツを隠せなかったあとで画面を開き直したとき (API は判定を保存せず、通報は pending のまま) は、フォームが出て、同じ操作をやり直せる', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, {
        error: { code: 'OP_CONTENT_HIDE_FAILED', message: 'コンテンツを非表示にできませんでした。' },
        data: { status: 'pending', content_hidden: false, ban_applied: null },
      }),
    );
    await renderForm();
    await selectAction('delete_only');
    await submit();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    // 開き直し: ページは DB の status (= API が返した pending) を渡して描き直す
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderForm({ status: 'pending' });

    expect(document.querySelector('form')).not.toBeNull();
    expect(allText()).not.toContain('このアイテムは既に審査済みです');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { success: true, status: 'rejected', ban_applied: null } }));
    await selectAction('delete_only');
    await submit();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('審査を確定しました');
  });

  it('審査済み (pending 以外) ではフォームを出さず、ステータスを表示する', async () => {
    await renderForm({ status: 'rejected' });

    expect(allText()).toContain('このアイテムは既に審査済みです');
    expect(allText()).toContain('rejected');
    expect(document.querySelector('form')).toBeNull();
  });

  it('永久 BAN の選択肢は super_admin だけ', async () => {
    await renderForm({ isSuperAdmin: false });
    expect(optionValues()).toEqual(['', 'approve', 'delete_only', 'delete_and_warn', 'delete_and_temp_ban', 'escalate']);

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderForm({ isSuperAdmin: true });
    expect(optionValues()).toContain('delete_and_perm_ban');
  });

  it('「削除」を選ぶと、他のユーザーから見えなくなる (本人には見える・保管される) 説明が出る。承認・エスカレーションでは出ない', async () => {
    // API が「コンテンツを隠す」アクション (moderation-schemas の ModerationDeleteActions) と、画面の説明が食い違わないこと
    await renderForm({ isSuperAdmin: true });

    for (const action of ModerationDeleteActions) {
      await selectAction(action);
      expect(allText(), action).toContain('他のユーザー (家族を含む) から見えなくなります');
      expect(allText(), action).toContain('保管されます');
    }
    for (const action of ModerationActions.filter((a) => !isModerationDeleteAction(a))) {
      await selectAction(action);
      expect(allText(), action).not.toContain('他のユーザー (家族を含む) から見えなくなります');
    }
  });

  it('食事 (food) の「削除」では、家族への貼り付けで作られた同じ中身 (写真とメモ) の複製も見えなくなることを説明する。レシピ (recipe) には複製が無いので出さない', async () => {
    await renderForm({ type: 'food' });
    await selectAction('delete_only');
    expect(allText()).toContain('家族への貼り付けで作られた複製のうち、写真とメモが同じものも');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderForm({ type: 'recipe' });
    await selectAction('delete_only');
    expect(allText()).toContain('他のユーザー (家族を含む) から見えなくなります');
    expect(allText()).not.toContain('家族への貼り付け');
  });

  it('画面の選択肢は、API が受け付けるアクションと一致する', async () => {
    await renderForm({ isSuperAdmin: true });

    expect(optionValues().filter((v) => v !== '')).toEqual([...ModerationActions]);
  });

  it('API に直接 POST するよう案内する古い注意書きと、urlencoded で送るフォームの属性が残っていない', async () => {
    await renderForm();

    expect(allText()).not.toContain('直接呼び出してください');
    const form = document.querySelector('form')!;
    expect(form.getAttribute('action')).toBeNull();
    expect(form.getAttribute('method')).toBeNull();
  });
});
