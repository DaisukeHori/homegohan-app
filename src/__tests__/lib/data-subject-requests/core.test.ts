/**
 * #1178 個人情報の請求 (DSR) の正典 src/lib/data-subject-requests/core.ts の単体テスト (設計 cross/15 §5・§8.3・§15)
 */
import { describe, expect, it } from 'vitest';
import {
  DSR_ACTIONABLE_STATUSES,
  DSR_ADMIN_COLUMNS,
  DSR_ADMIN_LIST_COLUMNS,
  DSR_DETAILS_MAX_LENGTH,
  DSR_OPEN_STATUSES,
  DSR_OWN_COLUMNS,
  DSR_REQUESTER_ACTION_COLUMNS,
  DSR_REQUEST_TYPES,
  DSR_REQUEST_TYPE_LABELS,
  DSR_RESPONSE_DUE_DAYS_DEFAULT,
  DSR_SHORT_ID_LENGTH,
  DSR_STATUSES,
  DSR_STATUS_LABELS,
  DSR_TERMINAL_STATUSES,
  DSR_TRANSITIONS,
  DSR_VERIFICATION_TTL_HOURS,
  DSR_VERIFY_PATH,
  buildDsrVerifyUrl,
  canWithdrawDsr,
  computeDsrDueAt,
  computeDsrVerificationExpiresAt,
  dsrAdminListQuerySchema,
  dsrAdminUpdateBodySchema,
  dsrAuditTarget,
  dsrCreateBodySchema,
  dsrIdSchema,
  dsrRequiresResponseNote,
  dsrVerifyBodySchema,
  findDsrTransition,
  isDsrOpen,
  isDsrOverdue,
  isDsrTerminal,
  isDsrVerificationExpired,
  normalizeDsrNote,
  resolveDsrResponseDueDays,
  shortDsrId,
  toDsrAdminDetailDto,
  toDsrAdminSummaryDto,
  toDsrOwnDto,
  type DsrActor,
  type DsrRow,
  type DsrStatus,
} from '@/lib/data-subject-requests/core';

const NOW = new Date('2026-10-16T03:00:00.000Z');
const BEFORE_NOW = '2026-10-16T02:59:59.999Z';
const AFTER_NOW = '2026-10-16T03:00:00.001Z';
const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'a'.repeat(64);
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function row(overrides: Partial<DsrRow> = {}): DsrRow {
  return {
    id: ID,
    user_id: USER_ID,
    request_type: 'disclosure',
    status: 'received',
    details: '登録している情報を開示してください',
    verification_method: 'email_link',
    verification_token_hash: 'f'.repeat(64),
    verification_sent_at: '2026-10-15T00:00:00.000Z',
    verification_expires_at: '2026-10-16T00:00:00.000Z',
    verification_send_count: 1,
    verified_at: '2026-10-15T01:00:00.000Z',
    due_at: '2026-11-14T01:00:00.000Z',
    response_note: '応答',
    admin_notes: '内部メモ',
    resolved_at: null,
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T01:00:00.000Z',
    ...overrides,
  };
}

function columnsOf(list: string): string[] {
  return list.split(',').map((c) => c.trim());
}

/** 設計 §8.3 の表のうち状態が変わる行 (遷移先が元の状態と違う行) の 9 本 */
const EXPECTED_TRANSITIONS: ReadonlyArray<[DsrActor, DsrStatus, DsrStatus]> = [
  ['requester', 'pending_verification', 'received'],
  ['requester', 'pending_verification', 'withdrawn'],
  ['requester', 'received', 'withdrawn'],
  ['requester', 'in_progress', 'withdrawn'],
  ['operator', 'received', 'in_progress'],
  ['operator', 'received', 'fulfilled'],
  ['operator', 'received', 'rejected'],
  ['operator', 'in_progress', 'fulfilled'],
  ['operator', 'in_progress', 'rejected'],
];

describe('dsrCreateBodySchema', () => {
  it.each(DSR_REQUEST_TYPES)('種類 %s を受け、内容は前後の空白を落とす', (requestType) => {
    const parsed = dsrCreateBodySchema.safeParse({ request_type: requestType, details: '  内容  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ request_type: requestType, details: '内容' });
  });

  it('内容が空・空白だけ・2001 字なら拒む。2000 字は通す', () => {
    expect(dsrCreateBodySchema.safeParse({ request_type: 'disclosure', details: '' }).success).toBe(false);
    expect(dsrCreateBodySchema.safeParse({ request_type: 'disclosure', details: '   ' }).success).toBe(false);
    expect(
      dsrCreateBodySchema.safeParse({ request_type: 'disclosure', details: 'あ'.repeat(DSR_DETAILS_MAX_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      dsrCreateBodySchema.safeParse({ request_type: 'disclosure', details: 'あ'.repeat(DSR_DETAILS_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(DSR_DETAILS_MAX_LENGTH).toBe(2000);
  });

  it('未知の種類・種類の欠落を拒む', () => {
    expect(dsrCreateBodySchema.safeParse({ request_type: 'deletion', details: 'x' }).success).toBe(false);
    expect(dsrCreateBodySchema.safeParse({ details: 'x' }).success).toBe(false);
  });
});

describe('dsrVerifyBodySchema', () => {
  it('64 桁の小文字の 16 進だけを通す', () => {
    expect(dsrVerifyBodySchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(dsrVerifyBodySchema.safeParse({ token: '0123456789abcdef'.repeat(4) }).success).toBe(true);
    expect(dsrVerifyBodySchema.safeParse({ token: 'a'.repeat(63) }).success).toBe(false);
    expect(dsrVerifyBodySchema.safeParse({ token: 'a'.repeat(65) }).success).toBe(false);
    expect(dsrVerifyBodySchema.safeParse({ token: 'A'.repeat(64) }).success).toBe(false);
    expect(dsrVerifyBodySchema.safeParse({ token: `${'a'.repeat(63)}g` }).success).toBe(false);
    expect(dsrVerifyBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('dsrAdminUpdateBodySchema', () => {
  it('status・response_note・admin_notes のどれも無ければ拒む', () => {
    expect(dsrAdminUpdateBodySchema.safeParse({}).success).toBe(false);
  });

  it('どれか 1 つでもあれば通す (null の応答・メモも「指定あり」)', () => {
    expect(dsrAdminUpdateBodySchema.safeParse({ status: 'in_progress' }).success).toBe(true);
    expect(dsrAdminUpdateBodySchema.safeParse({ response_note: null }).success).toBe(true);
    expect(dsrAdminUpdateBodySchema.safeParse({ admin_notes: 'メモ' }).success).toBe(true);
  });

  it.each(['withdrawn', 'pending_verification', 'received', 'unknown'])('status に %s は指定できない', (status) => {
    expect(dsrAdminUpdateBodySchema.safeParse({ status }).success).toBe(false);
  });

  it('応答・内部メモは 5000 字まで', () => {
    expect(dsrAdminUpdateBodySchema.safeParse({ response_note: 'あ'.repeat(5000) }).success).toBe(true);
    expect(dsrAdminUpdateBodySchema.safeParse({ response_note: 'あ'.repeat(5001) }).success).toBe(false);
    expect(dsrAdminUpdateBodySchema.safeParse({ admin_notes: 'あ'.repeat(5000) }).success).toBe(true);
    expect(dsrAdminUpdateBodySchema.safeParse({ admin_notes: 'あ'.repeat(5001) }).success).toBe(false);
  });
});

describe('dsrAdminListQuerySchema', () => {
  it('全部省略できる', () => {
    expect(dsrAdminListQuerySchema.safeParse({}).success).toBe(true);
  });

  it("overdue は '1' だけ ('0'・'true' を拒む)", () => {
    expect(dsrAdminListQuerySchema.safeParse({ overdue: '1' }).success).toBe(true);
    expect(dsrAdminListQuerySchema.safeParse({ overdue: '0' }).success).toBe(false);
    expect(dsrAdminListQuerySchema.safeParse({ overdue: 'true' }).success).toBe(false);
  });

  it('既知の status / request_type を通し、未知を拒む', () => {
    for (const status of DSR_STATUSES) expect(dsrAdminListQuerySchema.safeParse({ status }).success).toBe(true);
    for (const t of DSR_REQUEST_TYPES) expect(dsrAdminListQuerySchema.safeParse({ request_type: t }).success).toBe(true);
    expect(dsrAdminListQuerySchema.safeParse({ status: 'open' }).success).toBe(false);
    expect(dsrAdminListQuerySchema.safeParse({ request_type: 'deletion' }).success).toBe(false);
  });
});

describe('dsrIdSchema', () => {
  it('UUID だけを通す', () => {
    expect(dsrIdSchema.safeParse(ID).success).toBe(true);
    expect(dsrIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(dsrIdSchema.safeParse('').success).toBe(false);
  });
});

describe('DSR_TRANSITIONS / findDsrTransition (設計 §8.3)', () => {
  it('状態が変わる 9 本 (本人 4・運営 5) と 1 対 1', () => {
    expect(DSR_TRANSITIONS.map((t) => [t.actor, t.from, t.to])).toEqual(EXPECTED_TRANSITIONS);
    expect(DSR_TRANSITIONS.filter((t) => t.actor === 'requester')).toHaveLength(4);
    expect(DSR_TRANSITIONS.filter((t) => t.actor === 'operator')).toHaveLength(5);
  });

  it('本人の遷移の action は verify (→ received) と withdraw (→ withdrawn)、運営は update', () => {
    for (const t of DSR_TRANSITIONS) {
      if (t.actor === 'operator') expect(t.action).toBe('update');
      else expect(t.action).toBe(t.to === 'received' ? 'verify' : 'withdraw');
    }
  });

  it('9 本は非 null、それ以外の (actor 2 × from 6 × to 6) はすべて null (同じ状態の指定・自己ループを含む)', () => {
    const expected = new Set(EXPECTED_TRANSITIONS.map(([a, f, t]) => `${a}:${f}:${t}`));
    let found = 0;
    for (const actor of ['requester', 'operator'] as const) {
      for (const from of DSR_STATUSES) {
        for (const to of DSR_STATUSES) {
          const transition = findDsrTransition(actor, from, to);
          if (expected.has(`${actor}:${from}:${to}`)) {
            expect(transition).toEqual(expect.objectContaining({ actor, from, to }));
            found += 1;
          } else {
            expect(transition, `${actor}:${from}:${to}`).toBeNull();
          }
        }
      }
    }
    expect(found).toBe(EXPECTED_TRANSITIONS.length);
    expect(findDsrTransition('operator', 'in_progress', 'in_progress')).toBeNull();
    expect(findDsrTransition('requester', 'pending_verification', 'pending_verification')).toBeNull();
  });
});

describe('状態の集合と判定', () => {
  it('OPEN と TERMINAL は排他で、和が全 6 値。ACTIONABLE ⊂ OPEN', () => {
    for (const status of DSR_STATUSES) expect(isDsrOpen(status)).toBe(!isDsrTerminal(status));
    expect([...DSR_OPEN_STATUSES, ...DSR_TERMINAL_STATUSES].sort()).toEqual([...DSR_STATUSES].sort());
    for (const status of DSR_ACTIONABLE_STATUSES) expect(DSR_OPEN_STATUSES).toContain(status);
    expect(DSR_OPEN_STATUSES).toEqual(['pending_verification', 'received', 'in_progress']);
    expect(DSR_ACTIONABLE_STATUSES).toEqual(['received', 'in_progress']);
  });

  it('isDsrOpen / isDsrTerminal の値 (6 値)', () => {
    expect(DSR_STATUSES.filter(isDsrOpen)).toEqual(['pending_verification', 'received', 'in_progress']);
    expect(DSR_STATUSES.filter(isDsrTerminal)).toEqual(['fulfilled', 'rejected', 'withdrawn']);
  });

  it('dsrRequiresResponseNote: fulfilled・rejected だけ true', () => {
    expect(DSR_STATUSES.filter(dsrRequiresResponseNote)).toEqual(['fulfilled', 'rejected']);
  });

  it('canWithdrawDsr: pending_verification・received・in_progress だけ true', () => {
    expect(DSR_STATUSES.filter(canWithdrawDsr)).toEqual(['pending_verification', 'received', 'in_progress']);
  });
});

describe('isDsrVerificationExpired', () => {
  it('pending_verification かつ expires_at < now だけ true', () => {
    expect(isDsrVerificationExpired({ status: 'pending_verification', verification_expires_at: BEFORE_NOW }, NOW)).toBe(true);
    expect(isDsrVerificationExpired({ status: 'pending_verification', verification_expires_at: NOW.toISOString() }, NOW)).toBe(
      false,
    );
    expect(isDsrVerificationExpired({ status: 'pending_verification', verification_expires_at: AFTER_NOW }, NOW)).toBe(false);
    expect(isDsrVerificationExpired({ status: 'pending_verification', verification_expires_at: null }, NOW)).toBe(false);
  });

  it.each(DSR_STATUSES.filter((s) => s !== 'pending_verification'))('%s は期限を過ぎていても false', (status) => {
    expect(isDsrVerificationExpired({ status, verification_expires_at: BEFORE_NOW }, NOW)).toBe(false);
  });
});

describe('isDsrOverdue', () => {
  it.each(['received', 'in_progress'] as const)('%s かつ due_at < now だけ true', (status) => {
    expect(isDsrOverdue({ status, due_at: BEFORE_NOW }, NOW)).toBe(true);
    expect(isDsrOverdue({ status, due_at: NOW.toISOString() }, NOW)).toBe(false);
    expect(isDsrOverdue({ status, due_at: AFTER_NOW }, NOW)).toBe(false);
    expect(isDsrOverdue({ status, due_at: null }, NOW)).toBe(false);
  });

  it.each(['pending_verification', 'fulfilled', 'rejected', 'withdrawn'] as const)(
    '%s は期限を過ぎていても false (終わった請求・未受付は超過と数えない)',
    (status) => {
      expect(isDsrOverdue({ status, due_at: BEFORE_NOW }, NOW)).toBe(false);
    },
  );
});

describe('期限の計算', () => {
  it('computeDsrDueAt: 受付から 30 日後 (日数ぶんのミリ秒を足す)', () => {
    expect(computeDsrDueAt(NOW, DSR_RESPONSE_DUE_DAYS_DEFAULT).toISOString()).toBe('2026-11-15T03:00:00.000Z');
    expect(computeDsrDueAt(NOW, 1).getTime() - NOW.getTime()).toBe(MS_PER_DAY);
  });

  it('computeDsrVerificationExpiresAt: 送った時刻 + DSR_VERIFICATION_TTL_HOURS 時間', () => {
    expect(DSR_VERIFICATION_TTL_HOURS).toBe(24);
    expect(computeDsrVerificationExpiresAt(NOW).getTime() - NOW.getTime()).toBe(DSR_VERIFICATION_TTL_HOURS * MS_PER_HOUR);
  });
});

describe('resolveDsrResponseDueDays', () => {
  it.each([
    ['30', 30],
    ['1', 1],
    ['365', 365],
    [' 45 ', 45],
  ])('%j → %d', (raw, expected) => {
    expect(resolveDsrResponseDueDays(raw)).toBe(expected);
  });

  it.each([undefined, '', '   ', '0', '-1', '1.5', '1e2', '366', '0x10', '+5', '030', 'abc'])(
    '%j は既定 (30)',
    (raw) => {
      expect(resolveDsrResponseDueDays(raw)).toBe(DSR_RESPONSE_DUE_DAYS_DEFAULT);
    },
  );
});

describe('shortDsrId / normalizeDsrNote / buildDsrVerifyUrl', () => {
  it('shortDsrId: 先頭 DSR_SHORT_ID_LENGTH 文字', () => {
    expect(DSR_SHORT_ID_LENGTH).toBe(8);
    expect(shortDsrId(ID)).toBe('0a1b2c3d');
  });

  it('normalizeDsrNote: null・undefined・空白だけ → null、それ以外は trim せずそのまま', () => {
    expect(normalizeDsrNote(null)).toBeNull();
    expect(normalizeDsrNote(undefined)).toBeNull();
    expect(normalizeDsrNote('')).toBeNull();
    expect(normalizeDsrNote(' \n\t ')).toBeNull();
    expect(normalizeDsrNote('  応答  ')).toBe('  応答  ');
  });

  it('buildDsrVerifyUrl: `${siteUrl}${DSR_VERIFY_PATH}?id=…&token=…` で、id と token を読み戻せる', () => {
    const url = buildDsrVerifyUrl('https://app.example.test', ID, TOKEN);
    expect(url.startsWith(`https://app.example.test${DSR_VERIFY_PATH}?`)).toBe(true);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(DSR_VERIFY_PATH);
    expect(parsed.searchParams.get('id')).toBe(ID);
    expect(parsed.searchParams.get('token')).toBe(TOKEN);
  });
});

describe('列の一覧 (migration の列の GRANT と同じ 15 列)', () => {
  it('DSR_OWN_COLUMNS は 15 列で admin_notes と verification_token_hash を含まない', () => {
    const own = columnsOf(DSR_OWN_COLUMNS);
    expect(own).toHaveLength(15);
    expect(new Set(own).size).toBe(15);
    expect(own).not.toContain('admin_notes');
    expect(own).not.toContain('verification_token_hash');
    expect(own).toContain('user_id');
  });

  it('DSR_ADMIN_LIST_COLUMNS の列はすべて DSR_OWN_COLUMNS に含まれる (authenticated で読める)', () => {
    const own = new Set(columnsOf(DSR_OWN_COLUMNS));
    for (const column of columnsOf(DSR_ADMIN_LIST_COLUMNS)) expect(own.has(column), column).toBe(true);
    expect(columnsOf(DSR_ADMIN_LIST_COLUMNS)).not.toContain('details');
    expect(columnsOf(DSR_ADMIN_LIST_COLUMNS)).not.toContain('response_note');
  });

  it('DSR_ADMIN_COLUMNS は DSR_OWN_COLUMNS + admin_notes、DSR_REQUESTER_ACTION_COLUMNS は DSR_OWN_COLUMNS + verification_token_hash', () => {
    expect(columnsOf(DSR_ADMIN_COLUMNS)).toEqual([...columnsOf(DSR_OWN_COLUMNS), 'admin_notes']);
    expect(columnsOf(DSR_REQUESTER_ACTION_COLUMNS)).toEqual([...columnsOf(DSR_OWN_COLUMNS), 'verification_token_hash']);
  });
});

describe('DTO への変換', () => {
  it('toDsrOwnDto: hash・admin_notes・user_id を含まず、verification_expired を計算する', () => {
    const { verification_token_hash: _hash, admin_notes: _notes, ...ownRow } = row({
      status: 'pending_verification',
      verified_at: null,
      due_at: null,
      verification_expires_at: BEFORE_NOW,
    });
    const dto = toDsrOwnDto(ownRow, NOW);
    expect(dto).not.toHaveProperty('verification_token_hash');
    expect(dto).not.toHaveProperty('admin_notes');
    expect(dto).not.toHaveProperty('user_id');
    expect(dto.verification_expired).toBe(true);
    expect(dto).toMatchObject({ id: ID, status: 'pending_verification', details: ownRow.details, verification_send_count: 1 });
    expect(toDsrOwnDto({ ...ownRow, verification_expires_at: AFTER_NOW }, NOW).verification_expired).toBe(false);
  });

  it('toDsrOwnDto: 返す鍵は DSR_OWN_COLUMNS から user_id を除き verification_expired を足したもの', () => {
    const { verification_token_hash: _hash, admin_notes: _notes, ...ownRow } = row();
    const keys = Object.keys(toDsrOwnDto(ownRow, NOW)).sort();
    const expected = [...columnsOf(DSR_OWN_COLUMNS).filter((c) => c !== 'user_id'), 'verification_expired'].sort();
    expect(keys).toEqual(expected);
  });

  it('toDsrAdminSummaryDto: overdue を isDsrOverdue で計算し、requester_nickname を写す', () => {
    const overdue = toDsrAdminSummaryDto(row({ status: 'in_progress', due_at: BEFORE_NOW }), 'たろう', NOW);
    expect(overdue).toMatchObject({ overdue: true, requester_nickname: 'たろう', user_id: USER_ID, status: 'in_progress' });
    expect(toDsrAdminSummaryDto(row({ status: 'fulfilled', due_at: BEFORE_NOW }), null, NOW).overdue).toBe(false);
    expect(toDsrAdminSummaryDto(row({ due_at: AFTER_NOW }), null, NOW)).toMatchObject({ overdue: false, requester_nickname: null });
  });

  it('toDsrAdminDetailDto: hash を含まず admin_notes と requester を含む', () => {
    const { verification_token_hash: _hash, ...adminRow } = row();
    const requester = { user_id: USER_ID, nickname: 'たろう', email: 'taro@example.com' };
    const dto = toDsrAdminDetailDto(adminRow, requester, NOW);
    expect(dto).not.toHaveProperty('verification_token_hash');
    expect(dto).toMatchObject({
      admin_notes: '内部メモ',
      response_note: '応答',
      details: adminRow.details,
      requester,
      requester_nickname: 'たろう',
    });
  });

  it('toDsrAdminDetailDto: requester が null (退会済み) なら requester_nickname も null', () => {
    const { verification_token_hash: _hash, ...adminRow } = row({ user_id: null });
    const dto = toDsrAdminDetailDto(adminRow, null, NOW);
    expect(dto.requester).toBeNull();
    expect(dto.requester_nickname).toBeNull();
    expect(dto.user_id).toBeNull();
  });
});

describe('dsrAuditTarget', () => {
  it('user_id があれば本人 (user)、無ければ請求そのもの (data_subject_request)', () => {
    expect(dsrAuditTarget({ id: ID, user_id: USER_ID })).toEqual({ targetId: USER_ID, targetType: 'user' });
    expect(dsrAuditTarget({ id: ID, user_id: null })).toEqual({ targetId: ID, targetType: 'data_subject_request' });
  });
});

describe('ラベル', () => {
  it('全状態・全種類にラベルがある', () => {
    for (const status of DSR_STATUSES) expect(DSR_STATUS_LABELS[status]).toBeTruthy();
    for (const t of DSR_REQUEST_TYPES) expect(DSR_REQUEST_TYPE_LABELS[t]).toBeTruthy();
    expect(Object.keys(DSR_STATUS_LABELS).sort()).toEqual([...DSR_STATUSES].sort());
    expect(Object.keys(DSR_REQUEST_TYPE_LABELS).sort()).toEqual([...DSR_REQUEST_TYPES].sort());
  });
});
