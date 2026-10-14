/**
 * #1184 宛先停止リスト (email_blacklist) の読み書きを、ローカル Supabase の実 DB に対して確かめる。
 *
 * src/__tests__/lib/emails/suppression.test.ts の単体テストは Supabase のクライアントを差し替えているので、
 * 実際の表の制約 (email の主キー・reason の CHECK) と PostgREST の upsert / in の振る舞いはそこでは確かめられない。
 * ここでは src/lib/emails/suppression.ts の関数を、service_role の実クライアントでそのまま呼ぶ。
 *   B-1: ハードバウンスの宛先を入れると、小文字にそろえた形で 1 行入り、大文字を含む形で引いても suppressed になる
 *   B-2: 同じ宛先に別の理由・別の時刻で入れ直しても、最初の理由と時刻のまま (ON CONFLICT DO NOTHING・冪等)
 *   B-3: 1 回の呼び出しに大文字小文字だけ違う同じ宛先が並んでも、失敗せず 1 行だけ入る
 *   B-4: 運営が手で入れた 'manual' の行は上書きしない。大文字を含む形のまま入った行も、その形で引けば suppressed になる
 *   B-5: 載っていない宛先は clear
 *
 * 実行:
 *   bash scripts/supabase-local.sh start
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/email-blacklist-suppression.test.ts
 *
 * 自分の行は宛先の目印 (ADDRESS_MARK) で識別し、開始時と終了時に必ず削除する。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const admin: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

// suppression.ts が使う service_role のクライアントを、テストの実クライアントにする (表は実物)
vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => admin,
}));

const { addToEmailBlacklist, lookupEmailSuppression } = await import('@/lib/emails/suppression');

/** このテストが入れる宛先の目印 (ローカル部に含める)。後始末はこれで探す */
const ADDRESS_MARK = `it1184-${Date.now()}-${randomBytes(4).toString('hex')}`;
/** 宛先のドメイン (予約済みの .test。実在の宛先にならない) */
const ADDRESS_DOMAIN = 'example.test';

const address = (label: string) => `${ADDRESS_MARK}-${label}@${ADDRESS_DOMAIN}`;

const FIRST_ADDED_AT = '2026-10-01T00:00:00.000Z';
const LATER_ADDED_AT = '2026-10-02T00:00:00.000Z';

interface BlacklistRow {
  email: string;
  reason: string;
  added_at: string;
}

async function rowsOf(emails: readonly string[]): Promise<BlacklistRow[]> {
  const { data, error } = await admin
    .from('email_blacklist')
    .select('email, reason, added_at')
    .in('email', [...emails]);
  if (error) throw error;
  return (data ?? []) as BlacklistRow[];
}

async function cleanup(): Promise<void> {
  const { error } = await admin.from('email_blacklist').delete().ilike('email', `${ADDRESS_MARK}-%`);
  if (error) throw error;
}

beforeAll(cleanup);
afterAll(cleanup);

describe('#1184 email_blacklist の読み書き (実 DB)', () => {
  it('B-1: 小文字にそろえた形で 1 行入り、大文字を含む形で引いても suppressed になる', async () => {
    const lower = address('hard');
    const mixed = `  ${lower.toUpperCase()}  `;

    await expect(addToEmailBlacklist([mixed], 'bounce', FIRST_ADDED_AT)).resolves.toEqual({ ok: true });

    const rows = await rowsOf([lower, mixed.trim()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(lower);
    expect(rows[0].reason).toBe('bounce');
    expect(Date.parse(rows[0].added_at)).toBe(Date.parse(FIRST_ADDED_AT));

    await expect(lookupEmailSuppression(lower.toUpperCase())).resolves.toEqual({ status: 'suppressed', reason: 'bounce' });
    await expect(lookupEmailSuppression(lower)).resolves.toEqual({ status: 'suppressed', reason: 'bounce' });
  });

  it('B-2: 同じ宛先に別の理由・時刻で入れ直しても、最初の理由と時刻のまま (冪等)', async () => {
    const lower = address('repeat');

    await expect(addToEmailBlacklist([lower], 'bounce', FIRST_ADDED_AT)).resolves.toEqual({ ok: true });
    await expect(addToEmailBlacklist([lower], 'complaint', LATER_ADDED_AT)).resolves.toEqual({ ok: true });
    await expect(addToEmailBlacklist([lower], 'bounce', LATER_ADDED_AT)).resolves.toEqual({ ok: true });

    const rows = await rowsOf([lower]);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('bounce');
    expect(Date.parse(rows[0].added_at)).toBe(Date.parse(FIRST_ADDED_AT));
  });

  it('B-3: 1 回の呼び出しに大文字小文字だけ違う同じ宛先が並んでも、失敗せず 1 行だけ入る', async () => {
    const lower = address('dup');

    await expect(
      addToEmailBlacklist([lower, lower.toUpperCase(), ` ${lower} `], 'complaint', FIRST_ADDED_AT),
    ).resolves.toEqual({ ok: true });

    const rows = await rowsOf([lower]);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('complaint');
  });

  it("B-4: 運営が手で入れた 'manual' の行は上書きせず、大文字を含む形のまま入った行もその形で引ける", async () => {
    const lower = address('manual');
    // 小文字の形の行は入れない (引き当てが元の形の候補で当たったことを確かめるため)
    const operatorForm = `${ADDRESS_MARK}-Operator@${ADDRESS_DOMAIN}`;
    expect(await rowsOf([operatorForm.toLowerCase()])).toHaveLength(0);

    const { error } = await admin.from('email_blacklist').insert([
      { email: lower, reason: 'manual', added_at: FIRST_ADDED_AT },
      { email: operatorForm, reason: 'manual', added_at: FIRST_ADDED_AT },
    ]);
    expect(error).toBeNull();

    await expect(addToEmailBlacklist([lower], 'bounce', LATER_ADDED_AT)).resolves.toEqual({ ok: true });
    const rows = await rowsOf([lower]);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('manual');
    expect(Date.parse(rows[0].added_at)).toBe(Date.parse(FIRST_ADDED_AT));

    await expect(lookupEmailSuppression(operatorForm)).resolves.toEqual({ status: 'suppressed', reason: 'manual' });
  });

  it('B-5: 載っていない宛先は clear', async () => {
    await expect(lookupEmailSuppression(address('absent'))).resolves.toEqual({ status: 'clear' });
  });
});
