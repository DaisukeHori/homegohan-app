/**
 * 組織の招待の一覧 (GET /api/org/invites → 画面 src/app/(org)/org/invites/page.tsx) の役割と状態
 *
 * 直す前の不具合:
 *  1. 管理者として招待した人が「メンバー」と出る — create_org_invite は invited_role に書き、旧い role 列 (既定 'member') には
 *     書かないのに、GET が role 列を返し、画面がそれを役割として出していた
 *  2. 取り消した招待が「保留中」のまま出て、リンクのコピーと取り消しのボタンも残る — GET が status を返さず、画面は
 *     isAccepted / isExpired 以外を 'pending' にしていた (拒否・退会で伏せた招待も同じ)
 *
 * 確かめること:
 *  - GET は invited_role を role として返し、旧い role 列を select しない
 *  - GET は status を返す (revoked / rejected / accepted はそのまま。期限を過ぎた pending は expired)
 *  - 応答は OrgInviteListResponseSchema に合う
 *  - 画面: 管理者の招待は「管理者」、取り消した招待は「取消済」、拒否は「拒否済」で、どちらもボタンを出さない。
 *    保留中の招待だけにリンクのコピーと取消のボタンが出る
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (tests/org-sidebar-plan-label.test.tsx と同じ)。
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type Row, type SchemaDb } from './helpers/schema-checked-db';
import { makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';
import { OrgInviteListResponseSchema, type OrgInviteListItem } from '@/schemas/membership/organization-invite';
import {
  displayOrgInviteStatus,
  isOrgInviteExpired,
  toOrgInviteListItem,
  type OrgInviteListRow,
} from '@/lib/membership/org-invite-list';
import { ORG_UNKNOWN_VALUE_LABEL } from '@/lib/org-plans';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: vi.fn() }),
  generateRequestId: () => 'req_test',
}));

let sessionUser: FakeUser | null = null;
let sessionDb: SchemaDb;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
  getSupabaseAdmin: () => makeClient(sessionDb, null),
}));

const invitesRoute = await import('@/app/api/org/invites/route');
const { default: OrgInvitesPage } = await import('@/app/(org)/org/invites/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ORG_A = uuid(100);
const OWNER_A = uuid(1);

const INVITE_ADMIN = uuid(501);
const INVITE_MEMBER = uuid(502);
const INVITE_REVOKED = uuid(503);
const INVITE_REJECTED = uuid(504);
const INVITE_ACCEPTED = uuid(505);
const INVITE_PENDING_EXPIRED = uuid(506);

/** まだ期限の来ていない日時 / 期限を過ぎた日時 */
const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

/**
 * create_org_invite が作る行と同じく、役割は invited_role にだけ入り、旧い role 列は既定の 'member' のまま
 * (supabase/migrations/20251126124224_create_meal_planner_tables.sql の organization_invites.role DEFAULT 'member')
 */
let createdSeq = 0;

function inviteRow(id: string, email: string, invitedRole: string, status: string, extra: Row = {}): Row {
  createdSeq += 1;
  return {
    id,
    organization_id: ORG_A,
    email,
    role: 'member',
    invited_role: invitedRole,
    status,
    department_id: null,
    token: `token-${id.slice(-3)}`,
    expires_at: FUTURE,
    accepted_at: null,
    created_at: new Date(Date.UTC(2026, 9, createdSeq)).toISOString(),
    ...extra,
  };
}

function worldTables(): Record<string, Row[]> {
  return {
    user_profiles: [profileRow(OWNER_A, { nickname: '山田オーナー', organization_id: ORG_A, org_role: 'owner', roles: ['user'] })],
    organizations: [
      { id: ORG_A, name: 'A 株式会社', plan: 'standard', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ],
    departments: [],
    organization_invites: [
      inviteRow(INVITE_ADMIN, 'admin-invitee@example.com', 'admin', 'pending'),
      inviteRow(INVITE_MEMBER, 'member-invitee@example.com', 'member', 'pending'),
      inviteRow(INVITE_REVOKED, 'revoked-invitee@example.com', 'admin', 'revoked'),
      inviteRow(INVITE_REJECTED, 'rejected-invitee@example.com', 'member', 'rejected'),
      inviteRow(INVITE_ACCEPTED, 'accepted-invitee@example.com', 'admin', 'accepted', { accepted_at: '2026-10-10T00:00:00Z' }),
      inviteRow(INVITE_PENDING_EXPIRED, 'expired-invitee@example.com', 'member', 'pending', { expires_at: PAST }),
    ],
  };
}

async function fetchList(): Promise<OrgInviteListItem[]> {
  const res = await invitesRoute.GET(new Request('http://localhost/api/org/invites'));
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  return OrgInviteListResponseSchema.parse(body).invites;
}

function byId(items: OrgInviteListItem[], id: string): OrgInviteListItem {
  const found = items.find((i) => i.id === id);
  expect(found, `招待 ${id} が一覧に無い`).toBeDefined();
  return found!;
}

beforeEach(() => {
  sessionUser = { id: OWNER_A, email: 'owner@example.com' };
  sessionDb = createSchemaDb({ tables: worldTables() });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/org/invites
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/org/invites の役割と状態', () => {
  it('管理者として招待した行は role が admin (旧い role 列の既定 member ではない)', async () => {
    const items = await fetchList();
    expect(byId(items, INVITE_ADMIN).role).toBe('admin');
    expect(byId(items, INVITE_REVOKED).role).toBe('admin');
    expect(byId(items, INVITE_ACCEPTED).role).toBe('admin');
    expect(byId(items, INVITE_MEMBER).role).toBe('member');
  });

  it('旧い role 列を select せず、invited_role と status を select する', async () => {
    await fetchList();
    const selects = sessionDb.recorded('organization_invites', 'select').map((q) => q.select ?? '');
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      const columns = select.split(',').map((c) => c.trim());
      expect(columns).not.toContain('role');
      expect(columns).toContain('invited_role');
      expect(columns).toContain('status');
    }
  });

  it('status を返す: 取り消し・拒否・承諾はそのまま、期限を過ぎた pending は expired、期限内の pending は pending', async () => {
    const items = await fetchList();
    expect(byId(items, INVITE_ADMIN).status).toBe('pending');
    expect(byId(items, INVITE_REVOKED).status).toBe('revoked');
    expect(byId(items, INVITE_REJECTED).status).toBe('rejected');
    expect(byId(items, INVITE_ACCEPTED).status).toBe('accepted');
    expect(byId(items, INVITE_PENDING_EXPIRED).status).toBe('expired');
    expect(byId(items, INVITE_PENDING_EXPIRED).isExpired).toBe(true);
    expect(byId(items, INVITE_ACCEPTED).isAccepted).toBe(true);
  });
});

describe('org-invite-list の小物', () => {
  const NOW = new Date('2026-10-22T00:00:00Z');

  it('期限を過ぎた pending だけを expired にし、他の状態は期限を過ぎても変えない', () => {
    expect(displayOrgInviteStatus('pending', PAST, NOW)).toBe('expired');
    expect(displayOrgInviteStatus('pending', FUTURE, NOW)).toBe('pending');
    for (const status of ['revoked', 'rejected', 'accepted', 'expired']) {
      expect(displayOrgInviteStatus(status, PAST, NOW)).toBe(status);
    }
  });

  it('期限ちょうどはまだ期限切れでない (expires_at < now で判定)', () => {
    expect(isOrgInviteExpired(NOW.toISOString(), NOW)).toBe(false);
    expect(displayOrgInviteStatus('pending', NOW.toISOString(), NOW)).toBe('pending');
  });

  it('toOrgInviteListItem は invited_role を role に、部署名を departmentName に入れる', () => {
    const row: OrgInviteListRow = {
      id: INVITE_ADMIN,
      email: 'x@example.com',
      invited_role: 'admin',
      status: 'pending',
      department_id: 'dept-1',
      token: 't',
      expires_at: FUTURE,
      accepted_at: null,
      created_at: null,
      departments: { name: '営業部' },
    };
    expect(toOrgInviteListItem(row, NOW)).toEqual({
      id: INVITE_ADMIN,
      email: 'x@example.com',
      role: 'admin',
      status: 'pending',
      departmentId: 'dept-1',
      departmentName: '営業部',
      token: 't',
      expiresAt: FUTURE,
      acceptedAt: null,
      createdAt: null,
      isExpired: false,
      isAccepted: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 画面 (GET の実際の応答を描画する)
// ─────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root | null = null;

/** fetch → setState → 描画の更新まで待つための、マクロタスクの回数 */
const FLUSH_TICKS = 5;

async function flush() {
  await act(async () => {
    for (let i = 0; i < FLUSH_TICKS; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(node);
  });
  await flush();
}

/** GET の応答をそのまま画面の fetch に返して描画する */
async function renderWithRouteResponse() {
  const res = await invitesRoute.GET(new Request('http://localhost/api/org/invites'));
  const body = await res.text();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
  await mount(<OrgInvitesPage />);
}

interface RenderedRow {
  text: string;
  role: string;
  badge: string;
  buttons: string[];
}

/** 招待履歴の 1 行 (メールアドレスで探す) */
function renderedRow(email: string): RenderedRow {
  const rows = [...container.querySelectorAll('div.divide-y > div')].filter((el) => (el.textContent ?? '').includes(email));
  expect(rows, `${email} の行がちょうど 1 つ無い`).toHaveLength(1);
  const row = rows[0];
  return {
    text: row.textContent ?? '',
    role: row.querySelector('span.text-sm')?.textContent ?? '',
    badge: row.querySelector('span.rounded-full')?.textContent ?? '',
    buttons: [...row.querySelectorAll('button')].map((b) => b.textContent ?? ''),
  };
}

afterEach(() => {
  if (root) {
    const mounted = root;
    act(() => mounted.unmount());
    container.remove();
    root = null;
  }
  vi.unstubAllGlobals();
});

describe('組織の招待の一覧の画面 (src/app/(org)/org/invites/page.tsx)', () => {
  it('管理者として招待した人は「管理者」と出る (「メンバー」ではない)', async () => {
    await renderWithRouteResponse();
    expect(renderedRow('admin-invitee@example.com').role).toBe('管理者');
    expect(renderedRow('member-invitee@example.com').role).toBe('メンバー');
  });

  it('保留中の招待だけにリンクのコピーと取消のボタンが出る', async () => {
    await renderWithRouteResponse();
    const pending = renderedRow('admin-invitee@example.com');
    expect(pending.badge).toBe('保留中');
    expect(pending.buttons).toEqual(['リンクをコピー', '取消']);
  });

  it('取り消した招待は「取消済」で、リンクのコピーと取消のボタンを出さない', async () => {
    await renderWithRouteResponse();
    const revoked = renderedRow('revoked-invitee@example.com');
    expect(revoked.badge).toBe('取消済');
    expect(revoked.role).toBe('管理者');
    expect(revoked.buttons).toEqual([]);
  });

  it('拒否された招待は「拒否済」で、ボタンを出さない', async () => {
    await renderWithRouteResponse();
    const rejected = renderedRow('rejected-invitee@example.com');
    expect(rejected.badge).toBe('拒否済');
    expect(rejected.buttons).toEqual([]);
  });

  it('承諾済み・期限切れの招待もボタンを出さない', async () => {
    await renderWithRouteResponse();
    const accepted = renderedRow('accepted-invitee@example.com');
    expect(accepted.badge).toBe('承諾済');
    expect(accepted.buttons).toEqual([]);
    const expired = renderedRow('expired-invitee@example.com');
    expect(expired.badge).toBe('期限切れ');
    expect(expired.buttons).toEqual([]);
  });

  it('status が pending でも期限を過ぎていれば「期限切れ」でボタンを出さない (応答の isExpired を見る)', async () => {
    const invites = [
      { id: 'i-1', email: 'late@example.com', role: 'member', token: 'tok', status: 'pending', isExpired: true, expiresAt: PAST },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ invites }), { status: 200 })));
    await mount(<OrgInvitesPage />);
    const row = renderedRow('late@example.com');
    expect(row.badge).toBe('期限切れ');
    expect(row.buttons).toEqual([]);
  });

  it('役割が無い・表に無い役割は内部の値を出さずに「-」', async () => {
    const invites = [
      { id: 'i-1', email: 'norole@example.com', token: 'tok', status: 'pending', expiresAt: FUTURE },
      { id: 'i-2', email: 'odd@example.com', role: 'secret_internal_role', token: 'tok', status: 'pending', expiresAt: FUTURE },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ invites }), { status: 200 })));
    await mount(<OrgInvitesPage />);
    expect(renderedRow('norole@example.com').role).toBe(ORG_UNKNOWN_VALUE_LABEL);
    const odd = renderedRow('odd@example.com');
    expect(odd.role).toBe(ORG_UNKNOWN_VALUE_LABEL);
    expect(odd.text).not.toContain('secret_internal_role');
    expect(odd.text).not.toContain('メンバー');
  });
});
