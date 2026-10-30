/**
 * #2128 V2: 作成・記録の応答を受け取れなかったあと (と記録の応答が届いたとき)、入力を空にするか決める比べ方を「保存される値」でそろえる
 *
 * お知らせ (admin/announcements):
 *   以前の画面は、「確かめ直す」で済んでいたと分かったとき、入力欄を送ったときの入力とそのまま (===) 比べた。
 *   送るのは前後の空白を除いたタイトル・本文なので、送信を止めているあいだに前後の空白・改行だけを足すと、保存されていたと分かっても
 *   入力が残り、そのまま「作成する」を押し直すと同じ内容のお知らせが 2 件できる (公開なら利用者のホームに 2 件並ぶ)。
 *   直したあと (不変条件。問い合わせの返信 (#2120 W4・isReplyInputAsSent) と同じ規則):
 *     - タイトル・本文の前後の空白・改行だけの違いは書き足しと見なさず、済んでいたら空にする
 *     - 文の中の書き換え・公開の設定の切り替えは書き換えとして残す (#2107 Y7)
 *
 * DR 訓練の記録 (super-admin/backups) (同じ型):
 *   送る本文では R2 のキーの前後の空白を除くので、R2 のキーの前後の空白だけの違いは、押し直すと同じ記録がもう 1 行できる入力。
 *   直したあと: いまの入力から作る本文が送った本文と同じなら初めに戻す (読み直しの経路・記録の応答 (201) が届いた経路の両方)。
 *   メモは入力のまま送って保存するので、前後の空白の違いも書き換えとして残す。
 *
 * 営業の活動 (admin/sales/[id]) は、内容・次のアクションを入力のまま送って route も入力のまま保存する (createActivitySchema は
 * details を検証だけして書く) ので、完全一致のままで保存される値と比べ方が整合している (このファイルでは扱わない)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DR_TEST_AUDIT_ACTIONS,
  DR_TEST_AUDIT_TARGET_TYPE,
  SUPER_ADMIN_BACKUPS_API_PATH,
  SUPER_ADMIN_DR_TESTS_API_PATH,
  type BackupAuditRow,
} from '@/lib/backups/core';
import { jstToday } from '@/lib/jst-day-ranges';

vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined }),
  usePathname: () => '/admin/announcements',
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: AnnouncementsManager } = await import('@/app/admin/announcements/AnnouncementsManager');
const { default: SuperAdminBackupsPage } = await import('@/app/super-admin/backups/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_GATEWAY_TIMEOUT = 504;

/** 本文が JSON でない失敗の応答 (手前のプロキシ・ホスティングの応答) */
const proxyResponse = (status: number) =>
  new Response('<html><body>Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, element));
  });
  await settle();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** input / textarea に値を入れる (React の onChange を通す) */
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(element).not.toBeNull();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm(form: HTMLFormElement | null) {
  expect(form).not.toBeNull();
  await act(async () => {
    form!.requestSubmit();
  });
  await settle();
}

const text = () => container.textContent ?? '';
const methodOf = (init: unknown) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
const postCount = () => fetchMock.mock.calls.filter(([, init]) => methodOf(init) === 'POST').length;

/** あとから解決する応答 (記録の応答を待つあいだに入力を書き換える筋書きに使う) */
function deferredResponse() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function resolveWith(pending: ReturnType<typeof deferredResponse>, response: Response) {
  await act(async () => {
    pending.resolve(response);
  });
  await settle();
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

// ─────────────────────────────────────────────────────────────────────────────
// お知らせ (/admin/announcements)
// ─────────────────────────────────────────────────────────────────────────────

const ANN_TITLE = '年末年始のお知らせ';
const ANN_CONTENT = '12/29〜1/3 はお休みです';
const ANN_FOUND_TEXT = '読み込み直したところ、お知らせは保存されていました';

function announcementRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: ANN_TITLE,
    content: ANN_CONTENT,
    is_public: false,
    published_at: null,
    created_at: '2026-10-31T01:00:00.000Z',
    ...overrides,
  };
}

const OLD_ANNOUNCEMENT = announcementRow('ann-old', { title: '前のお知らせ', content: '前の本文' });
const CREATED_ANNOUNCEMENT = announcementRow('ann-new', { created_at: '2026-10-31T02:00:00.000Z' });

const annTitleInput = () => container.querySelector<HTMLInputElement>('#announcement-title');
const annContentInput = () => container.querySelector<HTMLTextAreaElement>('#announcement-content');
const annIsPublic = () => container.querySelector<HTMLInputElement>('#announcement-is-public');

/** 送ったタイトル・本文 (POST の本文から読む) */
function sentAnnouncementBodies(): Array<{ title: string; content: string; isPublic: boolean }> {
  return fetchMock.mock.calls
    .filter(([, init]) => methodOf(init) === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { title: string; content: string; isPublic: boolean });
}

/**
 * タイトル・本文を入れて作成を押し、応答 (本文の無い 504) を受け取れず、読み直しでもまだ見つからずに送信を止めたところまで進める。
 * 読み直しの 3 回目 (「確かめ直す」) で、作成したお知らせが一覧に現れる
 */
async function createAnnouncementWithNoResponse(title: string, content: string) {
  let gets = 0;
  const lists = [[OLD_ANNOUNCEMENT], [OLD_ANNOUNCEMENT], [CREATED_ANNOUNCEMENT, OLD_ANNOUNCEMENT]];
  fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') return proxyResponse(HTTP_GATEWAY_TIMEOUT);
    const entry = lists[Math.min(gets, lists.length - 1)];
    gets += 1;
    return jsonResponse(HTTP_OK, { announcements: entry });
  });
  vi.stubGlobal('fetch', fetchMock);
  await renderElement(createElement(AnnouncementsManager));
  await typeInto(annTitleInput(), title);
  await typeInto(annContentInput(), content);
  await submitForm(container.querySelector('form'));
  expect(findButton('確かめ直す')).toBeDefined();
  expect(findButton('作成する')?.disabled).toBe(true);
}

describe('お知らせの作成: 確かめ直しで済んでいたと分かったら、前後の空白・改行だけの違いは書き足しと見なさない (#2128 V2)', () => {
  it('止めているあいだにタイトル・本文の前後へ空白・改行だけを足しても、済んでいたと分かったら空にし、押し直しても 2 件目を送らない', async () => {
    await createAnnouncementWithNoResponse(ANN_TITLE, ANN_CONTENT);
    await typeInto(annTitleInput(), ` ${ANN_TITLE}　`);
    await typeInto(annContentInput(), `\n${ANN_CONTENT}\n\n  `);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(text()).toContain(ANN_FOUND_TEXT);
    expect(annTitleInput()!.value).toBe('');
    expect(annContentInput()!.value).toBe('');
    expect(annIsPublic()!.checked).toBe(false);
    expect(findButton('作成する')?.disabled).toBe(false);

    // 空になったので、そのまま押し直しても同じ内容のお知らせは送られない
    await click(findButton('作成する'), '「作成する」ボタン');
    expect(postCount()).toBe(1);
    expect(sentAnnouncementBodies()).toEqual([{ title: ANN_TITLE, content: ANN_CONTENT, isPublic: false }]);
  });

  it('送ったときの入力の前後に空白・改行があり、止めているあいだにそれを消しても、済んでいたと分かったら空にする', async () => {
    await createAnnouncementWithNoResponse(`  ${ANN_TITLE}`, `${ANN_CONTENT}\n`);
    // 送るのは前後の空白を除いた値 (読み直しの一覧の行と同じ値)
    expect(sentAnnouncementBodies()).toEqual([{ title: ANN_TITLE, content: ANN_CONTENT, isPublic: false }]);
    await typeInto(annTitleInput(), ANN_TITLE);
    await typeInto(annContentInput(), ANN_CONTENT);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(text()).toContain(ANN_FOUND_TEXT);
    expect(annTitleInput()!.value).toBe('');
    expect(annContentInput()!.value).toBe('');
  });

  it('文の中に空白を足した (前後ではない) 書き換えは、済んでいたと分かっても残す', async () => {
    await createAnnouncementWithNoResponse(ANN_TITLE, ANN_CONTENT);
    const rewrittenTitle = '年末年始の お知らせ';
    await typeInto(annTitleInput(), rewrittenTitle);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(text()).toContain(ANN_FOUND_TEXT);
    expect(annTitleInput()!.value).toBe(rewrittenTitle);
    expect(annContentInput()!.value).toBe(ANN_CONTENT);
  });

  it('前後に空白を足して文も書き足した本文は、済んでいたと分かっても残す', async () => {
    await createAnnouncementWithNoResponse(ANN_TITLE, ANN_CONTENT);
    const rewritten = `  ${ANN_CONTENT}\n1/4 から通常どおりです\n`;
    await typeInto(annContentInput(), rewritten);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(text()).toContain(ANN_FOUND_TEXT);
    expect(annContentInput()!.value).toBe(rewritten);
    expect(annTitleInput()!.value).toBe(ANN_TITLE);
  });

  it('前後に空白を足して「公開する」も切り替えたら、公開の設定は書き換えとして入力をすべて残す', async () => {
    await createAnnouncementWithNoResponse(ANN_TITLE, ANN_CONTENT);
    await typeInto(annTitleInput(), `${ANN_TITLE} `);
    await click(annIsPublic() ?? undefined, '「公開する」のチェック');

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(text()).toContain(ANN_FOUND_TEXT);
    expect(annTitleInput()!.value).toBe(`${ANN_TITLE} `);
    expect(annContentInput()!.value).toBe(ANN_CONTENT);
    expect(annIsPublic()!.checked).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DR 訓練の記録 (/super-admin/backups)
// ─────────────────────────────────────────────────────────────────────────────

const SUPER_ADMIN_ID = '21282128-1111-4111-8111-111111111111';
const DR_NOTES = 'pitr ok';
const DR_BACKUP_KEY = 'daily/2026-10-31.dump';
const DR_FOUND_TEXT = '読み込み直したところ、DR 訓練の記録は保存されていました';

function drRow(id: string, details: Record<string, unknown>): BackupAuditRow {
  return {
    id,
    created_at: '2026-10-31T02:00:00.000Z',
    action_type: DR_TEST_AUDIT_ACTIONS.monthly_pitr,
    target_type: DR_TEST_AUDIT_TARGET_TYPE,
    actor_id: SUPER_ADMIN_ID,
    severity: 'info',
    details,
  };
}

/** 画面の初めの入力のまま、メモと R2 のキーだけを入れて送ったときの本文 (toRequestBody の形) */
function sentDrBody(): Record<string, unknown> {
  return {
    kind: 'monthly_pitr',
    result: 'success',
    performed_on: jstToday(),
    environment: 'local',
    restored_to: null,
    backup_key: DR_BACKUP_KEY,
    rto_minutes: null,
    smoke: 'passed',
    notes: DR_NOTES,
  };
}

const OLD_DR = drRow('21282128-2222-4222-8222-000000000001', { ...sentDrBody(), performed_on: '2026-09-01', backup_key: null, notes: '' });
const CREATED_DR = drRow('21282128-2222-4222-8222-000000000002', sentDrBody());

function backupsBody(drTests: readonly BackupAuditRow[]) {
  return {
    data: {
      latest: { daily: null, weekly: null, annual: null },
      latest_dr_tests: { monthly_pitr: drTests[0] ?? null, quarterly_restore: null, annual_drill: null },
      stale: false,
      stale_after_hours: 36,
      backups: [],
      dr_tests: drTests,
    },
  };
}

const drForm = () => container.querySelector<HTMLFormElement>('[data-testid="dr-test-form"]');
const drNotes = () => container.querySelector<HTMLInputElement>('#dr-test-notes');
const drBackupKey = () => container.querySelector<HTMLInputElement>('#dr-test-backup_key');

/** メモと R2 のキーを入れて記録を押し、通信が切れて読み直しでもまだ見つからずに送信を止めたところまで進める */
async function recordDrTestWithNoResponse() {
  let gets = 0;
  const reads = [[OLD_DR], [OLD_DR], [CREATED_DR, OLD_DR]];
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') {
      expect(input).toBe(SUPER_ADMIN_DR_TESTS_API_PATH);
      throw networkFailure();
    }
    expect(input).toBe(SUPER_ADMIN_BACKUPS_API_PATH);
    const entry = reads[Math.min(gets, reads.length - 1)];
    gets += 1;
    return jsonResponse(HTTP_OK, backupsBody(entry));
  });
  vi.stubGlobal('fetch', fetchMock);
  await renderElement(createElement(SuperAdminBackupsPage));
  await typeInto(drNotes(), DR_NOTES);
  await typeInto(drBackupKey(), DR_BACKUP_KEY);
  await submitForm(drForm());
  expect(findButton('確かめ直す')).toBeDefined();
}

describe('DR 訓練の記録: 送る本文で前後の空白を除く項目は、前後の空白だけの違いを書き換えと見なさない (#2128 V2 と同じ型)', () => {
  it('止めているあいだに R2 のキーの前後へ空白だけを足しても、確かめ直しで済んでいたと分かったら初めに戻す', async () => {
    await recordDrTestWithNoResponse();
    await typeInto(drBackupKey(), `  ${DR_BACKUP_KEY} `);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(postCount()).toBe(1);
    expect(text()).toContain(DR_FOUND_TEXT);
    expect(drBackupKey()!.value).toBe('');
    expect(drNotes()!.value).toBe('');
  });

  it('メモは入力のまま保存するので、止めているあいだにメモの前後へ空白を足したら、済んでいたと分かっても残す', async () => {
    await recordDrTestWithNoResponse();
    await typeInto(drNotes(), `${DR_NOTES} `);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(text()).toContain(DR_FOUND_TEXT);
    expect(drNotes()!.value).toBe(`${DR_NOTES} `);
    expect(drBackupKey()!.value).toBe(DR_BACKUP_KEY);
  });

  it('記録の応答を待つあいだに R2 のキーの前後へ空白だけを足しても、記録できたあと初めに戻す', async () => {
    const post = deferredResponse();
    let gets = 0;
    fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (methodOf(init) === 'POST') return post.promise;
      gets += 1;
      return jsonResponse(HTTP_OK, backupsBody(gets === 1 ? [OLD_DR] : [CREATED_DR, OLD_DR]));
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderElement(createElement(SuperAdminBackupsPage));
    await typeInto(drNotes(), DR_NOTES);
    await typeInto(drBackupKey(), DR_BACKUP_KEY);
    await submitForm(drForm());
    await typeInto(drBackupKey(), ` ${DR_BACKUP_KEY}  `);

    await resolveWith(post, jsonResponse(HTTP_CREATED, { data: { id: CREATED_DR.id } }));

    expect(postCount()).toBe(1);
    expect(drBackupKey()!.value).toBe('');
    expect(drNotes()!.value).toBe('');
  });
});
