import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import { renderCronSecretDriftEmail, type CronSecretDriftEmailVars, type CronSecretEmailFinding } from '@/lib/emails/ops/cron-secret-drift';

// #1560 cron の共有シークレットのずれ (fail)・入れ替えの途中 (warn) の運用メールの文面。設計: docs/design/operator/12-cron-secret-drift-monitor.md §7.4。
// 載せるのは所見の題と対処 (定数の表の文)・運用ログ画面へのリンク・確認した時刻だけ。秘密の値もダイジェストも載せない。

const LOGS_URL = 'https://app.example.test/super-admin/logs';

const FAIL_FINDING: CronSecretEmailFinding = {
  id: 'edge-vault-mismatch',
  level: 'fail',
  title: '題 FAIL: Edge と Vault が食い違っています',
  action: '対処 FAIL: Vault を正として Edge を合わせてください',
};
const WARN_FINDING: CronSecretEmailFinding = {
  id: 'edge-previous-in-use',
  level: 'warn',
  title: '題 WARN: 入れ替えの途中です',
  action: '対処 WARN: Vault を新しい値に更新してください',
};

const baseVars: CronSecretDriftEmailVars = {
  to_email: 'ops@example.test',
  kind: 'drift',
  findings: [FAIL_FINDING],
  cooldown_minutes: 60,
  logs_url: LOGS_URL,
  // 2026-10-17 10:30 JST
  detected_at: new Date('2026-10-17T01:30:00Z'),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderCronSecretDriftEmail (#1560)', () => {
  it('E-1: template ops_cron_secret_drift・宛先・送信元 (EMAIL_FROM)・件名が種類ごとの決まった形 (drift / rotation)・100 字以内で、EmailEnvelopeSchema を通る', () => {
    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');
    const drift = renderCronSecretDriftEmail(baseVars);
    expect(EmailEnvelopeSchema.safeParse(drift).success).toBe(true);
    expect(drift.template).toBe('ops_cron_secret_drift');
    expect(drift.to).toBe('ops@example.test');
    expect(drift.from).toBe('ほめゴハン <noreply@mail.example.test>');
    expect(drift.subject).toBe('【ほめゴハン運用】cron の共有シークレットの確認が失敗しました (1 件)');

    const rotation = renderCronSecretDriftEmail({ ...baseVars, kind: 'rotation', findings: [WARN_FINDING, WARN_FINDING], cooldown_minutes: 1440 });
    expect(EmailEnvelopeSchema.safeParse(rotation).success).toBe(true);
    expect(rotation.template).toBe('ops_cron_secret_drift');
    expect(rotation.subject).toBe('【ほめゴハン運用】cron の共有シークレットの入れ替えが途中です (2 件)');

    // 件数が増えても 100 字以内 (所見は多くても十数件)
    for (const kind of ['drift', 'rotation'] as const) {
      const many = Array.from({ length: 21 }, () => FAIL_FINDING);
      expect(renderCronSecretDriftEmail({ ...baseVars, kind, findings: many }).subject.length).toBeLessThanOrEqual(100);
    }
  });

  it('E-2: 本文に所見の番号・[FAIL]/[WARN]・題・対処、手で流す検査の案内、運用ログ画面のリンク、確認した時刻 (日本時間)、抑止の分数が載る', () => {
    const drift = renderCronSecretDriftEmail({ ...baseVars, findings: [FAIL_FINDING, { ...FAIL_FINDING, title: '二つ目の題', action: '二つ目の対処' }] }).text;
    const lines = drift.split('\n');
    expect(lines).toContain(` 1. [FAIL] ${FAIL_FINDING.title}`);
    expect(lines).toContain(`    対処: ${FAIL_FINDING.action}`);
    expect(lines).toContain(' 2. [FAIL] 二つ目の題');
    expect(lines).toContain('    対処: 二つ目の対処');
    expect(drift).toContain('pg_cron からの Edge Function の呼び出し');
    expect(drift).toContain('node scripts/check-cron-secret-drift.mjs --project-ref <ref>');
    expect(drift).toContain('docs/design/operator/12-cron-secret-drift-monitor.md');
    expect(lines).toContain(LOGS_URL);
    expect(drift).toContain('確認した時刻: 2026/10/17 10:30 (日本時間)');
    expect(drift).toContain('直らないままなら 60 分ごとにもう一度お知らせします。');

    const rotation = renderCronSecretDriftEmail({ ...baseVars, kind: 'rotation', findings: [WARN_FINDING], cooldown_minutes: 1440 }).text;
    expect(rotation.split('\n')).toContain(` 1. [WARN] ${WARN_FINDING.title}`);
    expect(rotation).toContain('いまの呼び出しは通っていますが、片づけてください。');
    expect(rotation).not.toContain('pg_cron からの Edge Function の呼び出し');
    // 1,440 のように桁区切りになる
    expect(rotation).toContain('直らないままなら 1,440 分ごとにもう一度お知らせします。');
  });

  it('E-3: 所見の title / action 以外の入力 (id・logs_url) に秘密らしい文字列があっても件名には出ない。本文に「値・ダイジェスト・利用者の情報は含めていません」の注記がある', () => {
    const canary = 'canary-secret-value-0123456789';
    const envelope = renderCronSecretDriftEmail({
      ...baseVars,
      findings: [{ ...FAIL_FINDING, id: canary }],
      logs_url: `https://app.example.test/super-admin/logs?x=${canary}`,
    });
    expect(envelope.subject).not.toContain(canary);
    // 所見の id は文面に載せない (載せるのは題と対処だけ)
    expect(envelope.text.split('\n').filter((line) => line.includes(canary))).toEqual([`https://app.example.test/super-admin/logs?x=${canary}`]);
    expect(envelope.text).toContain('このメールに、シークレットの値・ダイジェスト・利用者の情報は含めていません。');
  });

  it('E-4: 署名を付けない。contains_secret を宣言しない (秘密なしの文面)', () => {
    const envelope = renderCronSecretDriftEmail(baseVars);
    expect(envelope.text).not.toContain('ほめゴハン運営');
    // 署名の区切り行 (-- だけの行) も無い
    expect(envelope.text.split('\n').filter((line) => /^--\s*$/.test(line))).toEqual([]);
    expect(Object.keys(envelope)).not.toContain('contains_secret');
    expect((envelope as { contains_secret?: unknown }).contains_secret).toBeUndefined();
  });
});
