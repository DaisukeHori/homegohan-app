/**
 * #2195 V4: 機能パッケージ詳細 (/super-admin/feature-packages/[id]) の機能フラグの保存の楽観ロック
 *
 * 以前の画面は、機能フラグの一覧を条件なしで送り、route はそのまま書いていた。画面を開いたあとに機能フラグの作成
 * (POST /api/super-admin/flags) が basic に足したキーは、古い一覧の保存で消えた。
 *
 * 直したあとの画面の不変条件:
 *  - 機能フラグを送る保存は、最後に読んだ・保存した行の updated_at (expected_updated_at) を添える。ほかの欄だけの保存には添えない
 *  - 保存の成功のあとは、応答の行の updated_at が次の保存の条件になる
 *  - 409 CONFLICT_STALE_DATA で断られたら行を読み直し、書きかけ (送った欄を含む) は残し、手を付けていない欄だけ今の値に揃え、
 *    いま保存されている機能フラグと、入力中の一覧に無いもの (別の操作が足したキー) を入力欄の下に出す
 *  - 読み直した行に送った値がもう全部入っていれば (押し直し・自分の 1 回目がもう書いていた)、保存できた扱いにする
 *  - 読み直しが失敗したら、その旨を出す (画面の updated_at は古いままなので、もう一度保存するとまた 409 で読み直す)
 *
 * GET は DB の今の行を返し、PATCH は route と同じ規則 (expected_updated_at があれば、今の updated_at と同じときだけ書き、
 * 書いたら updated_at を新しくする) で答える偽のサーバーで確かめる。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_ID = '21952195-2195-4195-8195-219521952195';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ROW_ID }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: FeaturePackageDetailPage } = await import('@/app/super-admin/feature-packages/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 画面を開いたときの行の updated_at (PostgREST が返す形) */
const OPENED_UPDATED_AT = '2026-11-01T09:30:00.123456+00:00';
/** 別の操作 (機能フラグの作成) が書いたあとの updated_at */
const APPENDED_UPDATED_AT = '2026-11-01T09:31:00.654321+00:00';
/** 画面を開いたあとに機能フラグの作成が basic に足したキー */
const APPENDED_FLAG = 'flag_appended_later';

const FEATURE_PACKAGE = {
  id: ROW_ID,
  package_key: 'basic',
  display_name: '基本機能',
  description: '基本の機能',
  feature_flags: ['flag_a', 'flag_b'],
  display_order: 1,
  status: 'active',
  created_at: '2026-10-01T00:00:00+00:00',
  updated_at: OPENED_UPDATED_AT,
};

const STALE_BODY = {
  error: { code: 'CONFLICT_STALE_DATA', message: '別の操作で機能パッケージが先に変わりました。読み込み直してください' },
};

const SAVE_CONFLICT_RELOADED_MESSAGE =
  '保存できませんでした（別の操作で機能パッケージが先に変わっていました。今の値を読み込み直しました。入力中の欄は残しているので、見比べてから、もう一度保存してください）';
const SAVE_CONFLICT_RELOAD_FAILED_MESSAGE =
  '保存できませんでした（別の操作で機能パッケージが先に変わっていました。今の値を読み込めませんでした。もう一度保存すると、今の値を読み込み直します）';

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
/** 偽のサーバーの今の行 */
let current: Record<string, unknown>;
/** 書くたびに進める updated_at の連番 */
let writeCount = 0;

type FakeServerOptions = {
  /** 最初の PATCH を受ける直前に、別の操作が行へ書く変更 (updated_at も変える) */
  concurrentBeforeFirstPatch?: Record<string, unknown>;
  /** 最初の PATCH は書いてから応答を返さない (通信の reject) */
  rejectFirstPatchAfterWrite?: boolean;
  /** 最初の GET (画面を開いたとき) のあとの GET を 500 にする */
  failRereads?: boolean;
};

/**
 * route と同じ規則の偽のサーバー: PATCH は expected_updated_at があれば今の updated_at と同じときだけ書き (違えば 409)、
 * 書いたら updated_at を新しくして、書いたあとの行を返す。GET は今の行を返す
 */
function fakeServer(options: FakeServerOptions = {}) {
  current = { ...FEATURE_PACKAGE };
  writeCount = 0;
  let patchCount = 0;
  let getCount = 0;
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patchCount += 1;
      if (patchCount === 1 && options.concurrentBeforeFirstPatch) {
        current = { ...current, ...options.concurrentBeforeFirstPatch };
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const { expected_updated_at: expectedUpdatedAt, ...changes } = body;
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== current.updated_at) {
        return jsonResponse(409, STALE_BODY);
      }
      writeCount += 1;
      current = { ...current, ...changes, updated_at: `2026-11-01T10:00:0${writeCount}.000000+00:00` };
      if (patchCount === 1 && options.rejectFirstPatchAfterWrite) throw new TypeError('Failed to fetch');
      return jsonResponse(200, { data: { ...current } });
    }
    getCount += 1;
    if (getCount > 1 && options.failRereads) return jsonResponse(500, { error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } });
    return jsonResponse(200, { data: { ...current } });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const text = () => container.textContent ?? '';
const savedFlagsBox = () => container.querySelector('[data-testid="saved-feature-flags"]');
const missingFlags = () => container.querySelector('[data-testid="saved-feature-flags-missing"]');

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelElement = Array.from(container.querySelectorAll('label')).find((l) => l.textContent === label);
  expect(labelElement, `「${label}」の欄が見つからない`).toBeDefined();
  const element = labelElement!.parentElement!.querySelector('input, textarea');
  expect(element, `「${label}」の入力欄が見つからない`).not.toBeNull();
  return element as HTMLInputElement | HTMLTextAreaElement;
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickSave() {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('保存する'));
  expect(button, '「保存する」ボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
}

async function render() {
  await act(async () => {
    root.render(<FeaturePackageDetailPage />);
  });
  await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
}

beforeEach(() => {
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
  vi.restoreAllMocks();
});

describe('機能フラグの保存は、最後に読んだ・保存した行の updated_at を添える', () => {
  it('機能フラグを変えた保存は expected_updated_at を添え、次の保存は応答の行の updated_at を添える', async () => {
    fakeServer();
    await render();
    await typeInto(field('機能フラグ'), 'flag_a\nflag_b\nflag_c');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    await typeInto(field('機能フラグ'), 'flag_a\nflag_c');
    await clickSave();
    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    expect(patchBodies()).toEqual([
      { feature_flags: ['flag_a', 'flag_b', 'flag_c'], expected_updated_at: OPENED_UPDATED_AT },
      { feature_flags: ['flag_a', 'flag_c'], expected_updated_at: '2026-11-01T10:00:01.000000+00:00' },
    ]);
    expect(current.feature_flags).toEqual(['flag_a', 'flag_c']);
  });

  it('機能フラグを変えない保存には添えない (無関係な変更で 409 にしない)', async () => {
    fakeServer({ concurrentBeforeFirstPatch: { feature_flags: ['flag_a', 'flag_b', APPENDED_FLAG], updated_at: APPENDED_UPDATED_AT } });
    await render();
    await typeInto(field('表示名 *'), '基本機能 (改)');
    await clickSave();

    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(patchBodies()).toEqual([{ display_name: '基本機能 (改)' }]);
    // 別の操作が足したキーは残る
    expect(current.feature_flags).toEqual(['flag_a', 'flag_b', APPENDED_FLAG]);
  });
});

describe('保存が 409 CONFLICT_STALE_DATA で断られたら、読み直して見比べられるようにする', () => {
  it('開いたあとに機能フラグの作成が足したキーを消さず、書きかけの一覧を残し、いま保存されている一覧と足りないキーを出す', async () => {
    fakeServer({ concurrentBeforeFirstPatch: { feature_flags: ['flag_a', 'flag_b', APPENDED_FLAG], updated_at: APPENDED_UPDATED_AT } });
    await render();
    await typeInto(field('機能フラグ'), 'flag_a\nflag_b\nflag_c');
    await clickSave();

    await vi.waitFor(() => expect(text()).toContain(SAVE_CONFLICT_RELOADED_MESSAGE));
    expect(text()).not.toContain('保存しました');
    // 足されたキーは消えていない (書いていない)
    expect(current.feature_flags).toEqual(['flag_a', 'flag_b', APPENDED_FLAG]);
    // 書きかけ (送った一覧) は残す
    expect(field('機能フラグ').value).toBe('flag_a\nflag_b\nflag_c');
    expect(savedFlagsBox()?.textContent).toBe(`いま保存されている機能フラグ: flag_a, flag_b, ${APPENDED_FLAG}入力中の一覧に無いもの: ${APPENDED_FLAG}`);
    expect(missingFlags()?.textContent).toBe(`入力中の一覧に無いもの: ${APPENDED_FLAG}`);

    // 見比べて足したキーを入れ直すと、見比べの欄は消え、次の保存は読み直した行の updated_at を添えて書ける
    await typeInto(field('機能フラグ'), `flag_a\nflag_b\n${APPENDED_FLAG}`);
    expect(savedFlagsBox()).toBeNull();
    await typeInto(field('機能フラグ'), `flag_a\nflag_b\n${APPENDED_FLAG}\nflag_c`);
    expect(missingFlags()).toBeNull();
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(patchBodies()[1]).toEqual({
      feature_flags: ['flag_a', 'flag_b', APPENDED_FLAG, 'flag_c'],
      expected_updated_at: APPENDED_UPDATED_AT,
    });
    expect(current.feature_flags).toEqual(['flag_a', 'flag_b', APPENDED_FLAG, 'flag_c']);
    expect(savedFlagsBox()).toBeNull();
    expect(text()).not.toContain(SAVE_CONFLICT_RELOADED_MESSAGE);
  });

  it('手を付けていない欄は読み直した行の値に揃え、送った欄 (書きかけ) は残す', async () => {
    fakeServer({
      concurrentBeforeFirstPatch: {
        display_order: 7,
        feature_flags: ['flag_a', 'flag_b', APPENDED_FLAG],
        updated_at: APPENDED_UPDATED_AT,
      },
    });
    await render();
    await typeInto(field('説明'), '書きかけの説明');
    await typeInto(field('機能フラグ'), 'flag_a');
    await clickSave();

    await vi.waitFor(() => expect(text()).toContain(SAVE_CONFLICT_RELOADED_MESSAGE));
    expect(field('表示順').value).toBe('7');
    expect(field('説明').value).toBe('書きかけの説明');
    expect(field('機能フラグ').value).toBe('flag_a');
    expect(missingFlags()?.textContent).toBe(`入力中の一覧に無いもの: flag_b, ${APPENDED_FLAG}`);
  });

  it('保存の応答を受け取れずに押し直した (1 回目がもう書いていた) ときは、409 でも「別の操作で」と言わず保存できた扱いにする', async () => {
    fakeServer({ rejectFirstPatchAfterWrite: true });
    await render();
    await typeInto(field('機能フラグ'), 'flag_a\nflag_c');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存の応答を受け取れませんでした'));

    await clickSave();

    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(patchBodies()).toHaveLength(2);
    expect(text()).not.toContain('別の操作で');
    expect(savedFlagsBox()).toBeNull();
    expect(field('機能フラグ').value).toBe('flag_a\nflag_c');
    // 書いたのは 1 回だけ
    expect(writeCount).toBe(1);
  });

  it('読み直しが失敗したら、その旨を出し、もう一度保存するとまた 409 で読み直す (古い一覧で書かない)', async () => {
    fakeServer({
      concurrentBeforeFirstPatch: { feature_flags: ['flag_a', 'flag_b', APPENDED_FLAG], updated_at: APPENDED_UPDATED_AT },
      failRereads: true,
    });
    await render();
    await typeInto(field('機能フラグ'), 'flag_a');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain(SAVE_CONFLICT_RELOAD_FAILED_MESSAGE));

    await clickSave();
    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    await vi.waitFor(() => expect(text()).toContain(SAVE_CONFLICT_RELOAD_FAILED_MESSAGE));
    expect(patchBodies()[1]).toEqual({ feature_flags: ['flag_a'], expected_updated_at: OPENED_UPDATED_AT });
    expect(current.feature_flags).toEqual(['flag_a', 'flag_b', APPENDED_FLAG]);
    expect(writeCount).toBe(0);
  });
});
