/**
 * #2107 Y1・Y7: 書き込みの応答を受け取れなかったあとの読み直しで、二重の送信と入力の消失を起こさない
 *
 * Y1 問い合わせの返信 (admin/support/[id]):
 *   以前の画面は、応答が切れたあとチケットを読み直して返信がまだ無いと、送信の止めを外して「必要ならもう一度送ってください」と出した。
 *   route は insert のあと顧客へのメールを送ってから応答するので、サーバーが書き込みの途中なら、押し直すと同じ返信が 2 行入り、
 *   顧客にメールが 2 通届く (メールは取り消せない)。行がまだ無いことは送られていないことの確かめにならない
 *   (#2101 X2 の src/lib/admin/admin-create-no-response.ts の not-found と同じ考え方)。
 *   直したあと (不変条件):
 *     - 読み直しで返信がまだ無くても、送信を止めたまま (押しても POST しない)、「まだ見つかりません。…少し待って確かめ直してください」と
 *       読み直しのボタン (「再試行」) を出す。押し直しを促す文は出さない。押し直すのはチケットを開き直したときだけ
 *     - 遅れて返信が届いていれば、読み直しのボタンで済んだと分かり、2 通目を送らない
 *     - 止めているあいだに書き換えた入力は、済んでいたと分かっても消さない
 *
 * Y7 お知らせ (admin/announcements)・DR 訓練の記録 (super-admin/backups):
 *   以前の画面は、応答が切れたあとの「確かめ直す」で済んでいたと分かると、入力を無条件に空にした (初めに戻した)。
 *   送信を止めているあいだも入力欄は書き換えられる (止めるのは送信中だけ) ので、運営が書き足した文が消えた。
 *   直したあと (不変条件。営業の活動 (admin/sales/[id]) と同じ): 入力が送った値のままのときだけ空にする。書き換えていれば残す
 *
 * 同じ型 (応答を待つあいだに書き換えた入力を、済んだときに無条件に空にする): 送信の応答 (201) を待つあいだも入力欄が書き換えられる
 * 問い合わせの返信・営業の活動・DR 訓練の記録は、応答が届いたときも、入力が送った値のままのときだけ空にする
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
import { todayLocal } from '@/lib/date-utils';
import { REPLY_NOT_DELIVERED_GUIDE } from '@/lib/admin/support-reply-no-response';

const TICKET_ID = '21072107-2107-4107-8107-210721072107';
const KNOWN_MESSAGE_ID = '21072107-0000-4000-8000-000000000001';
const DELIVERED_MESSAGE_ID = '21072107-0000-4000-8000-000000000002';

const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined } };
});

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '21072107-2107-4107-8107-210721072107' }),
  useRouter: () => nav.router,
  usePathname: () => '/admin/support',
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: TicketDetailPage } = await import('@/app/admin/support/[id]/page');
const { default: AnnouncementsManager } = await import('@/app/admin/announcements/AnnouncementsManager');
const { default: SuperAdminBackupsPage } = await import('@/app/super-admin/backups/page');
const { default: LeadDetailPage } = await import('@/app/admin/sales/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 本文が JSON でない失敗の応答 (手前のプロキシ・ホスティングの応答) */
const proxyResponse = (status: number) =>
  new Response('<html><body>Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 読み直しで返信がまだ見つからなかったときの文の断片 (#2107 Y1 の仕様の文) */
const REPLY_NOT_FOUND_TEXT = 'まだ見つかりません。サーバーが書き込みの途中かもしれないので、少し待って確かめ直してください';
/** 押し直しはチケットを開き直したときだけであることを言う文 */
const REPLY_REOPEN_TEXT = 'もう一度送るときは、チケットを開き直してください';
/** 以前の画面が出していた、押し直しを促す文 (出してはいけない) */
const RESEND_PROMPT = 'もう一度送ってください';
const OLD_NOT_DELIVERED_TEXT = 'まだ送られていません';

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

/** あとから解決する応答 (送信の応答を待つあいだに入力を書き換える筋書きに使う) */
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
const methodOf = (init: unknown) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
const postCount = () => fetchMock.mock.calls.filter(([, init]) => methodOf(init) === 'POST').length;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  nav.push.mockReset();
  // メッセージの一覧の末尾へのスクロール (テストの DOM には無いので、何もしない関数を置く)
  Element.prototype.scrollIntoView = () => undefined;
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
// Y1 問い合わせの返信 (/admin/support/[id])
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_MESSAGE = {
  id: KNOWN_MESSAGE_ID,
  sender_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  is_internal: false,
  body: 'ログインできません',
  created_at: '2026-10-30T00:00:00.000Z',
};
const TICKET = {
  id: TICKET_ID,
  user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  subject: '通信の切れる問い合わせ',
  category: 'other',
  priority: 'medium',
  status: 'open',
  assignee_id: null,
  first_response_at: null,
  resolved_at: null,
  created_at: '2026-10-30T00:00:00.000Z',
  updated_at: '2026-10-30T00:00:00.000Z',
  messages: [KNOWN_MESSAGE],
};
const REPLY = 'パスワードの再設定をお試しください';
const deliveredTicket = () => ({
  ...TICKET,
  status: 'in_progress',
  messages: [
    KNOWN_MESSAGE,
    { id: DELIVERED_MESSAGE_ID, sender_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', is_internal: false, body: REPLY, created_at: '2026-10-30T00:01:00.000Z' },
  ],
});

/** GET はキューの順に返し (尽きたら最後のもの)、POST は postResult を返す fetch */
function stubTicketFetch(getResults: Array<() => Response>, postResult: () => Response) {
  let getIndex = 0;
  fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') return postResult();
    const next = getResults[Math.min(getIndex, getResults.length - 1)];
    getIndex += 1;
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
}

const replyTextarea = () => container.querySelector<HTMLTextAreaElement>('textarea');
const blockedReason = () => container.querySelector('[data-testid="blocked-send-reason"]')?.textContent ?? '';

async function openTicketAndSend(body: string) {
  await renderElement(createElement(TicketDetailPage, { params: Promise.resolve({ id: TICKET_ID }) }));
  await typeInto(replyTextarea(), body);
  await click(findButton('返信を送信'), '「返信を送信」ボタン');
}

describe('問い合わせの返信: 読み直しで返信がまだ見つからなくても送信を止めたままにする (#2107 Y1)', () => {
  it('本文の無い 504 のあと、読み直しても返信が無ければ、送信を止めたまま「まだ見つかりません」と「再試行」を出し、押しても送らない', async () => {
    stubTicketFetch([() => jsonResponse(200, { data: TICKET })], () => proxyResponse(504));
    await openTicketAndSend(REPLY);

    expect(postCount()).toBe(1);
    expect(blockedReason()).toContain('メッセージの送信の応答を受け取れませんでした (HTTP 504)');
    expect(blockedReason()).toContain(REPLY_NOT_FOUND_TEXT);
    expect(blockedReason()).toContain(REPLY_REOPEN_TEXT);
    expect(text()).not.toContain(RESEND_PROMPT);
    expect(text()).not.toContain(OLD_NOT_DELIVERED_TEXT);
    // 本文は残す (押し直しはチケットを開き直したときだけ)
    expect(replyTextarea()!.value).toBe(REPLY);
    expect(findButton('返信を送信')!.disabled).toBe(true);
    expect(findButton('再試行')).toBeDefined();

    // ボタンの止めを外しても、押されたときに送らない (再描画の前に押されたときの守り)
    await act(async () => {
      findButton('返信を送信')!.disabled = false;
    });
    await click(findButton('返信を送信'), '「返信を送信」ボタン');
    expect(postCount()).toBe(1);
  });

  it('通信が切れて読み直しでまだ無かったあと、遅れて返信が届いていれば「再試行」で済んだと分かり、2 通目を送らない', async () => {
    stubTicketFetch(
      [() => jsonResponse(200, { data: TICKET }), () => jsonResponse(200, { data: TICKET }), () => jsonResponse(200, { data: deliveredTicket() })],
      () => {
        throw networkFailure();
      },
    );
    await openTicketAndSend(REPLY);
    expect(blockedReason()).toContain(REPLY_NOT_FOUND_TEXT);
    expect(findButton('返信を送信')!.disabled).toBe(true);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(postCount()).toBe(1);
    expect(text()).toContain('読み込み直したところ、送った内容は保存されていました');
    expect(blockedReason()).toBe('');
    expect(replyTextarea()!.value).toBe('');
    expect(findButton('再試行')).toBeUndefined();
  });

  it('「再試行」で読み直してもまだ無ければ、止めたまま同じ文を出し、押しても送らない', async () => {
    stubTicketFetch([() => jsonResponse(200, { data: TICKET })], () => proxyResponse(502));
    await openTicketAndSend(REPLY);
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(blockedReason()).toContain(REPLY_NOT_FOUND_TEXT);
    expect(findButton('返信を送信')!.disabled).toBe(true);
    expect(findButton('再試行')).toBeDefined();
    expect(postCount()).toBe(1);
  });

  it('止めているあいだに書き換えた本文は、「再試行」で済んでいたと分かっても消さない', async () => {
    stubTicketFetch(
      [() => jsonResponse(200, { data: TICKET }), () => jsonResponse(200, { data: TICKET }), () => jsonResponse(200, { data: deliveredTicket() })],
      () => proxyResponse(503),
    );
    await openTicketAndSend(REPLY);
    const rewritten = `${REPLY}\n追記: 再設定のメールが届かないときは迷惑メールのフォルダもご確認ください`;
    await typeInto(replyTextarea(), rewritten);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(text()).toContain('読み込み直したところ、送った内容は保存されていました');
    expect(replyTextarea()!.value).toBe(rewritten);
    expect(postCount()).toBe(1);
  });

  it('返信がまだ無いときの文は、押し直しを促さず確かめ直させる', () => {
    expect(REPLY_NOT_DELIVERED_GUIDE).toContain(REPLY_NOT_FOUND_TEXT);
    expect(REPLY_NOT_DELIVERED_GUIDE).not.toContain(RESEND_PROMPT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Y7 お知らせ (/admin/announcements)
// ─────────────────────────────────────────────────────────────────────────────

const ANN_TITLE = '年末年始のお知らせ';
const ANN_CONTENT = '12/29〜1/3 はお休みです';

function announcementRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: ANN_TITLE,
    content: ANN_CONTENT,
    is_public: false,
    published_at: null,
    created_at: '2026-10-30T01:00:00.000Z',
    ...overrides,
  };
}

const OLD_ANNOUNCEMENT = announcementRow('ann-old', { title: '前のお知らせ', content: '前の本文' });
const CREATED_ANNOUNCEMENT = announcementRow('ann-new', { created_at: '2026-10-30T02:00:00.000Z' });

/** GET は lists を順に返し (最後のものを繰り返す)、POST は create を返す */
function mockAnnouncements(lists: ReadonlyArray<readonly unknown[]>, create: () => Response) {
  let gets = 0;
  fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') return create();
    const entry = lists[Math.min(gets, lists.length - 1)];
    gets += 1;
    return jsonResponse(200, { announcements: entry });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const annTitleInput = () => container.querySelector<HTMLInputElement>('#announcement-title');
const annContentInput = () => container.querySelector<HTMLTextAreaElement>('#announcement-content');
const annIsPublic = () => container.querySelector<HTMLInputElement>('#announcement-is-public');

async function createAnnouncementWithNoResponse() {
  mockAnnouncements([[OLD_ANNOUNCEMENT], [OLD_ANNOUNCEMENT], [CREATED_ANNOUNCEMENT, OLD_ANNOUNCEMENT]], () => proxyResponse(504));
  await renderElement(createElement(AnnouncementsManager));
  await typeInto(annTitleInput(), ANN_TITLE);
  await typeInto(annContentInput(), ANN_CONTENT);
  await submitForm(container.querySelector('form'));
  expect(findButton('確かめ直す')).toBeDefined();
}

describe('お知らせの作成: 確かめ直しで済んでいたと分かっても、書き足した入力を消さない (#2107 Y7)', () => {
  it('止めているあいだに本文を書き換えたら、「確かめ直す」で済んでいたと分かっても書き換えた入力を残す', async () => {
    await createAnnouncementWithNoResponse();
    const rewritten = `${ANN_CONTENT}\n1/4 から通常どおりです`;
    await typeInto(annContentInput(), rewritten);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(postCount()).toBe(1);
    expect(text()).toContain('読み込み直したところ、お知らせは保存されていました');
    expect(annContentInput()!.value).toBe(rewritten);
    expect(annTitleInput()!.value).toBe(ANN_TITLE);
    expect(findButton('作成する')?.disabled).toBe(false);
  });

  it('止めているあいだにタイトルだけ書き換えても、入力をすべて残す', async () => {
    await createAnnouncementWithNoResponse();
    await typeInto(annTitleInput(), '年末年始の営業のお知らせ');

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(annTitleInput()!.value).toBe('年末年始の営業のお知らせ');
    expect(annContentInput()!.value).toBe(ANN_CONTENT);
  });

  it('止めているあいだに「公開する」だけ切り替えても、入力を空にしない', async () => {
    await createAnnouncementWithNoResponse();
    await click(annIsPublic() ?? undefined, '「公開する」のチェック');
    expect(annIsPublic()!.checked).toBe(true);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(text()).toContain('読み込み直したところ、お知らせは保存されていました');
    expect(annTitleInput()!.value).toBe(ANN_TITLE);
    expect(annContentInput()!.value).toBe(ANN_CONTENT);
    expect(annIsPublic()!.checked).toBe(true);
  });

  it('入力が送った値のままなら、「確かめ直す」で済んでいたと分かったとき空にする', async () => {
    await createAnnouncementWithNoResponse();

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(annTitleInput()!.value).toBe('');
    expect(annContentInput()!.value).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Y7 DR 訓練の記録 (/super-admin/backups)
// ─────────────────────────────────────────────────────────────────────────────

const SUPER_ADMIN_ID = '21072107-1111-4111-8111-111111111111';

function drRow(id: string, details: Record<string, unknown>): BackupAuditRow {
  return {
    id,
    created_at: '2026-10-30T02:00:00.000Z',
    action_type: DR_TEST_AUDIT_ACTIONS.monthly_pitr,
    target_type: DR_TEST_AUDIT_TARGET_TYPE,
    actor_id: SUPER_ADMIN_ID,
    severity: 'info',
    details,
  };
}

/** 画面の初めの入力のまま送ったときの本文 (toRequestBody の形) */
function initialDrBody(): Record<string, unknown> {
  return {
    kind: 'monthly_pitr',
    result: 'success',
    performed_on: jstToday(),
    environment: 'local',
    restored_to: null,
    backup_key: null,
    rto_minutes: null,
    smoke: 'passed',
    notes: '',
  };
}

const OLD_DR = drRow('21072107-2222-4222-8222-000000000001', { ...initialDrBody(), performed_on: '2026-09-01' });
const DR_NOTES = 'pitr ok';
const CREATED_DR = drRow('21072107-2222-4222-8222-000000000002', { ...initialDrBody(), notes: DR_NOTES });

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

/** GET は reads を順に返し (最後のものを繰り返す)、POST は create を返す */
function mockBackups(reads: ReadonlyArray<readonly BackupAuditRow[]>, create: () => Response) {
  let gets = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') {
      expect(input).toBe(SUPER_ADMIN_DR_TESTS_API_PATH);
      return create();
    }
    expect(input).toBe(SUPER_ADMIN_BACKUPS_API_PATH);
    const entry = reads[Math.min(gets, reads.length - 1)];
    gets += 1;
    return jsonResponse(200, backupsBody(entry));
  });
  vi.stubGlobal('fetch', fetchMock);
}

const drForm = () => container.querySelector<HTMLFormElement>('[data-testid="dr-test-form"]');
const drNotes = () => container.querySelector<HTMLInputElement>('#dr-test-notes');
const drBackupKey = () => container.querySelector<HTMLInputElement>('#dr-test-backup_key');

async function recordDrTestWithNoResponse() {
  mockBackups([[OLD_DR], [OLD_DR], [CREATED_DR, OLD_DR]], () => {
    throw networkFailure();
  });
  await renderElement(createElement(SuperAdminBackupsPage));
  await typeInto(drNotes(), DR_NOTES);
  await submitForm(drForm());
  expect(findButton('確かめ直す')).toBeDefined();
}

describe('DR 訓練の記録: 確かめ直しで済んでいたと分かっても、書き足した入力を消さない (#2107 Y7)', () => {
  it('止めているあいだにメモを書き換えたら、「確かめ直す」で済んでいたと分かっても書き換えた入力を残す', async () => {
    await recordDrTestWithNoResponse();
    const rewritten = `${DR_NOTES} / 復元先の確認も済み`;
    await typeInto(drNotes(), rewritten);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(postCount()).toBe(1);
    expect(text()).toContain('読み込み直したところ、DR 訓練の記録は保存されていました');
    expect(drNotes()!.value).toBe(rewritten);
  });

  it('止めているあいだにほかの項目 (R2 のキー) だけ書き換えても、入力を初めに戻さない', async () => {
    await recordDrTestWithNoResponse();
    await typeInto(drBackupKey(), 'daily/2026-10-30.dump');

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(text()).toContain('読み込み直したところ、DR 訓練の記録は保存されていました');
    expect(drBackupKey()!.value).toBe('daily/2026-10-30.dump');
    expect(drNotes()!.value).toBe(DR_NOTES);
  });

  it('入力が送った値のままなら、「確かめ直す」で済んでいたと分かったとき初めに戻す', async () => {
    await recordDrTestWithNoResponse();

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');

    expect(drNotes()!.value).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 同じ型: 送信の応答 (201) を待つあいだに書き換えた入力を、応答が届いたときに消さない
// ─────────────────────────────────────────────────────────────────────────────

describe('応答を待つあいだに書き換えた入力を、作成できたときに消さない (#2107 Y7 と同じ型)', () => {
  it('問い合わせの返信: 送信の応答を待つあいだに書き足した本文は、送れたあとも残す', async () => {
    const post = deferredResponse();
    let getIndex = 0;
    fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (methodOf(init) === 'POST') return post.promise;
      getIndex += 1;
      return jsonResponse(200, { data: getIndex === 1 ? TICKET : deliveredTicket() });
    });
    vi.stubGlobal('fetch', fetchMock);
    await openTicketAndSend(REPLY);
    const rewritten = `${REPLY}\n追記`;
    await typeInto(replyTextarea(), rewritten);

    await resolveWith(post, jsonResponse(201, { data: { id: DELIVERED_MESSAGE_ID }, email: { status: 'sent' } }));

    expect(postCount()).toBe(1);
    expect(replyTextarea()!.value).toBe(rewritten);
  });

  it('問い合わせの返信: 本文が送ったままなら、送れたあと空にする', async () => {
    const post = deferredResponse();
    let getIndex = 0;
    fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (methodOf(init) === 'POST') return post.promise;
      getIndex += 1;
      return jsonResponse(200, { data: getIndex === 1 ? TICKET : deliveredTicket() });
    });
    vi.stubGlobal('fetch', fetchMock);
    await openTicketAndSend(REPLY);

    await resolveWith(post, jsonResponse(201, { data: { id: DELIVERED_MESSAGE_ID }, email: { status: 'sent' } }));

    expect(replyTextarea()!.value).toBe('');
  });

  it('営業の活動: 記録の応答を待つあいだに書き換えた内容は、記録できたあとも残す (書き換えていない次のアクションは空にする)', async () => {
    const LEAD_ID = '21072107-2107-4107-8107-000000000010';
    const SUMMARY = '先方の担当者と電話で話した';
    const NEXT = '見積もりを送る';
    const leadBody = (activities: readonly unknown[]) => ({
      data: {
        id: LEAD_ID,
        company_name: '株式会社テスト',
        industry: null,
        employee_count: null,
        contact_name: null,
        contact_email: null,
        contact_phone: null,
        source: null,
        stage: 'approach',
        assigned_to: null,
        estimated_acv: null,
        notes: null,
        converted_org_id: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        activities,
      },
    });
    const created = {
      id: '21072107-0000-4000-8000-000000000010',
      actor_id: 'actor-1',
      activity_type: 'note',
      details: { summary: SUMMARY, next_action: NEXT, date: todayLocal() },
      created_at: '2026-10-30T02:00:00.000Z',
    };
    const post = deferredResponse();
    let gets = 0;
    fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (methodOf(init) === 'POST') return post.promise;
      gets += 1;
      return jsonResponse(200, leadBody(gets === 1 ? [] : [created]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const value = { id: LEAD_ID };
    const params = Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value });
    await renderElement(createElement(LeadDetailPage, { params }));
    const summaryInput = () => container.querySelector<HTMLTextAreaElement>('textarea');
    const nextInput = () => container.querySelector<HTMLInputElement>('input[placeholder="次のアクション (任意)"]');
    await typeInto(summaryInput(), SUMMARY);
    await typeInto(nextInput(), NEXT);
    await click(findButton('活動を記録'), '「活動を記録」ボタン');
    const rewritten = `${SUMMARY}。来週また電話する`;
    await typeInto(summaryInput(), rewritten);

    await resolveWith(post, jsonResponse(201, { data: created }));

    expect(postCount()).toBe(1);
    expect(summaryInput()!.value).toBe(rewritten);
    expect(nextInput()!.value).toBe('');
  });

  it('DR 訓練の記録: 記録の応答を待つあいだに書き換えたメモは、記録できたあとも残す', async () => {
    const post = deferredResponse();
    let gets = 0;
    fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (methodOf(init) === 'POST') {
        expect(input).toBe(SUPER_ADMIN_DR_TESTS_API_PATH);
        return post.promise;
      }
      gets += 1;
      return jsonResponse(200, backupsBody(gets === 1 ? [OLD_DR] : [CREATED_DR, OLD_DR]));
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderElement(createElement(SuperAdminBackupsPage));
    await typeInto(drNotes(), DR_NOTES);
    await submitForm(drForm());
    const rewritten = `${DR_NOTES} / 追記`;
    await typeInto(drNotes(), rewritten);

    await resolveWith(post, jsonResponse(201, { data: { id: CREATED_DR.id } }));

    expect(postCount()).toBe(1);
    expect(drNotes()!.value).toBe(rewritten);
  });

  it('DR 訓練の記録: 入力が送ったままなら、記録できたあと初めに戻す', async () => {
    const post = deferredResponse();
    let gets = 0;
    fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (methodOf(init) === 'POST') return post.promise;
      gets += 1;
      return jsonResponse(200, backupsBody(gets === 1 ? [OLD_DR] : [CREATED_DR, OLD_DR]));
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderElement(createElement(SuperAdminBackupsPage));
    await typeInto(drNotes(), DR_NOTES);
    await submitForm(drForm());

    await resolveWith(post, jsonResponse(201, { data: { id: CREATED_DR.id } }));

    expect(drNotes()!.value).toBe('');
  });
});
