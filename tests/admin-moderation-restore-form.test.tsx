/**
 * #1538 個別審査画面 (/admin/moderation/{type}/{id}) の「非表示の解除」のカード (ModerationRestoreForm)
 * 設計: docs/design/operator/13-hidden-content-restore.md §9.2・§13.2 (F-1〜F-7)
 *
 * 確認すること:
 *   F-1 理由を JSON で POST し、成功したら結果 (n 行・BAN の 1 文) を出して router.refresh()。refresh の後の形で描き直しても結果が残る
 *   F-2 理由が空・空白だけ・5000 字超は送らずに知らせる
 *   F-3 409 / 410 は API の文面を出して refresh、500 は欄を残して refresh しない、401 はログインし直す案内、JSON でない失敗・通信の失敗の案内
 *   F-4 送信中は二重に送れない
 *   F-5 戻せる期間を過ぎていたら案内だけ (理由の欄とボタンは無い)
 *   F-6 隠した日時は JST。food では複製の説明を出し recipe では出さない。type と id は URL に安全に埋め込む
 *   F-7 隠れていなくて結果も失敗の文も無いときは何も描かない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/admin-moderation-review-form.test.tsx と同じ方法)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

const { default: ModerationRestoreForm } = await import('@/components/operator/moderation/ModerationRestoreForm');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUBMIT_BUTTON = '表示に戻す';
const CARD_TITLE = '非表示の解除';
/** 画面の理由の長さの上限 (設計 §9.2。schemas の MODERATION_NOTE_MAX_LENGTH と同じ値は CT-3 が見る) */
const NOTE_MAX = 5000;
const HIDDEN_AT = '2026-10-15T01:02:03.000Z';
const HIDDEN_AT_JST = '2026/10/15 10:02:03';
const BAN_SENTENCE = '投稿者を BAN している場合、BAN はこの操作では解除されません';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

type Props = React.ComponentProps<typeof ModerationRestoreForm>;

const BASE_PROPS: Props = {
  type: 'food',
  id: 'flag-1',
  hiddenAt: HIDDEN_AT,
  restorable: true,
  restoreWindowDays: 89,
  retentionDays: 90,
};

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

function noteField(): HTMLTextAreaElement {
  return document.getElementById('restore_note') as HTMLTextAreaElement;
}

async function typeNote(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(noteField(), value);
    noteField().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  const button = buttonByText(SUBMIT_BUTTON);
  expect(button, '表示に戻すのボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
}

/** 直近の fetch 呼び出しの [URL, 送った JSON] */
function lastCall(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

function element(props: Partial<Props> = {}) {
  return <ModerationRestoreForm key="restore:food:flag-1" {...BASE_PROPS} {...props} />;
}

async function renderForm(props: Partial<Props> = {}) {
  await act(async () => {
    root.render(element(props));
  });
}

/** 親が refresh のあとに、同じ位置・同じ key のまま props だけ変えて描き直した形 */
async function rerenderForm(props: Partial<Props>) {
  await act(async () => {
    root.render(element(props));
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

describe('ModerationRestoreForm: 送る内容と成功 (F-1)', () => {
  it('F-1: 理由 (前後の空白を除く) を JSON で POST し、成功したら「表示に戻しました (n 行)」と BAN の 1 文を出して refresh する。refresh の後の形で描き直しても残る', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { success: true, content_hidden: false, restored_ids: ['m1', 'm2', 'm3'], approved_flag_ids: ['f1'] } }),
    );
    await renderForm();

    await typeNote('  申し立てを確認。規約違反ではなかった  ');
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = lastCall();
    expect(url).toBe('/api/admin/moderation/food/flag-1/restore');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(body).toEqual({ restore_note: '申し立てを確認。規約違反ではなかった' });

    expect(allText()).toContain('表示に戻しました (3 行)');
    expect(allText()).toContain(BAN_SENTENCE);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    // 成功のあとは理由の欄とボタンを出さない
    expect(noteField()).toBeNull();
    expect(buttonByText(SUBMIT_BUTTON)).toBeUndefined();

    // 親が refresh の後の形 (hiddenAt = null・restorable = false・同じ key) で描き直しても、結果が残る
    await rerenderForm({ hiddenAt: null, restorable: false });
    expect(allText()).toContain(CARD_TITLE);
    expect(allText()).toContain('表示に戻しました (3 行)');
    expect(allText()).toContain(BAN_SENTENCE);
  });

  it('F-1: restored_ids が配列でない応答でも 1 行として表示する', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true } }));
    await renderForm();

    await typeNote('理由');
    await submit();

    expect(allText()).toContain('表示に戻しました (1 行)');
  });
});

describe('ModerationRestoreForm: 入力の誤り (F-2)', () => {
  it('F-2: 理由が空・空白だけは送らずに知らせる', async () => {
    await renderForm();

    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allText()).toContain('戻す理由を入力してください');

    await typeNote('   ');
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allText()).toContain('戻す理由を入力してください');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('F-2: 5000 字ちょうどは送り、5001 字は送らずに知らせる', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, restored_ids: ['m1'] } }));
    await renderForm();

    await typeNote('あ'.repeat(NOTE_MAX + 1));
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allText()).toContain(`戻す理由は ${NOTE_MAX} 文字以内で入力してください`);

    await typeNote('あ'.repeat(NOTE_MAX));
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((lastCall().body.restore_note as string).length).toBe(NOTE_MAX);
  });
});

describe('ModerationRestoreForm: 失敗 (F-3)', () => {
  it('F-3: 409 OP_CONTENT_NOT_HIDDEN は API の文面を出して refresh する。親が hiddenAt = null で描き直しても文面 (role=alert) が残る', async () => {
    const message = 'このコンテンツはすでに表示されています';
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'OP_CONTENT_NOT_HIDDEN', message } }));
    await renderForm();

    await typeNote('理由');
    await submit();

    expect(allText()).toContain(message);
    expect(refreshMock).toHaveBeenCalledTimes(1);

    await rerenderForm({ hiddenAt: null, restorable: false });
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(message);
    expect(allText()).toContain(CARD_TITLE);
  });

  it('F-3: 410 も API の文面を出して refresh する', async () => {
    const message = 'コンテンツはすでに削除されています';
    fetchMock.mockResolvedValue(jsonResponse(410, { error: { code: 'OP_CONTENT_GONE', message } }));
    await renderForm();

    await typeNote('理由');
    await submit();

    expect(allText()).toContain(message);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('F-3: 500 は API の文面を出して欄を残し (もう一度押せる)、refresh しない', async () => {
    const message = '通報の状態を更新できませんでした。コンテンツはまだ非表示のままです。もう一度同じ操作を実行してください';
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message } }));
    await renderForm();

    await typeNote('理由');
    await submit();

    expect(allText()).toContain(message);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(noteField()).not.toBeNull();
    expect(noteField().value).toBe('理由');
    expect(buttonByText(SUBMIT_BUTTON)?.disabled).toBe(false);
  });

  it('F-3: 401 はログインし直す案内 (API の文面は使わない)・refresh しない', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'AUTH_UNAUTHENTICATED', message: 'unauthenticated' } }));
    await renderForm();

    await typeNote('理由');
    await submit();

    // 401 は運営の画面で揃えた「ログインし直してください」(#2112 Z4)
    expect(allText()).toContain('ログインし直してください');
    expect(allText()).not.toContain('ログインの有効期限');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('F-3: 本文が JSON でない失敗は HTTP ステータスを添えた案内', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) });
    await renderForm();

    await typeNote('理由');
    await submit();

    expect(allText()).toContain('表示に戻せませんでした (HTTP 502)。もう一度お試しください');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('F-3: 通信の失敗は案内を出し、欄を残す', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await renderForm();

    await typeNote('理由');
    await submit();

    expect(allText()).toContain('通信に失敗しました');
    expect(allText()).toContain('ページを開き直して状態を確認してください');
    expect(noteField()).not.toBeNull();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('ModerationRestoreForm: 送信中 (F-4)', () => {
  it('F-4: 送信中は二重に送れない (ボタンが無効・fetch は 1 回)', async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValue(pending.promise);
    await renderForm();

    await typeNote('理由');
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const busyButton = buttonByText('戻しています');
    expect(busyButton, '送信中のボタンが見つからない').toBeDefined();
    expect(busyButton!.disabled).toBe(true);
    expect(noteField().disabled).toBe(true);

    // 無効のボタンを押しても (フォームの submit を直接起こしても) 2 回目は送らない
    await act(async () => {
      busyButton!.click();
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(jsonResponse(200, { data: { success: true, restored_ids: ['m1'] } }));
    });
    expect(allText()).toContain('表示に戻しました (1 行)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ModerationRestoreForm: 戻せる期間を過ぎた (F-5)', () => {
  it('F-5: hiddenAt があり restorable が false なら、見出しと 89 日・90 日の案内だけ (理由の欄とボタンは無い)', async () => {
    await renderForm({ restorable: false });

    expect(allText()).toContain(CARD_TITLE);
    expect(allText()).toContain('隠してから 89 日を過ぎたため戻せません');
    expect(allText()).toContain('保管期間 (90 日)');
    expect(allText()).toContain(`隠した日時: ${HIDDEN_AT_JST}`);
    expect(noteField()).toBeNull();
    expect(buttonByText(SUBMIT_BUTTON)).toBeUndefined();
    expect(document.querySelector('form')).toBeNull();
  });
});

describe('ModerationRestoreForm: 表示 (F-6)', () => {
  it('F-6: 隠した日時を JST (Asia/Tokyo) で表示する', async () => {
    await renderForm();

    expect(allText()).toContain(`隠した日時: ${new Date(HIDDEN_AT).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
    expect(allText()).toContain(`隠した日時: ${HIDDEN_AT_JST}`);
    // 「監査ログに残ります」の注記と理由の必須の印
    expect(allText()).toContain('この操作は admin_audit_logs に記録されます。');
    expect(document.querySelector('label[for="restore_note"]')?.textContent).toContain('戻す理由');
  });

  it('F-6: food では複製も一緒に戻る説明を出し、recipe では出さない', async () => {
    await renderForm({ type: 'food' });
    expect(allText()).toContain('家族への貼り付けの複製のうち');

    await renderForm({ type: 'recipe' });
    expect(allText()).not.toContain('家族への貼り付けの複製のうち');
    expect(allText()).toContain('却下 (削除) にした通報は「承認」に変わります。');
  });

  it('F-6: type と id は URL に安全に埋め込む (recipe の通報)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { success: true, restored_ids: ['r1'] } }));
    await renderForm({ type: 'recipe', id: 'a/b c' });

    await typeNote('理由');
    await submit();

    expect(lastCall().url).toBe('/api/admin/moderation/recipe/a%2Fb%20c/restore');
  });
});

describe('ModerationRestoreForm: 隠れていないとき (F-7)', () => {
  it('F-7: hiddenAt が null で、結果の表示も失敗の文も無いときは何も描かない (見出しも無い)', async () => {
    await renderForm({ hiddenAt: null, restorable: false });

    expect(container.innerHTML).toBe('');
    expect(allText()).not.toContain(CARD_TITLE);
  });
});
