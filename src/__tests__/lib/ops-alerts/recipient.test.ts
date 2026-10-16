import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOpsAlertRecipient } from '@/lib/ops-alerts/recipient';

// #1157 / #1129 運用メールの宛先 (OPS_ALERT_EMAIL) の読み口。app-log-alerts と backup-freshness の 2 つの cron が共有する
// (docs/design/cross/17-backup-automation.md §5.4)。値はすべてテスト用のダミー。

const OPS_EMAIL = 'ops-owner@example.test';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveOpsAlertRecipient (#1129)', () => {
  it('R-1: 未設定なら disabled', () => {
    vi.stubEnv('OPS_ALERT_EMAIL', undefined);

    expect(resolveOpsAlertRecipient()).toEqual({ status: 'disabled' });
  });

  it('R-2: 空文字・空白だけも未設定と同じ disabled', () => {
    for (const blank of ['', '   ', '\n\t']) {
      vi.stubEnv('OPS_ALERT_EMAIL', blank);

      expect(resolveOpsAlertRecipient(), JSON.stringify(blank)).toEqual({ status: 'disabled' });
    }
  });

  it('R-3: 名前つき・カンマ区切り・アドレスでない値は invalid_config で、値を返さない', () => {
    for (const invalid of ['ほめゴハン <ops@example.test>', 'a@example.test, b@example.test', 'not-an-email', 'ops@']) {
      vi.stubEnv('OPS_ALERT_EMAIL', invalid);

      const resolved = resolveOpsAlertRecipient();

      expect(resolved, invalid).toEqual({ status: 'invalid_config' });
      expect(JSON.stringify(resolved), invalid).not.toContain('example.test');
    }
  });

  it('R-4: アドレス 1 つなら ok で、その値を返す', () => {
    vi.stubEnv('OPS_ALERT_EMAIL', OPS_EMAIL);

    expect(resolveOpsAlertRecipient()).toEqual({ status: 'ok', email: OPS_EMAIL });
  });

  it('R-5: 前後の空白は取り除いて返す', () => {
    vi.stubEnv('OPS_ALERT_EMAIL', `  ${OPS_EMAIL}\n`);

    expect(resolveOpsAlertRecipient()).toEqual({ status: 'ok', email: OPS_EMAIL });
  });

  it('R-6: 呼ぶたびに今の環境変数を読む (値を覚えない)', () => {
    vi.stubEnv('OPS_ALERT_EMAIL', OPS_EMAIL);
    expect(resolveOpsAlertRecipient()).toEqual({ status: 'ok', email: OPS_EMAIL });

    vi.stubEnv('OPS_ALERT_EMAIL', undefined);
    expect(resolveOpsAlertRecipient()).toEqual({ status: 'disabled' });
  });
});
