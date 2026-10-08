/**
 * tests/helpers/schema-checked-supabase.ts (本番スキーマの列を知っているフェイク) 自体のテスト
 *
 * このフェイクを信頼して「存在しない列を読むコードが失敗する」ことを確かめているので、
 * フェイクの方が列の有無や PostgREST のエラーの形を取り違えていないことをここで押さえる。
 */
import { describe, expect, it } from 'vitest';
import { createSchemaCheckedDb, schemaColumns } from './helpers/schema-checked-supabase';

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';

function gdprRow(overrides: Record<string, unknown> = {}) {
  return { id: ID_1, user_id: ID_2, requested_at: '2026-10-01T00:00:00+00:00', cancelled_at: null, ...overrides };
}

describe('schemaColumns: リポジトリ内のスキーマ定義 (本番スナップショット + 新しい migration) から列を読む', () => {
  it('gdpr_deletion_requests の列を読む。status は無い (状態は cancelled_at / executed_at で表す)', () => {
    const columns = schemaColumns('gdpr_deletion_requests');
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'user_id', 'requested_at', 'cooling_until', 'cancelled_at', 'executed_at']),
    );
    expect(columns).not.toContain('status');
  });

  it('CONSTRAINT 行を列に数えない (admin_audit_logs は CHECK 制約を持つ)', () => {
    const columns = schemaColumns('admin_audit_logs');
    expect(columns).toEqual(expect.arrayContaining(['severity', 'target_id', 'ip_address', 'user_agent']));
    expect(columns.some((name) => name.endsWith('_check'))).toBe(false);
  });

  it('型つきの列 (numeric(10,6) や boolean) も読める。llm_usage_logs の金額・トークンの列は実際の名前', () => {
    const columns = schemaColumns('llm_usage_logs');
    expect(columns).toEqual(expect.arrayContaining(['input_tokens', 'output_tokens', 'estimated_cost_usd', 'is_summary']));
    // 修正前の運営画面の API が読んでいた、存在しない列名
    for (const missing of ['prompt_tokens', 'completion_tokens', 'cost_usd']) {
      expect(columns).not.toContain(missing);
    }
  });

  it('無いテーブルは例外', () => {
    expect(() => schemaColumns('no_such_table')).toThrow(/no_such_table/);
  });
});

describe('createSchemaCheckedDb', () => {
  it('seed に本番に無い列があれば、作成時に例外にする (テスト自身の取り違えを防ぐ)', () => {
    expect(() => createSchemaCheckedDb({ gdpr_deletion_requests: [{ id: ID_1, no_such_column: 1 }] })).toThrow(/no_such_column/);
  });

  it('select に存在しない列があれば 42703 で失敗する', async () => {
    const db = createSchemaCheckedDb({ gdpr_deletion_requests: [gdprRow()] });

    const result = await db.supabase.from('gdpr_deletion_requests').select('id, no_such_column').eq('id', ID_1).single();

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({
      code: '42703',
      message: 'column gdpr_deletion_requests.no_such_column does not exist',
    });
  });

  it('フィルタ・並び替えに存在しない列があれば 42703 で失敗する', async () => {
    const db = createSchemaCheckedDb({ gdpr_deletion_requests: [gdprRow()] });
    const table = () => db.supabase.from('gdpr_deletion_requests');

    expect((await table().select('id').eq('no_such_column', 'x')).error).toMatchObject({ code: '42703' });
    // 運営画面のエクスポート一覧は、このテーブルに無い created_at で並べ替えていた
    expect((await table().select('id').order('created_at', { ascending: false })).error).toMatchObject({
      code: '42703',
      message: 'column gdpr_deletion_requests.created_at does not exist',
    });
    expect((await table().select('id').order('requested_at')).error).toBeNull();
  });

  it('update / insert の項目に存在しない列があれば PGRST204 で失敗し、何も書き換えない', async () => {
    const db = createSchemaCheckedDb({ gdpr_deletion_requests: [gdprRow()], admin_audit_logs: [] });

    const update = await db.supabase.from('gdpr_deletion_requests').update({ no_such_column: 'x' }).eq('id', ID_1);
    expect(update.error).toMatchObject({
      code: 'PGRST204',
      message: "Could not find the 'no_such_column' column of 'gdpr_deletion_requests' in the schema cache",
    });
    expect(db.tables.gdpr_deletion_requests[0]).not.toHaveProperty('no_such_column');

    const insert = await db.supabase.from('admin_audit_logs').insert({ nope: 1 });
    expect(insert.error).toMatchObject({ code: 'PGRST204' });
    expect(db.tables.admin_audit_logs).toHaveLength(0);
  });

  it('取得結果は select した列だけを持つ', async () => {
    const db = createSchemaCheckedDb({ gdpr_deletion_requests: [gdprRow()] });

    const result = await db.supabase.from('gdpr_deletion_requests').select('id, cancelled_at').eq('id', ID_1).single();

    expect(result.data).toEqual({ id: ID_1, cancelled_at: null });
  });

  it('single は 1 件でなければ PGRST116、maybeSingle は 0 件なら null', async () => {
    const db = createSchemaCheckedDb({ gdpr_deletion_requests: [gdprRow(), gdprRow({ id: ID_2 })] });
    const table = () => db.supabase.from('gdpr_deletion_requests');

    expect((await table().select('id').eq('id', ID_1).single()).data).toEqual({ id: ID_1 });
    expect((await table().select('id').eq('id', 'missing').single()).error).toMatchObject({ code: 'PGRST116' });
    expect((await table().select('id').single()).error).toMatchObject({ code: 'PGRST116' });
    expect(await table().select('id').eq('id', 'missing').maybeSingle()).toEqual({ data: null, error: null });
  });

  it('eq / is / gte / lte / order / limit', async () => {
    const db = createSchemaCheckedDb({
      llm_usage_logs: [
        { id: 'a', created_at: '2026-10-05T01:00:00.000Z', is_summary: false, total_tokens: 1 },
        { id: 'b', created_at: '2026-10-07T01:00:00.000Z', is_summary: false, total_tokens: 2 },
        { id: 'c', created_at: '2026-10-08T01:00:00.000Z', is_summary: true, total_tokens: 4 },
        { id: 'd', created_at: '2026-10-08T02:00:00.000Z', is_summary: false, total_tokens: null },
      ],
    });
    const logs = () => db.supabase.from('llm_usage_logs');

    const ranged = await logs()
      .select('id')
      .eq('is_summary', false)
      .gte('created_at', '2026-10-06')
      .lte('created_at', '2026-10-08T23:59:59Z');
    expect(ranged.data).toEqual([{ id: 'b' }, { id: 'd' }]);

    expect((await logs().select('id').is('total_tokens', null)).data).toEqual([{ id: 'd' }]);

    const newest = await logs().select('id').order('created_at', { ascending: false }).limit(2);
    expect(newest.data).toEqual([{ id: 'd' }, { id: 'c' }]);
  });

  it('update は条件に合う行だけを書き換え、.select() を付けたときだけ更新した行を返す', async () => {
    const db = createSchemaCheckedDb({
      gdpr_deletion_requests: [gdprRow(), gdprRow({ id: ID_2, cancelled_at: '2026-10-02T00:00:00+00:00' })],
    });
    const table = () => db.supabase.from('gdpr_deletion_requests');

    const none = await table().update({ cancelled_at: 'x' }).eq('id', ID_1);
    expect(none).toEqual({ data: null, error: null });

    const returned = await table().update({ cancelled_at: 'y' }).is('cancelled_at', null).select('id');
    // ID_1 は上で 'x' に書き換え済みなので、未キャンセルの行はもう無い
    expect(returned.data).toEqual([]);

    const rows = db.tables.gdpr_deletion_requests;
    expect(rows[0].cancelled_at).toBe('x');
    expect(rows[1].cancelled_at).toBe('2026-10-02T00:00:00+00:00');
  });

  it('failNext は次の 1 回だけ失敗させ、beforeNext は実行の直前にフックを呼ぶ', async () => {
    const db = createSchemaCheckedDb({ gdpr_deletion_requests: [gdprRow()] });
    const table = () => db.supabase.from('gdpr_deletion_requests');

    db.failNext('gdpr_deletion_requests', 'select', { code: 'XX000', message: 'boom', details: null, hint: null });
    expect((await table().select('id')).error).toMatchObject({ code: 'XX000' });
    expect((await table().select('id')).error).toBeNull();

    db.beforeNext('gdpr_deletion_requests', 'update', () => {
      db.tables.gdpr_deletion_requests[0].cancelled_at = 'raced';
    });
    const raced = await table().update({ cancelled_at: 'mine' }).is('cancelled_at', null).select('id');
    expect(raced.data).toEqual([]);
    expect(db.tables.gdpr_deletion_requests[0].cancelled_at).toBe('raced');
  });
});
