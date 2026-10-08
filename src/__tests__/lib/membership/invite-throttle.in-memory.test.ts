import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #1163 invite-throttle を、モックではなく実際の rate-limit (in-memory フォールバック) と組み合わせて確かめる。
// 「Standard」の限度値が、招待者・組織・宛先の重なりを含めて意図どおりに効くことを数で固定する。
//   family-invite 5/分 + 20/日 / org-invite 10/分 + 200/日 / org-invite-scope 500/日 /
//   child-promotion 5/分 + 10/日 / invite-target 3/日 / transfer-propose 3/分 + 10/日

const ORIGINAL_ENV = { ...process.env };

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Throttle = typeof import('@/lib/membership/invite-throttle');
let throttle: Throttle;

const BURST_MESSAGE = '短時間に操作が集中しています。1分ほど待ってからお試しください。';
const DAILY_MESSAGE = '本日の送信上限に達しました。しばらく時間をおいてからお試しください。';

beforeEach(async () => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  vi.useFakeTimers();
  throttle = await import('@/lib/membership/invite-throttle');
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

const familyAttempt = (userId: string, familyId: string, recipient: string) =>
  throttle.checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId: familyId, recipientEmail: recipient });

const orgAttempt = (userId: string, orgId: string, recipient: string) =>
  throttle.checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId: orgId, recipientEmail: recipient });

const promotionAttempt = (userId: string, recipient: string) =>
  throttle.checkInviteEmailLimits({ flow: 'child-promotion', userId, scopeId: userId, recipientEmail: recipient });

describe('家族の招待 (family-invite: 5/分 + 20/日、宛先は 3/日)', () => {
  it('1 分に 5 通まで通り、6 通目は「1分ほど待って」で止まり、1 分後にまた送れる', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await familyAttempt('user-f1', 'family-1', `invitee${i}@example.com`)).toBeNull();
    }
    const blocked = await familyAttempt('user-f1', 'family-1', 'invitee5@example.com');
    expect(blocked).toMatchObject({ windowSec: 60, message: BURST_MESSAGE });
    expect(blocked!.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked!.retryAfterSec).toBeLessThanOrEqual(60);

    vi.advanceTimersByTime(MINUTE_MS + 1_000);
    expect(await familyAttempt('user-f1', 'family-1', 'invitee5@example.com')).toBeNull();
  });

  it('1 日 20 通まで通り、21 通目は「本日の上限」で止まる。24 時間後にまた送れる', async () => {
    for (let i = 0; i < 20; i++) {
      expect(await familyAttempt('user-f2', 'family-2', `invitee${i}@example.com`)).toBeNull();
      // 分あたりの枠だけをリセットして、日次の判定を分離する
      vi.advanceTimersByTime(MINUTE_MS + 1_000);
    }
    const blocked = await familyAttempt('user-f2', 'family-2', 'invitee20@example.com');
    expect(blocked).toMatchObject({ windowSec: 86400, message: DAILY_MESSAGE });

    vi.advanceTimersByTime(DAY_MS);
    expect(await familyAttempt('user-f2', 'family-2', 'invitee20@example.com')).toBeNull();
  });

  it('同じ家族から同じ宛先へは 1 日 3 回まで。4 回目は招待者の枠が残っていても止まる', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await familyAttempt('user-f3', 'family-3', 'same@example.com')).toBeNull();
    }
    const blocked = await familyAttempt('user-f3', 'family-3', 'same@example.com');
    expect(blocked).toMatchObject({ windowSec: 86400, message: DAILY_MESSAGE });

    // 別の宛先は引き続き送れる
    expect(await familyAttempt('user-f3', 'family-3', 'other@example.com')).toBeNull();
  });

  it('宛先の判定は大文字小文字・前後の空白を区別しない', async () => {
    expect(await familyAttempt('user-f4', 'family-4', 'Same@Example.com')).toBeNull();
    expect(await familyAttempt('user-f4', 'family-4', ' same@example.com ')).toBeNull();
    expect(await familyAttempt('user-f4', 'family-4', 'SAME@EXAMPLE.COM')).toBeNull();
    expect(await familyAttempt('user-f4', 'family-4', 'same@example.com')).not.toBeNull();
  });

  it('宛先の上限は家族ごとに独立している (別の家族から同じ宛先へは送れる)', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await familyAttempt('user-f5a', 'family-5a', 'same@example.com')).toBeNull();
    }
    expect(await familyAttempt('user-f5a', 'family-5a', 'same@example.com')).not.toBeNull();

    expect(await familyAttempt('user-f5b', 'family-5b', 'same@example.com')).toBeNull();
  });

  it('招待者ごとに独立している (別のユーザーは影響を受けない)', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await familyAttempt('user-f6a', 'family-6', `invitee${i}@example.com`)).toBeNull();
    }
    expect(await familyAttempt('user-f6a', 'family-6', 'invitee5@example.com')).not.toBeNull();

    expect(await familyAttempt('user-f6b', 'family-6', 'invitee5@example.com')).toBeNull();
  });

  it('試行回数を数える: 宛先の上限で止まった試行も招待者の分あたりの枠を 1 つ使う', async () => {
    // 1〜3 回目は通る / 4 回目は宛先の上限で止まる (招待者の枠は 4 つ使用済み)
    for (let i = 0; i < 3; i++) {
      expect(await familyAttempt('user-f7', 'family-7', 'same@example.com')).toBeNull();
    }
    expect(await familyAttempt('user-f7', 'family-7', 'same@example.com')).toMatchObject({ windowSec: 86400 });
    // 別の宛先の 5 通目は通る (招待者の枠 5 / 5)
    expect(await familyAttempt('user-f7', 'family-7', 'other1@example.com')).toBeNull();
    // 6 通目は分あたりの枠で止まる
    expect(await familyAttempt('user-f7', 'family-7', 'other2@example.com')).toMatchObject({ windowSec: 60 });
  });
});

describe('組織の招待 (org-invite: 10/分 + 200/日、組織全体 500/日、宛先は 3/日)', () => {
  it('1 分に 10 通まで通り、11 通目は「1分ほど待って」で止まる', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await orgAttempt('admin-o1', 'org-1', `invitee${i}@example.com`)).toBeNull();
    }
    expect(await orgAttempt('admin-o1', 'org-1', 'invitee10@example.com')).toMatchObject({
      windowSec: 60,
      message: BURST_MESSAGE,
    });
  });

  it('管理者 1 人あたり 1 日 200 通まで。201 通目は「本日の上限」で止まる', async () => {
    for (let i = 0; i < 200; i++) {
      expect(await orgAttempt('admin-o2', 'org-2', `invitee${i}@example.com`)).toBeNull();
      if (i % 10 === 9) vi.advanceTimersByTime(MINUTE_MS + 1_000);
    }
    expect(await orgAttempt('admin-o2', 'org-2', 'invitee200@example.com')).toMatchObject({
      windowSec: 86400,
      message: DAILY_MESSAGE,
    });
  });

  it('組織全体では 1 日 500 通まで。管理者が複数いても、501 通目は別の管理者でも止まる', async () => {
    // 50 人の管理者が 10 通ずつ (1 人あたりの分あたり・日次の上限の範囲内) = 500 通
    for (let admin = 0; admin < 50; admin++) {
      for (let i = 0; i < 10; i++) {
        expect(await orgAttempt(`admin-o3-${admin}`, 'org-3', `invitee${admin}-${i}@example.com`)).toBeNull();
      }
    }
    const blocked = await orgAttempt('admin-o3-50', 'org-3', 'invitee-last@example.com');
    expect(blocked).toMatchObject({ windowSec: 86400, message: DAILY_MESSAGE });

    // 別の組織は影響を受けない
    expect(await orgAttempt('admin-o3-other', 'org-3-other', 'invitee-last@example.com')).toBeNull();
  });

  it('同じ組織から同じ宛先へは 1 日 3 回まで', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await orgAttempt('admin-o4', 'org-4', 'same@example.com')).toBeNull();
    }
    expect(await orgAttempt('admin-o4', 'org-4', 'same@example.com')).toMatchObject({ windowSec: 86400 });
    // 別の管理者でも同じ組織なら止まる
    expect(await orgAttempt('admin-o4-b', 'org-4', 'same@example.com')).toMatchObject({ windowSec: 86400 });
  });
});

describe('子供メンバーの昇格 (child-promotion: 5/分 + 10/日、宛先は 3/日)', () => {
  it('1 分に 5 通まで通り、6 通目は止まる', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await promotionAttempt('user-p1', `child${i}@example.com`)).toBeNull();
    }
    expect(await promotionAttempt('user-p1', 'child5@example.com')).toMatchObject({ windowSec: 60 });
  });

  it('1 日 10 通まで通り、11 通目は「本日の上限」で止まる', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await promotionAttempt('user-p2', `child${i}@example.com`)).toBeNull();
      vi.advanceTimersByTime(MINUTE_MS + 1_000);
    }
    expect(await promotionAttempt('user-p2', 'child10@example.com')).toMatchObject({
      windowSec: 86400,
      message: DAILY_MESSAGE,
    });
  });

  it('宛先は依頼者ごとに 1 日 3 回まで (別の依頼者の同じ宛先は数えない)', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await promotionAttempt('user-p3a', 'child@example.com')).toBeNull();
    }
    expect(await promotionAttempt('user-p3a', 'child@example.com')).toMatchObject({ windowSec: 86400 });
    expect(await promotionAttempt('user-p3b', 'child@example.com')).toBeNull();
  });
});

describe('譲渡提案 (transfer-propose: 3/分 + 10/日)', () => {
  it('1 分に 3 回まで通り、4 回目は止まる', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await throttle.checkTransferProposeLimit('owner-t1')).toBeNull();
    }
    expect(await throttle.checkTransferProposeLimit('owner-t1')).toMatchObject({
      windowSec: 60,
      message: BURST_MESSAGE,
    });
    // 別のユーザーは影響を受けない
    expect(await throttle.checkTransferProposeLimit('owner-t2')).toBeNull();
  });

  it('1 日 10 回まで通り、11 回目は「本日の上限」で止まる', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await throttle.checkTransferProposeLimit('owner-t3')).toBeNull();
      vi.advanceTimersByTime(MINUTE_MS + 1_000);
    }
    expect(await throttle.checkTransferProposeLimit('owner-t3')).toMatchObject({
      windowSec: 86400,
      message: DAILY_MESSAGE,
    });
  });
});

describe('異なる flow の枠は混ざらない', () => {
  it('同じユーザー ID でも family-invite・org-invite・child-promotion・transfer-propose は別々に数える', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await familyAttempt('user-x', 'scope-x', `invitee${i}@example.com`)).toBeNull();
    }
    expect(await familyAttempt('user-x', 'scope-x', 'invitee5@example.com')).not.toBeNull();

    expect(await orgAttempt('user-x', 'scope-x', 'invitee5@example.com')).toBeNull();
    expect(await promotionAttempt('user-x', 'invitee5@example.com')).toBeNull();
    expect(await throttle.checkTransferProposeLimit('user-x')).toBeNull();
  });
});
