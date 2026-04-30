/**
 * Wave 2 / F17: API セキュリティ修正の contract テスト
 * Issues: #163 #165 #166 #168 #169 #186 #187
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// --- shared supabase mock ---
const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockRefreshSession = vi.fn();
const mockFrom = vi.fn();
const mockStorageFrom = vi.fn();

const supabaseClient = {
  auth: {
    getUser: mockGetUser,
    getSession: mockGetSession,
    refreshSession: mockRefreshSession,
  },
  from: mockFrom,
  storage: { from: mockStorageFrom },
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => supabaseClient,
}));

// @supabase/supabase-js の直接インスタンス (service_role 用) もモック
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => supabaseClient,
}));

// ─────────────────────────────────────────────
// #163 /api/log — 認証なし書き込み禁止
// ─────────────────────────────────────────────
import { POST as logPOST } from '../src/app/api/log/route';

describe('#163 /api/log POST', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // service_role 呼び出しに必要な環境変数をテスト用に設定
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it('未認証リクエストを 401 で拒否する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = new Request('http://localhost/api/log', {
      method: 'POST',
      body: JSON.stringify({ level: 'error', message: 'hack' }),
    });
    const res = await logPOST(req as any);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'Unauthorized' });
  });

  it('必須フィールド不足で 400 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = new Request('http://localhost/api/log', {
      method: 'POST',
      body: JSON.stringify({ level: 'error' }), // message なし
    });
    const res = await logPOST(req as any);
    // message 不足 → 400 (認証チェック前にフィールド検証が走る)
    expect(res.status).toBe(400);
  });

  it('認証済みユーザーはログを書き込める', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } }, error: null });
    const insertFn = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertFn });

    const req = new Request('http://localhost/api/log', {
      method: 'POST',
      body: JSON.stringify({ level: 'info', message: 'ok', metadata: {} }),
    });
    const res = await logPOST(req as any);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });
  });
});

// ─────────────────────────────────────────────
// #165 /api/auth/session-sync — トークン非露出
// ─────────────────────────────────────────────
import { POST as sessionSyncPOST } from '../src/app/api/auth/session-sync/route';

describe('#165 /api/auth/session-sync POST', () => {
  beforeEach(() => vi.resetAllMocks());

  it('未認証時は 401 を返す', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockRefreshSession.mockResolvedValue({ data: { session: null }, error: { message: 'no session' } });
    const res = await sessionSyncPOST();
    expect(res.status).toBe(401);
  });

  it('認証済み時のレスポンスボディにトークンを含まない', async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'secret-access',
          refresh_token: 'secret-refresh',
          user: { id: 'uid-1' },
        },
      },
      error: null,
    });
    const res = await sessionSyncPOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('refreshToken');
    expect(body).toMatchObject({ ok: true });
  });
});

// ─────────────────────────────────────────────
// #166 /api/contact — rate limit
// ─────────────────────────────────────────────
import { POST as contactPOST } from '../src/app/api/contact/route';

describe('#166 /api/contact POST rate limit', () => {
  const validBody = JSON.stringify({
    inquiryType: 'general',
    email: 'test@example.com',
    subject: 'hello',
    message: 'world',
  });

  function makeRequest(ip = '1.2.3.4') {
    return new Request('http://localhost/api/contact', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
      body: validBody,
    }) as any;
  }

  beforeEach(() => vi.resetAllMocks());

  it('通常リクエストは 429 にならない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const insertChain = { select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: '1' }, error: null }) };
    mockFrom.mockReturnValue({ insert: vi.fn().mockReturnValue(insertChain) });

    const res = await contactPOST(makeRequest('10.0.0.1'));
    expect(res.status).not.toBe(429);
  });

  it('同一 IP から 11 回目のリクエストは 429 を返す', async () => {
    // モジュールを動的 import して rate limit map を含む状態にする
    // 11 回連続リクエスト (same IP)
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const insertChain = {
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: '1' }, error: null }),
    };
    mockFrom.mockReturnValue({ insert: vi.fn().mockReturnValue(insertChain) });

    const ip = `rate-limit-test-${Date.now()}`;
    let lastRes: any;
    for (let i = 0; i < 11; i++) {
      lastRes = await contactPOST(makeRequest(ip));
    }
    expect(lastRes.status).toBe(429);
  });
});

// ─────────────────────────────────────────────
// #168 /api/recipes/[id]/comments GET — user_id 非公開
// ─────────────────────────────────────────────
import { GET as commentsGET } from '../src/app/api/recipes/[id]/comments/route';

describe('#168 /api/recipes/[id]/comments GET', () => {
  beforeEach(() => vi.resetAllMocks());

  it('未認証でもコメント一覧を取得できる', async () => {
    const selectChain = {
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'c1',
            content: 'おいしい',
            rating: 5,
            created_at: '2024-01-01',
            user_profiles: { nickname: 'Alice' },
          },
        ],
        error: null,
      }),
    };
    mockFrom.mockReturnValue({ select: vi.fn().mockReturnValue(selectChain) });

    const res = await commentsGET(new Request('http://localhost/api/recipes/r1/comments'), {
      params: { id: 'r1' },
    });
    expect(res.status).toBe(200);
    const { comments } = await res.json();
    expect(comments).toHaveLength(1);
    // user_id がレスポンスに含まれないこと
    expect(comments[0]).not.toHaveProperty('userId');
    expect(comments[0]).toHaveProperty('authorName', 'Alice');
  });
});

// ─────────────────────────────────────────────
// #169 /api/recipes/[id] GET — 未認証で view_count 更新しない
// ─────────────────────────────────────────────
import { GET as recipeGET } from '../src/app/api/recipes/[id]/route';

describe('#169 /api/recipes/[id] GET view_count', () => {
  const recipeRow = {
    id: 'r1',
    user_id: 'uid-owner',
    is_public: true,
    name: 'Test',
    description: '',
    calories_kcal: null,
    cooking_time_minutes: null,
    servings: null,
    image_url: null,
    ingredients: [],
    steps: [],
    category: null,
    cuisine_type: null,
    difficulty: null,
    tags: [],
    nutrition: null,
    tips: null,
    video_url: null,
    source_url: null,
    view_count: 5,
    like_count: 0,
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    user_profiles: { nickname: 'Owner', id: 'uid-owner' },
    recipe_likes: [],
    recipe_comments: [],
  };

  beforeEach(() => vi.resetAllMocks());

  it('未認証リクエストでは view_count を更新しない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const updateFn = vi.fn();
    const selectChainDetail = {
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: recipeRow, error: null }),
    };
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue(selectChainDetail),
      update: updateFn,
    });

    const res = await recipeGET(new Request('http://localhost/api/recipes/r1'), {
      params: { id: 'r1' },
    });
    expect(res.status).toBe(200);
    // update が呼ばれていないこと
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('認証済みリクエストでは view_count を更新する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-reader' } }, error: null });

    const updateChain = { eq: vi.fn().mockResolvedValue({ error: null }) };
    const updateFn = vi.fn().mockReturnValue(updateChain);
    const singleForCount = vi.fn().mockResolvedValue({ data: { view_count: 5 }, error: null });
    const singleForDetail = vi.fn().mockResolvedValue({ data: recipeRow, error: null });

    let callCount = 0;
    const eqChain = {
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? singleForCount() : singleForDetail();
      }),
    };
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue(eqChain),
      update: updateFn,
    });

    const res = await recipeGET(new Request('http://localhost/api/recipes/r1'), {
      params: { id: 'r1' },
    });
    expect(res.status).toBe(200);
    expect(updateFn).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// #186 /api/upload — MIME / size 検証
// ─────────────────────────────────────────────
import { POST as uploadPOST } from '../src/app/api/upload/route';

function makeJpegBuffer() {
  return new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]); // JPEG magic
}

function makeFakeBuffer() {
  return new Uint8Array([0x00, 0x01, 0x02, 0x03]);
}

function makeUploadRequest(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return new Request('http://localhost/api/upload', {
    method: 'POST',
    body: formData,
  }) as any;
}

describe('#186 /api/upload POST', () => {
  beforeEach(() => vi.resetAllMocks());

  it('未認証リクエストを 401 で拒否する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const file = new File([makeJpegBuffer()], 'test.jpg', { type: 'image/jpeg' });
    const res = await uploadPOST(makeUploadRequest(file));
    expect(res.status).toBe(401);
  });

  it('許可外 MIME タイプを 400 で拒否する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } }, error: null });
    const file = new File([makeJpegBuffer()], 'script.exe', { type: 'application/x-msdownload' });
    const res = await uploadPOST(makeUploadRequest(file));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('not allowed') });
  });

  it('magic bytes が合わないファイルを 400 で拒否する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } }, error: null });
    // MIME は image/jpeg と名乗るが中身は違う
    const file = new File([makeFakeBuffer()], 'fake.jpg', { type: 'image/jpeg' });
    const res = await uploadPOST(makeUploadRequest(file));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('does not match') });
  });

  it('10MB 超ファイルを 400 で拒否する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } }, error: null });
    // 11MB のバッファ (magic bytes は JPEG)
    const large = new Uint8Array(11 * 1024 * 1024);
    large[0] = 0xFF; large[1] = 0xD8; large[2] = 0xFF;
    const file = new File([large], 'big.jpg', { type: 'image/jpeg' });
    const res = await uploadPOST(makeUploadRequest(file));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('exceeds limit') });
  });

  it('正常な JPEG ファイルは 200 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } }, error: null });

    const uploadChain = { upload: vi.fn().mockResolvedValue({ error: null }) };
    const publicUrlChain = { getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage/file.jpg' } }) };
    mockStorageFrom.mockReturnValue({ ...uploadChain, ...publicUrlChain });

    const file = new File([makeJpegBuffer()], 'photo.jpg', { type: 'image/jpeg' });
    const res = await uploadPOST(makeUploadRequest(file));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ url: expect.stringContaining('https://') });
  });
});

// ─────────────────────────────────────────────
// #187 /api/org/users GET — select 列制限
// ─────────────────────────────────────────────
// org/users は cookies() を使う旧スタイルのため直接 import すると型エラーになりやすい。
// ここでは select 引数の変更が反映されているかをファイル内容で確認するスモークテストとする。
describe('#187 /api/org/users select 列制限', () => {
  it('select 引数に * が含まれないこと (ソースファイル確認)', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(
      new URL('../src/app/api/org/users/route.ts', import.meta.url),
      'utf-8'
    );
    // select('*') が残っていないことを確認
    expect(source).not.toMatch(/\.select\(['"`]\*['"`]\)/);
    // 必要カラムが明示されていることを確認
    expect(source).toMatch(/select\(['"`]id,/);
  });
});
