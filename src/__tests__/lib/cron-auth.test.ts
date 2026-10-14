import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { requireCronAuth } from '@/lib/cron-auth';

// #1196: /api/cron/* の認証 (Authorization: Bearer <CRON_SECRET>) を 1 か所に集め、
// シークレットを入れ替えている間は CRON_SECRET_PREVIOUS (旧い値) も受け付ける。
// 値はすべてテスト用のダミー。本物のシークレットは使わない。

const NEW_SECRET = 'dummy-new-cron-secret-0123456789abcdef';
const OLD_SECRET = 'dummy-old-cron-secret-fedcba9876543210';

function makeRequest(authorization?: string) {
  return new Request('http://localhost/api/cron/process-menu-queue', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

async function expectJson(res: Response | null, status: number, body: unknown) {
  expect(res).not.toBeNull();
  expect(res!.status).toBe(status);
  await expect(res!.json()).resolves.toEqual(body);
}

let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;

beforeEach(() => {
  // 開発者の環境に残っている値に左右されないよう、毎回すべて空の状態から始める
  vi.stubEnv('CRON_SECRET', undefined);
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('SERVICE_ROLE_SECRET', undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  vi.unstubAllEnvs();
});

describe('requireCronAuth (#1196)', () => {
  it('CA-1: 現行の CRON_SECRET なら null (認証成功)。警告は出さない', async () => {
    vi.stubEnv('CRON_SECRET', NEW_SECRET);
    await expect(requireCronAuth(makeRequest(`Bearer ${NEW_SECRET}`))).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('CA-2: 入れ替え中は CRON_SECRET_PREVIOUS (旧い値) でも通り、旧い値で認証されたことを警告に残す', async () => {
    vi.stubEnv('CRON_SECRET', NEW_SECRET);
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);

    await expect(requireCronAuth(makeRequest(`Bearer ${NEW_SECRET}`))).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();

    await expect(requireCronAuth(makeRequest(`Bearer ${OLD_SECRET}`))).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('CRON_SECRET_PREVIOUS');
    expect(message).not.toContain(OLD_SECRET);
    expect(message).not.toContain(NEW_SECRET);
  });

  it('CA-3: どちらでもない値 (同じ長さ・異なる長さ) は 401 unauthorized', async () => {
    vi.stubEnv('CRON_SECRET', NEW_SECRET);
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);
    await expectJson(await requireCronAuth(makeRequest(`Bearer ${'x'.repeat(NEW_SECRET.length)}`)), 401, {
      error: 'unauthorized',
    });
    await expectJson(await requireCronAuth(makeRequest('Bearer short')), 401, { error: 'unauthorized' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('CA-4: Authorization ヘッダーがなければ 401 unauthorized', async () => {
    vi.stubEnv('CRON_SECRET', NEW_SECRET);
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);
    await expectJson(await requireCronAuth(makeRequest()), 401, { error: 'unauthorized' });
  });

  it('CA-5: CRON_SECRET が未設定なら、今までどおり 503 cron_disabled (サーバーログにも残す)', async () => {
    await expectJson(await requireCronAuth(makeRequest(`Bearer ${NEW_SECRET}`)), 503, { error: 'cron_disabled' });
    expect(error).toHaveBeenCalledWith('[cron] CRON_SECRET not set');
  });

  it('CA-6: CRON_SECRET が空文字でも 503 cron_disabled', async () => {
    vi.stubEnv('CRON_SECRET', '');
    await expectJson(await requireCronAuth(makeRequest('Bearer ')), 503, { error: 'cron_disabled' });
  });

  it('CA-7: CRON_SECRET_PREVIOUS だけが設定されていても 503 (旧い値だけで通る状態にしない)', async () => {
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);
    await expectJson(await requireCronAuth(makeRequest(`Bearer ${OLD_SECRET}`)), 503, { error: 'cron_disabled' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('CA-8: 空文字の CRON_SECRET_PREVIOUS は無視する。ヘッダーなし・空のトークンは 401', async () => {
    vi.stubEnv('CRON_SECRET', NEW_SECRET);
    vi.stubEnv('CRON_SECRET_PREVIOUS', '');
    await expectJson(await requireCronAuth(makeRequest()), 401, { error: 'unauthorized' });
    await expectJson(await requireCronAuth(makeRequest('Bearer ')), 401, { error: 'unauthorized' });
    await expectJson(await requireCronAuth(makeRequest('')), 401, { error: 'unauthorized' });
    await expect(requireCronAuth(makeRequest(`Bearer ${NEW_SECRET}`))).resolves.toBeNull();
  });

  it('CA-9: Bearer の書き方は今までと同じ (小文字の bearer・スキームなし・空白 2 つは 401)', async () => {
    vi.stubEnv('CRON_SECRET', NEW_SECRET);
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);
    for (const secret of [NEW_SECRET, OLD_SECRET]) {
      for (const header of [`bearer ${secret}`, secret, `Bearer  ${secret}`, `Basic ${secret}`]) {
        await expectJson(await requireCronAuth(makeRequest(header)), 401, { error: 'unauthorized' });
      }
    }
  });

  it('CA-10: Next.js 側は SERVICE_ROLE_SECRET を使わない (Edge Functions 側だけの別名)', async () => {
    vi.stubEnv('SERVICE_ROLE_SECRET', NEW_SECRET);
    await expectJson(await requireCronAuth(makeRequest(`Bearer ${NEW_SECRET}`)), 503, { error: 'cron_disabled' });
  });
});
