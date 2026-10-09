/**
 * T15 (#1154) src/lib/ai/consent.ts の単体テスト: 外国の AI 事業者への提供の同意の状況・記録・撤回
 *
 * DB は本番スキーマの列を知っているフェイク (tests/helpers/schema-checked-supabase.ts) で置き換える。
 * 存在しない列 (例: policy_version を足す前の列名の間違い) を select / insert / update すると、フェイクが
 * 本物の PostgREST と同じエラー (42703 / PGRST204) を返すので、列名の間違いも検出できる。
 *
 * 確認すること:
 *   - 状況の判定: 現行の版に全事業者が同意していれば consented。古い版・版なし・拒否の行・撤回済みは同意として数えない
 *   - 同意の記録: 3 事業者ぶんの行を、版・IP アドレス・User-Agent つきで作る。2 回目以降は行を増やさない (冪等)
 *   - 版が変わったとき: 古い有効な行に revoked_at を入れて閉じ、新しい行を作る。他人の行には触れない
 *   - 同時に押されたとき (部分ユニーク索引の 23505): 成功として扱う。それ以外の失敗は例外にする
 *   - 撤回: 本人の有効な行にだけ revoked_at を入れる。行は消さない
 *   - ヘッダーの読み取り: x-forwarded-for の先頭の値だけを使い、不正な値は捨てる
 */
import { describe, expect, it, vi } from 'vitest';
import { createSchemaCheckedDb, pgError } from '../../../../tests/helpers/schema-checked-supabase';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  getSupabaseAdmin: vi.fn(),
}));

import {
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_VERSION,
  extractClientIp,
  extractUserAgent,
  getAiConsentStatus,
  grantAiConsent,
  revokeAiConsent,
  summarizeAiConsent,
  type AiConsentRow,
} from '@/lib/ai/consent';

const TABLE = 'external_data_consents';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-08T09:00:00.000Z');

type Row = Record<string, unknown>;

function row(overrides: Row): Row {
  return {
    id: crypto.randomUUID(),
    user_id: USER,
    provider: 'xai',
    consented: true,
    consented_at: '2026-10-01T00:00:00.000Z',
    ip_address: '203.0.113.1',
    user_agent: 'old-ua',
    revoked_at: null,
    policy_version: AI_CONSENT_VERSION,
    ...overrides,
  };
}

function allGranted(userId = USER): Row[] {
  return AI_CONSENT_PROVIDERS.map((provider) => row({ user_id: userId, provider }));
}

const toRows = (rows: Row[]) => rows as unknown as AiConsentRow[];

describe('summarizeAiConsent: 同意の状況の判定', () => {
  it('行が無ければ、全事業者が none で consented = false', () => {
    const status = summarizeAiConsent([]);
    expect(status.version).toBe(AI_CONSENT_VERSION);
    expect(status.consented).toBe(false);
    expect(status.providers.map((p) => [p.provider, p.state])).toEqual(AI_CONSENT_PROVIDERS.map((p) => [p, 'none']));
    expect(status.consentedAt).toBeNull();
    expect(status.revokedAt).toBeNull();
  });

  it('現行の版に全事業者が同意していれば consented = true。同意の日時は最も新しいもの', () => {
    const rows = [
      row({ provider: 'xai', consented_at: '2026-10-01T00:00:00.000Z' }),
      row({ provider: 'google', consented_at: '2026-10-03T00:00:00.000Z' }),
      row({ provider: 'openai', consented_at: '2026-10-02T00:00:00.000Z' }),
    ];
    const status = summarizeAiConsent(toRows(rows));
    expect(status.consented).toBe(true);
    expect(status.providers.every((p) => p.state === 'granted' && p.policyVersion === AI_CONSENT_VERSION)).toBe(true);
    expect(status.consentedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(status.revokedAt).toBeNull();
  });

  it('古い版・版を記録する前 (null) の同意は outdated。consented にならない', () => {
    const rows = [
      row({ provider: 'xai', policy_version: 'old-version' }),
      row({ provider: 'google', policy_version: null }),
      row({ provider: 'openai' }),
    ];
    const status = summarizeAiConsent(toRows(rows));
    expect(status.consented).toBe(false);
    expect(status.providers.map((p) => p.state)).toEqual(['outdated', 'outdated', 'granted']);
    expect(status.providers[1].policyVersion).toBeNull();
    expect(status.consentedAt).toBeNull();
  });

  it('1 つの事業者でも欠けていれば consented = false', () => {
    const rows = allGranted().filter((r) => r.provider !== 'openai');
    const status = summarizeAiConsent(toRows(rows));
    expect(status.consented).toBe(false);
    expect(status.providers.find((p) => p.provider === 'openai')?.state).toBe('none');
  });

  it('拒否の行 (consented = false) は同意として数えない', () => {
    const rows = allGranted().map((r) => (r.provider === 'google' ? { ...r, consented: false } : r));
    const status = summarizeAiConsent(toRows(rows));
    expect(status.consented).toBe(false);
    expect(status.providers.find((p) => p.provider === 'google')?.state).toBe('none');
  });

  it('撤回済みの行 (revoked_at あり) は同意として数えず、直近の撤回の日時を返す', () => {
    const rows = AI_CONSENT_PROVIDERS.flatMap((provider, i) => [
      row({ provider, revoked_at: `2026-10-0${i + 2}T00:00:00.000Z` }),
      row({ provider, revoked_at: '2026-09-01T00:00:00.000Z', policy_version: 'older' }),
    ]);
    const status = summarizeAiConsent(toRows(rows));
    expect(status.consented).toBe(false);
    expect(status.providers.every((p) => p.state === 'none')).toBe(true);
    expect(status.providers.map((p) => p.revokedAt)).toEqual([
      '2026-10-02T00:00:00.000Z',
      '2026-10-03T00:00:00.000Z',
      '2026-10-04T00:00:00.000Z',
    ]);
    expect(status.revokedAt).toBe('2026-10-04T00:00:00.000Z');
  });

  it('撤回済みの行があっても、有効な同意が残っていれば全体の revokedAt は null', () => {
    const rows = [
      ...allGranted(),
      row({ provider: 'xai', revoked_at: '2026-09-01T00:00:00.000Z', policy_version: 'older' }),
    ];
    expect(summarizeAiConsent(toRows(rows)).revokedAt).toBeNull();
  });

  it('管理対象外の事業者 (anthropic) の行は無視する', () => {
    const rows = [...allGranted(), row({ provider: 'anthropic', policy_version: null })];
    const status = summarizeAiConsent(toRows(rows));
    expect(status.consented).toBe(true);
    expect(status.providers).toHaveLength(AI_CONSENT_PROVIDERS.length);
  });
});

describe('getAiConsentStatus: DB からの読み取り', () => {
  it('自分の行だけを読み、他人の行は混ざらない', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: [...allGranted(USER), ...allGranted(OTHER)] });
    const status = await getAiConsentStatus(USER, db.supabase as never);
    expect(status.consented).toBe(true);
    const call = db.calls.find((c) => c.table === TABLE && c.op === 'select');
    expect(call?.filters).toEqual([{ kind: 'eq', column: 'user_id', value: USER }]);
  });

  it('読み取りに失敗したら例外にする (同意済み・未同意のどちらにも見せかけない)', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: [] });
    db.failNext(TABLE, 'select', pgError('XX000', 'boom'));
    await expect(getAiConsentStatus(USER, db.supabase as never)).rejects.toThrow('getAiConsentStatus: boom');
  });
});

describe('grantAiConsent: 同意の記録', () => {
  const input = { userId: USER, ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0 test', now: NOW };

  it('3 事業者ぶんの行を、現行の版・IP アドレス・User-Agent つきで作り、consented = true を返す', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: [] });
    const status = await grantAiConsent(input, db.supabase as never);

    expect(status.consented).toBe(true);
    expect(db.tables[TABLE]).toHaveLength(3);
    for (const provider of AI_CONSENT_PROVIDERS) {
      expect(db.tables[TABLE].find((r) => r.provider === provider)).toMatchObject({
        user_id: USER,
        consented: true,
        consented_at: NOW.toISOString(),
        ip_address: '203.0.113.7',
        user_agent: 'Mozilla/5.0 test',
        policy_version: AI_CONSENT_VERSION,
      });
    }
    // 「同意しない」「あとで」の行は作らない: 作った行はすべて同意の行
    expect(db.tables[TABLE].every((r) => r.consented === true && r.revoked_at === undefined)).toBe(true);
  });

  it('IP アドレス・User-Agent が取れなかったときは null で記録する (同意の記録そのものは作る)', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: [] });
    await grantAiConsent({ ...input, ipAddress: null, userAgent: null }, db.supabase as never);
    expect(db.tables[TABLE]).toHaveLength(3);
    expect(db.tables[TABLE].every((r) => r.ip_address === null && r.user_agent === null)).toBe(true);
  });

  it('同じ版への同意が済んでいれば、何度呼んでも行を増やさず、最初の日時・IP を残す (冪等)', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: [] });
    await grantAiConsent(input, db.supabase as never);
    const callsBefore = db.calls.filter((c) => c.op === 'insert' || c.op === 'update').length;

    const second = await grantAiConsent(
      { ...input, ipAddress: '198.51.100.9', userAgent: 'other-ua', now: new Date('2026-10-09T00:00:00.000Z') },
      db.supabase as never,
    );

    expect(second.consented).toBe(true);
    expect(db.tables[TABLE]).toHaveLength(3);
    expect(db.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(callsBefore);
    expect(db.tables[TABLE].every((r) => r.ip_address === '203.0.113.7' && r.consented_at === NOW.toISOString())).toBe(true);
  });

  it('古い版の有効な行は revoked_at を入れて閉じ、現行の版の行を新しく作る。古い行は履歴として残る', async () => {
    const oldRows = AI_CONSENT_PROVIDERS.map((provider) =>
      row({ provider, policy_version: 'old-version', consented_at: '2026-09-01T00:00:00.000Z' }),
    );
    const db = createSchemaCheckedDb({ [TABLE]: oldRows });

    const status = await grantAiConsent(input, db.supabase as never);

    expect(status.consented).toBe(true);
    expect(db.tables[TABLE]).toHaveLength(6);
    const olds = db.tables[TABLE].filter((r) => r.policy_version === 'old-version');
    expect(olds).toHaveLength(3);
    expect(olds.every((r) => r.revoked_at === NOW.toISOString())).toBe(true);
    const news = db.tables[TABLE].filter((r) => r.policy_version === AI_CONSENT_VERSION);
    expect(news).toHaveLength(3);
    expect(news.every((r) => r.revoked_at === undefined || r.revoked_at === null)).toBe(true);

    // 閉じる更新は service role で行うので、行の id だけでなく、対象の利用者と「有効な行だけ」でも絞る
    const closes = db.calls.filter((c) => c.table === TABLE && c.op === 'update');
    expect(closes).toHaveLength(3);
    for (const close of closes) {
      expect(close.filters).toEqual(
        expect.arrayContaining([
          { kind: 'eq', column: 'user_id', value: USER },
          { kind: 'is', column: 'revoked_at', value: null },
        ]),
      );
    }
  });

  it('版が無い行・拒否の行 (consented = false) が有効なまま残っていても、閉じて同意の行を作る', async () => {
    const db = createSchemaCheckedDb({
      [TABLE]: [
        row({ provider: 'xai', policy_version: null }),
        row({ provider: 'google', consented: false }),
      ],
    });

    const status = await grantAiConsent(input, db.supabase as never);

    expect(status.consented).toBe(true);
    const active = db.tables[TABLE].filter((r) => r.revoked_at == null);
    expect(active).toHaveLength(3);
    expect(active.every((r) => r.consented === true && r.policy_version === AI_CONSENT_VERSION)).toBe(true);
  });

  it('他人の行には触れない', async () => {
    const others = allGranted(OTHER).map((r) => ({ ...r, policy_version: 'old-version' }));
    const db = createSchemaCheckedDb({ [TABLE]: others });
    const snapshot = JSON.stringify(others);

    await grantAiConsent(input, db.supabase as never);

    expect(JSON.stringify(db.tables[TABLE].filter((r) => r.user_id === OTHER))).toBe(snapshot);
    expect(db.tables[TABLE].filter((r) => r.user_id === USER)).toHaveLength(3);
  });

  it('同時に押されて部分ユニーク索引 (23505) に弾かれても、同意は記録されているので成功として扱う', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: [] });
    // 読み取りのあと、挿入の直前に、別のリクエストが同じ 3 件を先に作った状況
    db.beforeNext(TABLE, 'insert', () => {
      db.tables[TABLE].push(...allGranted());
    });
    db.failNext(TABLE, 'insert', pgError('23505', 'duplicate key value violates unique constraint "idx_ext_consents_active"'), 3);

    const status = await grantAiConsent(input, db.supabase as never);

    expect(status.consented).toBe(true);
    expect(db.tables[TABLE]).toHaveLength(3);
  });

  it('23505 以外の挿入の失敗は例外にする (記録できていないのに成功と見せない)', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: [] });
    db.failNext(TABLE, 'insert', pgError('42501', 'permission denied for table external_data_consents'));
    await expect(grantAiConsent(input, db.supabase as never)).rejects.toThrow('grantAiConsent: insert (xai)');
  });

  it('途中で失敗しても、もう一度呼べば続きから揃う (すでに揃っている事業者の行は増やさない)', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: allGranted().filter((r) => r.provider !== 'openai') });
    db.failNext(TABLE, 'insert', pgError('XX000', 'transient'));

    await expect(grantAiConsent(input, db.supabase as never)).rejects.toThrow('grantAiConsent: insert (openai)');
    expect(db.tables[TABLE]).toHaveLength(2);
    expect(summarizeAiConsent(toRows(db.tables[TABLE])).consented).toBe(false);

    const status = await grantAiConsent(input, db.supabase as never);
    expect(status.consented).toBe(true);
    expect(db.tables[TABLE]).toHaveLength(3);
  });

  it('有効な行の読み取りに失敗したら、何も書かずに例外にする', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: [] });
    db.failNext(TABLE, 'select', pgError('XX000', 'boom'));
    await expect(grantAiConsent(input, db.supabase as never)).rejects.toThrow('grantAiConsent: read active rows: boom');
    expect(db.tables[TABLE]).toHaveLength(0);
  });
});

describe('revokeAiConsent: 撤回', () => {
  it('本人の有効な行にだけ revoked_at を入れる。行は消さず、他人の行には触れない', async () => {
    const mine = allGranted(USER);
    const theirs = allGranted(OTHER);
    const db = createSchemaCheckedDb({ [TABLE]: [...mine, ...theirs] });

    const result = await revokeAiConsent(USER, db.supabase as never, NOW);

    expect(result).toEqual({ revokedCount: 3 });
    expect(db.tables[TABLE]).toHaveLength(6);
    expect(db.tables[TABLE].filter((r) => r.user_id === USER).every((r) => r.revoked_at === NOW.toISOString())).toBe(true);
    expect(db.tables[TABLE].filter((r) => r.user_id === OTHER).every((r) => r.revoked_at === null)).toBe(true);
    expect(summarizeAiConsent(toRows(db.tables[TABLE].filter((r) => r.user_id === USER))).consented).toBe(false);
  });

  it('すでに撤回済みの行の revoked_at は書き換えない。有効な同意が無ければ 0 件', async () => {
    const earlier = '2026-09-30T00:00:00.000Z';
    const db = createSchemaCheckedDb({ [TABLE]: allGranted().map((r) => ({ ...r, revoked_at: earlier })) });

    const result = await revokeAiConsent(USER, db.supabase as never, NOW);

    expect(result).toEqual({ revokedCount: 0 });
    expect(db.tables[TABLE].every((r) => r.revoked_at === earlier)).toBe(true);
  });

  it('撤回に失敗したら例外にする', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: allGranted() });
    db.failNext(TABLE, 'update', pgError('XX000', 'boom'));
    await expect(revokeAiConsent(USER, db.supabase as never, NOW)).rejects.toThrow('revokeAiConsent: boom');
  });

  it('撤回のあとにもう一度同意すると、新しい行ができる (撤回した行は履歴として残る)', async () => {
    const db = createSchemaCheckedDb({ [TABLE]: allGranted() });
    await revokeAiConsent(USER, db.supabase as never, NOW);
    const status = await grantAiConsent(
      { userId: USER, ipAddress: '203.0.113.8', userAgent: 'ua', now: new Date('2026-10-09T00:00:00.000Z') },
      db.supabase as never,
    );
    expect(status.consented).toBe(true);
    expect(db.tables[TABLE]).toHaveLength(6);
  });
});

describe('extractClientIp: x-forwarded-for の先頭の値', () => {
  const headers = (value: string | null) => ({ get: (name: string) => (name === 'x-forwarded-for' ? value : null) });

  it('カンマ区切りの先頭だけを使う (プロキシが後ろに足した値は使わない)', () => {
    expect(extractClientIp(headers('203.0.113.5, 10.0.0.1, 10.0.0.2'))).toBe('203.0.113.5');
  });

  it('前後の空白を取り、IPv6 も扱える', () => {
    expect(extractClientIp(headers('  2001:db8::1 , 10.0.0.1'))).toBe('2001:db8::1');
  });

  it('ポート付き ("1.2.3.4:5678", "[::1]:5678") はポートを外す', () => {
    expect(extractClientIp(headers('203.0.113.5:49152'))).toBe('203.0.113.5');
    expect(extractClientIp(headers('[2001:db8::1]:49152'))).toBe('2001:db8::1');
  });

  it('IPv6 のゾーン ID (%eth0) は外す', () => {
    expect(extractClientIp(headers('fe80::1%eth0'))).toBe('fe80::1');
  });

  it('ヘッダーが無い・空・IP アドレスでない値は null (inet の列に不正な文字列を入れて INSERT を失敗させない)', () => {
    expect(extractClientIp(headers(null))).toBeNull();
    expect(extractClientIp(headers(''))).toBeNull();
    expect(extractClientIp(headers('unknown'))).toBeNull();
    expect(extractClientIp(headers('<script>alert(1)</script>'))).toBeNull();
    expect(extractClientIp(headers('999.1.1.1'))).toBeNull();
    // 先頭が不正なら、2 番目以降の正しい値があっても使わない (先頭の値だけを見る)
    expect(extractClientIp(headers('garbage, 203.0.113.5'))).toBeNull();
  });
});

describe('extractUserAgent', () => {
  const headers = (value: string | null) => ({ get: (name: string) => (name === 'user-agent' ? value : null) });

  it('User-Agent をそのまま返す。空は null', () => {
    expect(extractUserAgent(headers('Mozilla/5.0 (X11; Linux x86_64)'))).toBe('Mozilla/5.0 (X11; Linux x86_64)');
    expect(extractUserAgent(headers(null))).toBeNull();
    expect(extractUserAgent(headers('   '))).toBeNull();
  });

  it('長すぎる値は 512 文字に切り詰める', () => {
    expect(extractUserAgent(headers('a'.repeat(2000)))).toHaveLength(512);
  });
});
