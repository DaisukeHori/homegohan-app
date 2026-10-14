/**
 * tests/award-badge.test.ts
 *
 * awardBadge (src/lib/badges/awardBadge.ts) の契約テスト (#857)。
 *
 * 背景: 旧実装は badges に存在しない列 icon_url を select していた。PostgREST が 42703 を返すため
 * 「バッジが無い」扱いで早期 return となり、バッジが一度も付与されなかった
 * (POST /api/menu-plans/add の badge_awarded が常に null)。
 * 実 DB を使う結合テスト (tests/integration/handson-tour/menu-plans-add.test.ts) でも検出できるが、
 * このテストは DB 無しの通常の `npm test` でも列名の誤りを検出できるようにする。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// awardBadge は想定外のエラーを構造化ログ (createLogger) に残す (#1306)。このテストでは記録先に書かない
vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: () => ({ ...logger, withUser: () => logger }),
    generateRequestId: () => 'req_test',
  };
});

const { awardBadge } = await import('@/lib/badges/awardBadge');

// 本番 badges テーブルに実在する列 (supabase/baseline/prod_schema.sql)
const BADGES_COLUMNS = [
  'id',
  'code',
  'name',
  'description',
  'condition_json',
  'created_at',
  'metric_code',
  'icon',
  'priority',
];

interface FakeBadge {
  id: string;
  code: string;
  name: string;
  icon: string | null;
}

interface FakeOptions {
  /** badges テーブルにある行 (無ければ null) */
  badge: FakeBadge | null;
  /** user_badges に既にある行 (未獲得なら省略) */
  existing?: { obtained_at: string } | null;
  /** user_badges への INSERT が返すエラー */
  insertError?: { code: string; message: string } | null;
}

const NO_ROWS = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };

/**
 * supabase-js の最小限の fake。
 * 本物の PostgREST と同じく、badges に存在しない列を select したら 42703 のエラーを返す。
 */
function createFakeSupabase(opts: FakeOptions) {
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table === 'badges') {
        return {
          select(columns: string) {
            const unknownColumns = columns
              .split(',')
              .map((c) => c.trim())
              .filter((c) => !BADGES_COLUMNS.includes(c));
            const unknownColumnError = () => ({
              data: null,
              error: { code: '42703', message: `column badges.${unknownColumns[0]} does not exist` },
            });
            return {
              eq: () => ({
                single: async () => {
                  if (unknownColumns.length > 0) return unknownColumnError();
                  return opts.badge ? { data: opts.badge, error: null } : { data: null, error: NO_ROWS };
                },
                // maybeSingle は 0 件をエラーにせず data: null で返す (supabase-js と同じ)
                maybeSingle: async () => {
                  if (unknownColumns.length > 0) return unknownColumnError();
                  return { data: opts.badge, error: null };
                },
              }),
            };
          },
        };
      }
      if (table === 'user_badges') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () =>
                  opts.existing ? { data: opts.existing, error: null } : { data: null, error: NO_ROWS },
                maybeSingle: async () => ({ data: opts.existing ?? null, error: null }),
              }),
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: opts.insertError ?? null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { client: client as unknown as SupabaseClient, inserted };
}

const PLANNER: FakeBadge = { id: 'badge-1', code: 'planner', name: '計画上手', icon: '📝' };

describe('awardBadge', () => {
  it('badges に実在する列だけを select し、未獲得ならバッジを付与する', async () => {
    const { client, inserted } = createFakeSupabase({ badge: PLANNER });

    const result = await awardBadge(client, 'user-1', 'planner');

    expect(result.awarded).toBe(true);
    expect(result.badge_id).toBe('badge-1');
    expect(result.name).toBe('計画上手');
    // 戻り値のキー名は icon_url のまま、値は badges.icon 列から詰める
    expect(result.icon_url).toBe('📝');
    expect(result.obtained_at).toBeTruthy();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ user_id: 'user-1', badge_id: 'badge-1' });
  });

  it('icon が null のバッジは icon_url=null で返す', async () => {
    const { client } = createFakeSupabase({ badge: { ...PLANNER, icon: null } });

    const result = await awardBadge(client, 'user-1', 'planner');

    expect(result.awarded).toBe(true);
    expect(result.icon_url).toBeNull();
  });

  it('獲得済みなら INSERT せず awarded=false (既存の obtained_at を返す)', async () => {
    const { client, inserted } = createFakeSupabase({
      badge: PLANNER,
      existing: { obtained_at: '2026-05-08T12:00:00.000Z' },
    });

    const result = await awardBadge(client, 'user-1', 'planner');

    expect(result.awarded).toBe(false);
    expect(result.obtained_at).toBe('2026-05-08T12:00:00.000Z');
    expect(result.icon_url).toBe('📝');
    expect(inserted).toHaveLength(0);
  });

  it('バッジマスターに無い code は awarded=false で、何も INSERT しない', async () => {
    const { client, inserted } = createFakeSupabase({ badge: null });

    const result = await awardBadge(client, 'user-1', 'no_such_badge');

    expect(result).toEqual({
      awarded: false,
      badge_id: null,
      obtained_at: null,
      name: null,
      icon_url: null,
    });
    expect(inserted).toHaveLength(0);
  });

  it('PK 重複 (23505) は付与済みとみなして awarded=false を返す', async () => {
    const { client } = createFakeSupabase({
      badge: PLANNER,
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const result = await awardBadge(client, 'user-1', 'planner');

    expect(result.awarded).toBe(false);
    expect(result.badge_id).toBe('badge-1');
    expect(result.icon_url).toBe('📝');
  });

  it('23505 以外の INSERT エラーは throw する (呼び出し元が握る)', async () => {
    const { client } = createFakeSupabase({
      badge: PLANNER,
      insertError: { code: '42501', message: 'new row violates row-level security policy' },
    });

    await expect(awardBadge(client, 'user-1', 'planner')).rejects.toMatchObject({ code: '42501' });
  });
});
