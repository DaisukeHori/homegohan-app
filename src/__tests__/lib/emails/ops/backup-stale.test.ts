import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import { renderBackupStaleEmail, type BackupStaleEmailVars } from '@/lib/emails/ops/backup-stale';
import { BACKUP_STALE_AFTER_HOURS, SUPER_ADMIN_BACKUPS_PATH } from '@/lib/backups/core';
import { DEFAULT_EMAIL_FROM, DEFAULT_SITE_URL } from '@/lib/site-config';

// #1129 DB バックアップの鮮度の運用メールの文面 (docs/design/cross/17-backup-automation.md §7.3)。
// 載せるのは最新の取得の日時 (日本時間)・しきい値・確かめる場所だけで、利用者の情報は載せない。

const SITE_URL = 'https://site.example.test';

const baseVars: BackupStaleEmailVars = {
  to_email: 'ops@example.test',
  // 2026-10-15 02:31 JST
  latest_completed_at: '2026-10-14T17:31:05.123456+00:00',
  stale_after_hours: BACKUP_STALE_AFTER_HOURS,
};

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  vi.stubEnv('EMAIL_FROM', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderBackupStaleEmail (#1129)', () => {
  it('B-1: template が ops_backup_stale・宛先・送信元が決まった形で、封筒のスキーマ (EmailEnvelopeSchema) を通る', () => {
    const envelope = renderBackupStaleEmail(baseVars);

    expect(envelope.template).toBe('ops_backup_stale');
    expect(envelope.to).toBe('ops@example.test');
    expect(envelope.from).toBe(DEFAULT_EMAIL_FROM);
    expect(() => EmailEnvelopeSchema.parse(envelope)).not.toThrow();
    // 秘密 (トークン入りのリンク) を含まない文面なので、送信待ちで伏せる宣言を付けない (#1708)
    expect(envelope).not.toHaveProperty('contains_secret');
  });

  it('B-2: 件名にしきい値の時間が入る', () => {
    expect(renderBackupStaleEmail(baseVars).subject).toBe('【ほめゴハン運用】DB バックアップが 30 時間以上取れていません');
    expect(renderBackupStaleEmail({ ...baseVars, stale_after_hours: 48 }).subject).toBe(
      '【ほめゴハン運用】DB バックアップが 48 時間以上取れていません',
    );
  });

  it('B-3: 最新の取得の日時は日本時間で書く (UTC 17:31 → 翌日 02:31)', () => {
    const { text } = renderBackupStaleEmail(baseVars);

    expect(text).toContain('最新の取得: 2026/10/15 02:31 (日本時間)');
    expect(text).not.toContain('2026-10-14T17:31');
  });

  it('B-4: 最新が null (取得の記録が 1 行も無い)・日時として読めない値なら「記録なし」', () => {
    expect(renderBackupStaleEmail({ ...baseVars, latest_completed_at: null }).text).toContain('最新の取得: 記録なし');
    expect(renderBackupStaleEmail({ ...baseVars, latest_completed_at: 'not-a-date' }).text).toContain('最新の取得: 記録なし');
  });

  it('B-5: 本文にしきい値・確かめる場所 (GitHub Actions の db-backup と運営の画面)・1 日 1 回の注記が載る', () => {
    const { text } = renderBackupStaleEmail(baseVars);

    expect(text).toContain('30 時間以上新しく取れていません');
    expect(text).toContain('最新の取得から 30 時間を超えると、この通知を送る設定です。');
    expect(text).toContain('db-backup');
    expect(text).toContain('このメールは自動で送られています。');
    expect(text).toContain('この確認は 1 日 1 回です。古いままなら翌日の確認でもう一度お知らせします');
  });

  it('B-6: 運営の画面の URL は getSiteUrl() + /super-admin/backups (未設定なら既定のサイト、設定すればその URL)', () => {
    expect(SUPER_ADMIN_BACKUPS_PATH).toBe('/super-admin/backups');
    expect(renderBackupStaleEmail(baseVars).text).toContain(`${DEFAULT_SITE_URL}/super-admin/backups`);

    vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE_URL);
    const { text } = renderBackupStaleEmail(baseVars);

    expect(text).toContain(`${SITE_URL}/super-admin/backups`);
    expect(text).not.toContain(DEFAULT_SITE_URL);
  });

  it('B-7: 本文と件名に宛先のアドレス・利用者の情報が入らない', () => {
    const envelope = renderBackupStaleEmail(baseVars);

    expect(envelope.text).not.toContain('ops@example.test');
    expect(envelope.subject).not.toContain('ops@example.test');
    expect(envelope.text).toContain('利用者の情報は含めていません');
  });

  it('B-8: ソースにドメイン・送信元を直接書かない (getSiteUrl / getEmailFrom だけを使う)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../../lib/emails/ops/backup-stale.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toMatch(/noreply@|support@/);
    expect(code).toContain('getSiteUrl()');
    expect(code).toContain('getEmailFrom()');
  });
});
