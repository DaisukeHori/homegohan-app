/**
 * #2101 X2: お知らせ・営業の活動・DR 訓練の記録の作成が、通信切れ・本文に API の文の無い 502 / 503 / 504 のあとの押し直しで二重に作らない
 *
 * 以前の画面は、作成の fetch の reject と本文に文の無い 502 / 504 を「失敗」として文を出し、入力を残してボタンを戻すだけだった。
 * route は素の insert (announcements・sales_lead_activities には主キーのほかに一意の制約が無い) で、DR 訓練の記録は毎回 admin_audit_logs に 1 行書くので、
 * サーバーが済ませてから応答が切れたあとに押し直すと、同じお知らせ (公開なら利用者に 2 通)・活動・訓練の記録が 2 行できた。
 * 直したあと (不変条件。#2093 W1 の support/new・sales/new と同じ型):
 *   - 応答を受け取れなかったら「失敗しました」と言わず、一覧を読み直して、送る前に無かった行で送った内容と同じものがあるかを確かめる
 *   - あれば済んだとして入力を空にし、その旨を出す (押し直させない)
 *   - 無ければ入力を残し「まだ保存されていません」と出して、押し直せるようにする
 *   - 読み直しにも失敗したら送信を止め (押しても送らない)、「済んだか分かりません。一覧で確かめてから作り直してください」と出す。
 *     「確かめ直す」で読み直しを繰り返せる
 *   - 送る前に一覧を読めていなかった (比べる元が無い) のに同じ内容の行があれば、済んだか決められないので送信を止める
 *   - 本文に API の文がある 502 / 503 / 504 と、ほかの失敗 (500 など) は、これまでどおり失敗として文を出し、押し直せる
 *   - リードの詳細の 401 は、ログインのあとに元のリードへ戻れるよう next を付けてログインの画面へ移す
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

const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined } };
});
const routerPush = nav.push;

vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: AnnouncementsManager } = await import('@/app/admin/announcements/AnnouncementsManager');
const { default: LeadDetailPage } = await import('@/app/admin/sales/[id]/page');
const { default: SuperAdminBackupsPage } = await import('@/app/super-admin/backups/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 本文が JSON でない失敗の応答 (手前のプロキシ・ホスティングの応答) */
const proxyResponse = (status: number) =>
  new Response('<html><body>Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 押し直しで二重にならないことを言う文の断片 */
const UNCONFIRMED_GUIDE = '済んだか分かりません。一覧で確かめてから作り直してください';
const REOPEN_GUIDE = 'もう一度送るときは、画面を開き直してください';

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
const getCount = () => fetchMock.mock.calls.filter(([, init]) => methodOf(init) === 'GET').length;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerPush.mockReset();
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

/**
 * GET は lists を順に返し (最後のものを繰り返す)、POST は create を返す。
 * 要素が number なら、その HTTP ステータスの失敗 (本文は API の形)
 */
function mockAnnouncements(lists: ReadonlyArray<readonly unknown[] | number>, create: () => Response) {
  let gets = 0;
  fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') return create();
    const entry = lists[Math.min(gets, lists.length - 1)];
    gets += 1;
    if (typeof entry === 'number') return jsonResponse(entry, { error: '失敗しました' });
    return jsonResponse(200, { announcements: entry });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const annTitleInput = () => container.querySelector<HTMLInputElement>('#announcement-title');
const annContentInput = () => container.querySelector<HTMLTextAreaElement>('#announcement-content');

async function createAnnouncement() {
  await typeInto(annTitleInput(), ANN_TITLE);
  await typeInto(annContentInput(), ANN_CONTENT);
  await submitForm(container.querySelector('form'));
}

describe('お知らせの作成: 応答を受け取れなかったら一覧を読み直して確かめる (#2101 X2)', () => {
  it('通信が切れても、読み直した一覧に送った内容の新しいお知らせがあれば済んだとして入力を空にし、押し直させない', async () => {
    mockAnnouncements([[OLD_ANNOUNCEMENT], [CREATED_ANNOUNCEMENT, OLD_ANNOUNCEMENT]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(AnnouncementsManager));
    await createAnnouncement();

    expect(postCount()).toBe(1);
    expect(getCount()).toBe(2);
    expect(text()).toContain('お知らせの作成の応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain('読み込み直したところ、お知らせは保存されていました');
    expect(text()).not.toContain('作成できませんでした');
    expect(annTitleInput()!.value).toBe('');
    expect(annContentInput()!.value).toBe('');
    // 読み直した一覧に、作成されたお知らせが出ている
    expect(text()).toContain(ANN_TITLE);
  });

  it('本文の無い 504 で、読み直した一覧に送った内容が無ければ入力を残し「まだ保存されていません」と出して、押し直せる', async () => {
    mockAnnouncements([[OLD_ANNOUNCEMENT]], () => proxyResponse(504));
    await renderElement(createElement(AnnouncementsManager));
    await createAnnouncement();

    expect(postCount()).toBe(1);
    expect(text()).toContain('お知らせの作成の応答を受け取れませんでした (HTTP 504)');
    expect(text()).toContain('まだ保存されていません');
    expect(annTitleInput()!.value).toBe(ANN_TITLE);
    expect(findButton('作成する')?.disabled).toBe(false);

    await submitForm(container.querySelector('form'));
    expect(postCount()).toBe(2);
  });

  it('前からある同じ内容のお知らせ (送る前に一覧にあった行) は、作成されたとは数えない', async () => {
    const sameBefore = announcementRow('ann-same-before');
    mockAnnouncements([[sameBefore]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(AnnouncementsManager));
    await createAnnouncement();

    expect(text()).toContain('まだ保存されていません');
    expect(text()).not.toContain('保存されていました');
  });

  it('読み直しにも失敗したら送信を止め、押しても送らない。「確かめ直す」で読み直して済んでいれば入力を空にする', async () => {
    mockAnnouncements([[OLD_ANNOUNCEMENT], 500, [CREATED_ANNOUNCEMENT, OLD_ANNOUNCEMENT]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(AnnouncementsManager));
    await createAnnouncement();

    expect(postCount()).toBe(1);
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(findButton('作成する')?.disabled).toBe(true);
    expect(annTitleInput()!.value).toBe(ANN_TITLE);

    // ボタンが止まっていても、フォームの送信 (Enter など) では送らない
    await submitForm(container.querySelector('form'));
    expect(postCount()).toBe(1);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');
    expect(postCount()).toBe(1);
    expect(text()).toContain('読み込み直したところ、お知らせは保存されていました');
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(annTitleInput()!.value).toBe('');
    expect(findButton('作成する')?.disabled).toBe(false);
  });

  it('読み直しが 401 なら、ログインし直す文を出し、「確かめ直す」は出さない (押しても必ず失敗するため)', async () => {
    mockAnnouncements([[OLD_ANNOUNCEMENT], 401], () => proxyResponse(502));
    await renderElement(createElement(AnnouncementsManager));
    await createAnnouncement();

    expect(postCount()).toBe(1);
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(text()).toContain('ログインし直してください');
    expect(findButton('確かめ直す')).toBeUndefined();
    expect(findButton('作成する')?.disabled).toBe(true);
  });

  it('送る前に一覧を読めていなかったのに、読み直した一覧に同じ内容の行があれば、済んだか決められないので送信を止める', async () => {
    mockAnnouncements([500, [CREATED_ANNOUNCEMENT]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(AnnouncementsManager));
    await createAnnouncement();

    expect(postCount()).toBe(1);
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(text()).toContain(REOPEN_GUIDE);
    expect(findButton('作成する')?.disabled).toBe(true);
    await submitForm(container.querySelector('form'));
    expect(postCount()).toBe(1);
  });

  it('本文に API の文がある 502 は、これまでどおり失敗として出し、読み直さずに押し直せる', async () => {
    mockAnnouncements([[OLD_ANNOUNCEMENT]], () => jsonResponse(502, { error: 'お知らせの処理に失敗しました' }));
    await renderElement(createElement(AnnouncementsManager));
    await createAnnouncement();

    expect(getCount()).toBe(1);
    expect(text()).toContain('お知らせを作成できませんでした');
    expect(text()).not.toContain('応答を受け取れませんでした');
    expect(findButton('作成する')?.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 営業のリードの活動 (/admin/sales/[id])
// ─────────────────────────────────────────────────────────────────────────────

const LEAD_ID = '21012101-2101-4101-8101-210121012101';
const ACTIVITY_SUMMARY = '先方の担当者と電話で話した';
const ACTIVITY_NEXT = '見積もりを送る';

interface ActivityRow {
  id: string;
  actor_id: string;
  activity_type: string;
  details: Record<string, unknown>;
  created_at: string;
}

const OLD_ACTIVITY: ActivityRow = {
  id: '21012101-0000-4000-8000-000000000001',
  actor_id: 'actor-1',
  activity_type: 'note',
  details: { summary: '前のメモ', date: '2026-10-01' },
  created_at: '2026-10-01T00:00:00.000Z',
};

function createdActivity(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: '21012101-0000-4000-8000-000000000002',
    actor_id: 'actor-1',
    activity_type: 'note',
    details: { summary: ACTIVITY_SUMMARY, next_action: ACTIVITY_NEXT, date: todayLocal() },
    created_at: '2026-10-30T02:00:00.000Z',
    ...overrides,
  };
}

function leadBody(activities: readonly ActivityRow[]) {
  return {
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
  };
}

/** GET は reads を順に返し (最後のものを繰り返す)、POST は create を返す。number はその HTTP ステータスの失敗 */
function mockLead(reads: ReadonlyArray<readonly ActivityRow[] | number>, create: () => Response) {
  let gets = 0;
  fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') return create();
    const entry = reads[Math.min(gets, reads.length - 1)];
    gets += 1;
    if (typeof entry === 'number') return jsonResponse(entry, { error: { code: 'X', message: '失敗' } });
    return jsonResponse(200, leadBody(entry));
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** 解決済みの params (React の use() が止まらずに値を返す thenable) */
function fulfilledParams(): Promise<{ id: string }> {
  const value = { id: LEAD_ID };
  return Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value });
}

const activityTextarea = () => container.querySelector<HTMLTextAreaElement>('textarea');
const nextActionInput = () => container.querySelector<HTMLInputElement>('input[placeholder="次のアクション (任意)"]');

async function recordActivity() {
  await typeInto(activityTextarea(), ACTIVITY_SUMMARY);
  await typeInto(nextActionInput(), ACTIVITY_NEXT);
  await click(findButton('活動を記録'), '「活動を記録」ボタン');
}

describe('営業のリードの活動の記録: 応答を受け取れなかったらリードを読み直して確かめる (#2101 X2)', () => {
  it('通信が切れても、読み直した活動履歴に送った内容の新しい活動があれば済んだとして入力を空にし、押し直させない', async () => {
    mockLead([[OLD_ACTIVITY], [createdActivity(), OLD_ACTIVITY]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams() }));
    await recordActivity();

    expect(postCount()).toBe(1);
    expect(getCount()).toBe(2);
    expect(text()).toContain('活動の記録の応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain('読み込み直したところ、活動は保存されていました');
    expect(text()).not.toContain('失敗しました');
    expect(activityTextarea()!.value).toBe('');
    expect(nextActionInput()!.value).toBe('');
  });

  it('本文の無い 503 で、読み直した活動履歴に送った内容が無ければ入力を残し「まだ保存されていません」と出して、押し直せる', async () => {
    mockLead([[OLD_ACTIVITY]], () => proxyResponse(503));
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams() }));
    await recordActivity();

    expect(postCount()).toBe(1);
    expect(text()).toContain('活動の記録の応答を受け取れませんでした (HTTP 503)');
    expect(text()).toContain('まだ保存されていません');
    expect(activityTextarea()!.value).toBe(ACTIVITY_SUMMARY);

    await click(findButton('活動を記録'), '「活動を記録」ボタン');
    expect(postCount()).toBe(2);
  });

  it('同じ文でも、種類・次のアクションが違う活動は、送ったものとは数えない', async () => {
    const otherType = createdActivity({ activity_type: 'call' });
    mockLead([[OLD_ACTIVITY], [otherType, OLD_ACTIVITY]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams() }));
    await recordActivity();

    expect(text()).toContain('まだ保存されていません');
    expect(text()).not.toContain('保存されていました');
  });

  it('読み直しにも失敗したら送信を止め、押しても送らない。ステージを変えて読み直しても止めている文は消えず、「確かめ直す」で確かめられる', async () => {
    mockLead([[OLD_ACTIVITY], 500, [OLD_ACTIVITY]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams() }));
    await recordActivity();

    expect(postCount()).toBe(1);
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(findButton('活動を記録')?.disabled).toBe(true);
    await click(findButton('活動を記録'), '「活動を記録」ボタン');
    expect(postCount()).toBe(1);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');
    expect(postCount()).toBe(1);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(text()).toContain('まだ保存されていません');
    expect(activityTextarea()!.value).toBe(ACTIVITY_SUMMARY);
    expect(findButton('活動を記録')?.disabled).toBe(false);
  });

  it('止めているあいだにステージを変えてリードを読み直しても、止めている文は消えず送信も止まったまま', async () => {
    let gets = 0;
    fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (methodOf(init) === 'POST') throw networkFailure();
      if (methodOf(init) === 'PATCH') return jsonResponse(200, { data: { id: LEAD_ID } });
      gets += 1;
      if (gets === 2) return jsonResponse(500, { error: { code: 'X', message: '失敗' } });
      return jsonResponse(200, leadBody([OLD_ACTIVITY]));
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams() }));
    await recordActivity();
    expect(text()).toContain(UNCONFIRMED_GUIDE);

    await click(findButton('商談中'), '「商談中」ボタン');
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(findButton('活動を記録')?.disabled).toBe(true);
    await click(findButton('活動を記録'), '「活動を記録」ボタン');
    expect(postCount()).toBe(1);
  });

  it('本文に API の文がある 502 は、これまでどおり失敗として出し、読み直さずに押し直せる', async () => {
    mockLead([[OLD_ACTIVITY]], () => jsonResponse(502, { error: { code: 'INTERNAL_ERROR', message: '活動の記録に失敗しました' } }));
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams() }));
    await recordActivity();

    expect(getCount()).toBe(1);
    expect(text()).toContain('活動の記録に失敗しました');
    expect(text()).not.toContain('応答を受け取れませんでした');
    expect(findButton('活動を記録')?.disabled).toBe(false);
  });

  it('リードの読み込みが 401 なら、元のリードへ戻れるよう next を付けてログインの画面へ移す', async () => {
    mockLead([401], () => jsonResponse(201, {}));
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams() }));

    expect(routerPush).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(`/admin/sales/${LEAD_ID}`)}`);
  });

  it('応答を受け取れなかったあとの読み直しが 401 なら、next を付けてログインの画面へ移し、送信は止めたまま', async () => {
    mockLead([[OLD_ACTIVITY], 401], () => {
      throw networkFailure();
    });
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams() }));
    await recordActivity();

    expect(routerPush).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(`/admin/sales/${LEAD_ID}`)}`);
    expect(postCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DR 訓練の記録 (/super-admin/backups)
// ─────────────────────────────────────────────────────────────────────────────

const SUPER_ADMIN_ID = '21012101-1111-4111-8111-111111111111';

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

const OLD_DR = drRow('21012101-2222-4222-8222-000000000001', { ...initialDrBody(), performed_on: '2026-09-01' });

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

/** GET は reads を順に返し (最後のものを繰り返す)、POST は create を返す。number はその HTTP ステータスの失敗 */
function mockBackups(reads: ReadonlyArray<readonly BackupAuditRow[] | number>, create: () => Response) {
  let gets = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') {
      expect(input).toBe(SUPER_ADMIN_DR_TESTS_API_PATH);
      return create();
    }
    expect(input).toBe(SUPER_ADMIN_BACKUPS_API_PATH);
    const entry = reads[Math.min(gets, reads.length - 1)];
    gets += 1;
    if (typeof entry === 'number') return jsonResponse(entry, { error: { code: 'X', message: '失敗' } });
    return jsonResponse(200, backupsBody(entry));
  });
  vi.stubGlobal('fetch', fetchMock);
}

const drForm = () => container.querySelector<HTMLFormElement>('[data-testid="dr-test-form"]');
const drSubmitButton = () => drForm()?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
const drNotes = () => container.querySelector<HTMLInputElement>('#dr-test-notes');

describe('DR 訓練の記録: 応答を受け取れなかったら記録の一覧を読み直して確かめる (#2101 X2)', () => {
  it('通信が切れても、読み直した訓練の記録に送った内容の新しい行があれば済んだとして入力を戻し、押し直させない', async () => {
    const created = drRow('21012101-2222-4222-8222-000000000002', { ...initialDrBody(), notes: 'pitr ok' });
    mockBackups([[OLD_DR], [created, OLD_DR]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(SuperAdminBackupsPage));
    await typeInto(drNotes(), 'pitr ok');
    await submitForm(drForm());

    expect(postCount()).toBe(1);
    expect(getCount()).toBe(2);
    expect(text()).toContain('DR 訓練の記録の応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain('読み込み直したところ、DR 訓練の記録は保存されていました');
    expect(text()).not.toContain('記録できませんでした');
    expect(drNotes()!.value).toBe('');
  });

  it('本文の無い 504 で、読み直した記録に送った内容が無ければ入力を残し「まだ保存されていません」と出して、押し直せる', async () => {
    mockBackups([[OLD_DR]], () => proxyResponse(504));
    await renderElement(createElement(SuperAdminBackupsPage));
    await typeInto(drNotes(), 'pitr ok');
    await submitForm(drForm());

    expect(postCount()).toBe(1);
    expect(text()).toContain('DR 訓練の記録の応答を受け取れませんでした (HTTP 504)');
    expect(text()).toContain('まだ保存されていません');
    expect(drNotes()!.value).toBe('pitr ok');
    expect(drSubmitButton()?.disabled).toBe(false);

    await submitForm(drForm());
    expect(postCount()).toBe(2);
  });

  it('読み直しにも失敗したら送信を止め、押しても送らない。「確かめ直す」で読み直して済んでいれば入力を戻す', async () => {
    const created = drRow('21012101-2222-4222-8222-000000000003', initialDrBody());
    mockBackups([[OLD_DR], 500, [created, OLD_DR]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(SuperAdminBackupsPage));
    await submitForm(drForm());

    expect(postCount()).toBe(1);
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(drSubmitButton()?.disabled).toBe(true);
    await submitForm(drForm());
    expect(postCount()).toBe(1);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');
    expect(postCount()).toBe(1);
    expect(text()).toContain('読み込み直したところ、DR 訓練の記録は保存されていました');
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(drSubmitButton()?.disabled).toBe(false);
  });

  it('送る前に記録を読めていなかったのに、読み直した記録に同じ内容の行があれば、済んだか決められないので送信を止める', async () => {
    const created = drRow('21012101-2222-4222-8222-000000000004', initialDrBody());
    mockBackups([500, [created]], () => {
      throw networkFailure();
    });
    await renderElement(createElement(SuperAdminBackupsPage));
    await submitForm(drForm());

    expect(postCount()).toBe(1);
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(text()).toContain(REOPEN_GUIDE);
    expect(drSubmitButton()?.disabled).toBe(true);
    await submitForm(drForm());
    expect(postCount()).toBe(1);
  });

  it('本文に API の文がある 502 と 500 は、これまでどおり「記録できませんでした」を出し、読み直さずに押し直せる', async () => {
    mockBackups([[OLD_DR]], () => jsonResponse(502, { error: { code: 'INTERNAL_ERROR', message: '処理に失敗しました' } }));
    await renderElement(createElement(SuperAdminBackupsPage));
    await submitForm(drForm());

    expect(getCount()).toBe(1);
    expect(text()).toContain('記録できませんでした');
    expect(text()).not.toContain('応答を受け取れませんでした');
    expect(drSubmitButton()?.disabled).toBe(false);
  });
});
