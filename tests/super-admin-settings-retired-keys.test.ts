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
  from: vi.fn(),
}));

vi.mock('@/lib/auth/helpers', () => ({ requireRole: h.requireRole }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    from: (table: string) => {
      h.from(table);
      return {
        select: () => ({ order: async () => h.selectResult }),
        upsert: async (row: unknown) => {
          h.upsert(row);
          return { error: null };
        },
      };
    },
  }),
}));

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
  });

  it('認可の判定は、使われていない key の判定より先 (super_admin 以外には 409 ではなく 403)', async () => {
    const { ForbiddenError } = await import('@/lib/auth/errors');
    h.requireRole.mockRejectedValue(new ForbiddenError('FORBIDDEN', '権限がありません'));

    const res = await PUT(putRequest({ key: 'feature_flags', value: {} }));

    expect(res.status).toBe(403);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
