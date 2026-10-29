/**
 * #1457: GET / PUT /api/super-admin/settings — 使われていない system_settings の key は読み取り専用
 *
 * system_settings の key='feature_flags' の行は、機能フラグの置き場が feature_flags テーブルに移って (#1148)、
 * もう何も読まない。運営が「効いている」と思って編集しないよう、
 *   - GET は、その行に read_only: true と note (説明) を付ける。ほかの行は read_only: false / note: null
 *   - PUT は、その key を書き換えず 409 SETTING_READ_ONLY を返す (DB に書かない)
 * 行そのものは消さない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  selectResult: { data: [] as unknown[] | null, error: null as unknown },
  upsert: vi.fn(),
  /** upsert を送った client (本人のセッション / service_role。書き込みは service_role だけ。#1917 の続き) */
  upsertClient: vi.fn(),
  from: vi.fn(),
  selectColumns: vi.fn(),
}));

vi.mock('@/lib/auth/helpers', () => ({ requireRole: h.requireRole }));

vi.mock('@/lib/supabase/server', () => {
  const fakeClient = (client: 'session' | 'admin') => ({
    from: (table: string) => {
      h.from(table);
      return {
        select: (columns: string) => {
          h.selectColumns(columns);
          return { order: async () => h.selectResult };
        },
        upsert: async (row: unknown) => {
          h.upsert(row);
          h.upsertClient(client);
          return { error: null };
        },
      };
    },
  });
  return { createClient: () => fakeClient('session'), getSupabaseAdmin: () => fakeClient('admin') };
});

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: vi.fn() })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

import { GET, PUT } from '../src/app/api/super-admin/settings/route';
import {
  RETIRED_SETTING_KEYS,
  SETTING_READ_ONLY_CODE,
  SETTING_READ_ONLY_MESSAGE,
  retiredSettingNoteOf,
} from '../src/lib/super-admin/retired-settings';

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/super-admin/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockResolvedValue({ id: 'admin-1', roles: ['super_admin'] });
  h.selectResult = { data: [], error: null };
});

describe('使われていない key の一覧', () => {
  it('旧 feature_flags 行だけが載っている (機能フラグの置き場は feature_flags テーブル)', () => {
    expect(Object.keys(RETIRED_SETTING_KEYS)).toEqual(['feature_flags']);
    expect(retiredSettingNoteOf('feature_flags')).toBe(RETIRED_SETTING_KEYS.feature_flags);
    expect(retiredSettingNoteOf('support_email')).toBeNull();
    // Object の組み込みの名前を「使われていない key」と取り違えない
    expect(retiredSettingNoteOf('toString')).toBeNull();
    expect(retiredSettingNoteOf('constructor')).toBeNull();
  });
});

describe('GET /api/super-admin/settings', () => {
  it('使われていない key の行に read_only: true と note を付ける。ほかの行は read_only: false / note: null', async () => {
    h.selectResult = {
      data: [
        { key: 'feature_flags', value: { menu_generation_v5_direct: true }, updated_at: '2026-09-01T00:00:00Z' },
        { key: 'support_email', value: 'support@example.com', updated_at: '2026-09-02T00:00:00Z' },
      ],
      error: null,
    };

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { settings: Array<Record<string, unknown>> };
    expect(json.settings).toEqual([
      {
        key: 'feature_flags',
        value: { menu_generation_v5_direct: true },
        updated_at: '2026-09-01T00:00:00Z',
        read_only: true,
        note: RETIRED_SETTING_KEYS.feature_flags,
      },
      {
        key: 'support_email',
        value: 'support@example.com',
        updated_at: '2026-09-02T00:00:00Z',
        read_only: false,
        note: null,
      },
    ]);
    // 行は消さない (読むだけ)
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('#1486 GET / PUT の列の名前 (DB の列の名前のまま返す)', () => {
  it('GET は description と updated_at を、DB の列の名前のまま返す', async () => {
    h.selectResult = {
      data: [{ key: 'support_email', value: 'support@example.com', description: '問い合わせ先', updated_at: '2026-09-02T00:00:00Z' }],
      error: null,
    };

    const json = (await (await GET()).json()) as { settings: Array<Record<string, unknown>> };

    const columns = String(h.selectColumns.mock.calls[0]?.[0] ?? '')
      .split(',')
      .map((c) => c.trim());
    expect(columns).toEqual(expect.arrayContaining(['key', 'value', 'description', 'updated_at']));
    expect(json.settings[0]).toMatchObject({ description: '問い合わせ先', updated_at: '2026-09-02T00:00:00Z' });
    expect(json.settings[0]).not.toHaveProperty('updatedAt');
  });

  it.each([
    ['文字列は前後の空白を除いて保存', '  問い合わせ先  ', '問い合わせ先'],
    ['空の文字列は null (説明を消す)', '   ', null],
    ['null は null (説明を消す)', null, null],
  ])('PUT の description: %s', async (_label, description, saved) => {
    const res = await PUT(putRequest({ key: 'support_email', value: 'new@example.com', description }));

    expect(res.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ key: 'support_email', description: saved }));
  });

  it('PUT で description を省略したら、説明を書き換えない (upsert に description を含めない)', async () => {
    await PUT(putRequest({ key: 'support_email', value: 'new@example.com' }));

    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert.mock.calls[0][0]).not.toHaveProperty('description');
  });

  it('PUT の description が文字列でも null でもなければ 400 (DB に書かない)', async () => {
    const res = await PUT(putRequest({ key: 'support_email', value: 'x', description: 123 }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('PUT /api/super-admin/settings', () => {
  it.each([
    ['そのままの key', 'feature_flags'],
    ['前後に空白のある key', '  feature_flags  '],
  ])('使われていない key (%s) は書き換えず、409 SETTING_READ_ONLY', async (_label, key) => {
    const res = await PUT(putRequest({ key, value: { menu_generation_v5_direct: false } }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: SETTING_READ_ONLY_CODE, message: SETTING_READ_ONLY_MESSAGE } });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it('使われている key は、これまでどおり書き換える', async () => {
    const res = await PUT(putRequest({ key: 'support_email', value: 'new@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, key: 'support_email' });
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'support_email', value: 'new@example.com', updated_by: 'admin-1' }),
    );
    // 書き込みは service_role の client から (運営の直接の書き込みのポリシーは消した。#1917 の続き)
    expect(h.upsertClient.mock.calls).toEqual([['admin']]);
  });

  it('認可の判定は、使われていない key の判定より先 (super_admin 以外には 409 ではなく 403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/errors');
    h.requireRole.mockRejectedValue(new ForbiddenError('FORBIDDEN', '権限がありません'));

    const res = await PUT(putRequest({ key: 'feature_flags', value: {} }));

    expect(res.status).toBe(403);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
