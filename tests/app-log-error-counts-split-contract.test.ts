/**
 * #1493 エラー急増の運用メール (#1157): サーバーの error とブラウザ・端末から届いた error を別々に数える — migration と
 * アプリの定数の突き合わせ (DB を使わない静的な検査)。
 *
 * 背景: POST /api/log はログインしていれば誰でも source='client' の error を書ける。サーバーの通知と同じ数え方・同じキーだと、
 * 利用者が error を書くだけでサーバーの障害の通知を鳴らせ、そのクールダウンで本物の障害の通知を止められた。
 *
 * ここで確かめること:
 *   - app_log_error_counts の最新の定義 (migration の番号順で最後のもの) が source <> 'client' で絞っている
 *   - app_log_client_error_counts の最新の定義が source = 'client' だけを数える
 *   - どちらも service_role だけが呼べる (完全形の REVOKE → service_role への GRANT)
 *   - アプリ (cron) が呼ぶ関数の名前と、migration が作る関数の名前が一致し、通知のキーは種類ごとに別、しきい値はクライアントの方が高い
 *   - ロールバックが、新しい関数を消し、app_log_error_counts を元の (source で絞らない) 中身に戻す
 * DB の上の実際の挙動は tests/integration/rls/ops-alert-state.test.ts (E. の節) で確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_LOG_ALERT_COUNT_RPC,
  APP_LOG_ALERT_ERROR_THRESHOLD,
  APP_LOG_ALERT_KEY,
  APP_LOG_ALERT_KEYS,
  APP_LOG_CLIENT_ALERT_ERROR_THRESHOLD,
  APP_LOG_CLIENT_ALERT_KEY,
  CRON_FAILURE_ALERT_KEY,
  EMAIL_DEAD_LETTER_ALERT_KEY,
  PG_CRON_STALLED_ALERT_KEY,
} from '@/lib/ops-alerts/app-log-error-spike';
import { CRON_SECRET_DRIFT_ALERT_KEY, CRON_SECRET_ROTATION_ALERT_KEY } from '@/lib/ops-alerts/cron-secret-drift';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const MIGRATION = '20261011080000_app_log_error_counts_split_client.sql';
const ROLLBACK = path.join(ROOT, 'supabase/rollbacks/20261011080000_app_log_error_counts_split_client.down.sql');

/** SQL のコメント (-- から行末) を取り除く。コメントの中の語で検査が通ってしまわないように */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** sql の中の「CREATE OR REPLACE FUNCTION public.<name>(」から、その関数の本体の終わり (END $$;) までを返す */
function functionDefinition(sql: string, name: string): string | null {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) return null;
  const end = sql.indexOf('END $$;', start);
  if (end < 0) return null;
  return sql.slice(start, end + 'END $$;'.length);
}

/** migration を番号順に見て、関数を最後に定義したファイルとその定義 (コメントを除いた SQL) を返す */
function latestDefinition(name: string): { file: string; definition: string } | null {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  let latest: { file: string; definition: string } | null = null;
  for (const file of files) {
    const definition = functionDefinition(stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')), name);
    if (definition) latest = { file, definition };
  }
  return latest;
}

/** 空白をまとめて 1 つにする (改行・字下げの違いで検査が外れないように) */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

describe('#1493 app_log_error_counts はサーバーの error だけを数える', () => {
  it('C-1: 最新の定義は 20261011080000 の migration で、source <> client で絞る', () => {
    const latest = latestDefinition('app_log_error_counts');

    expect(latest?.file).toBe(MIGRATION);
    const body = squash(latest?.definition ?? '');
    expect(body).toContain("WHERE l.level = 'error' AND l.source <> 'client' AND l.created_at >=");
    // 引数と戻り値の形は #1157 のまま (cron の読み取りと権限の GRANT がそのまま効く)
    expect(body).toContain('p_window_minutes INTEGER DEFAULT 15, p_limit INTEGER DEFAULT 10');
    expect(body).toContain('RETURNS TABLE ( function_name TEXT, error_count BIGINT, total_count BIGINT )');
    expect(body).toContain('SECURITY INVOKER');
    expect(body).toContain("SET search_path = ''");
  });

  it('C-2: app_log_client_error_counts は source = client の error だけを数え、形は app_log_error_counts と同じ', () => {
    const latest = latestDefinition('app_log_client_error_counts');

    expect(latest?.file).toBe(MIGRATION);
    const body = squash(latest?.definition ?? '');
    expect(body).toContain("WHERE l.level = 'error' AND l.source = 'client' AND l.created_at >=");
    expect(body).not.toContain("<> 'client'");
    expect(body).toContain('p_window_minutes INTEGER DEFAULT 15, p_limit INTEGER DEFAULT 10');
    expect(body).toContain('RETURNS TABLE ( function_name TEXT, error_count BIGINT, total_count BIGINT )');
    expect(body).toContain('SECURITY INVOKER');
    expect(body).toContain("SET search_path = ''");
    // 引数の範囲の検査も同じ (窓 1〜1440 分・行数 1〜100)
    expect(body).toContain('p_window_minutes < 1 OR p_window_minutes > 1440');
    expect(body).toContain('p_limit < 1 OR p_limit > 100');
  });

  it('C-3: 2 本とも service_role だけが呼べる (完全形で REVOKE してから service_role にだけ GRANT)', () => {
    const sql = squash(stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8')));

    for (const name of ['app_log_error_counts', 'app_log_client_error_counts']) {
      const revoke = `REVOKE ALL ON FUNCTION public.${name}(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;`;
      const grant = `GRANT EXECUTE ON FUNCTION public.${name}(INTEGER, INTEGER) TO service_role;`;
      expect(sql, name).toContain(revoke);
      expect(sql, name).toContain(grant);
      expect(sql.indexOf(revoke), name).toBeLessThan(sql.indexOf(grant));
      // anon / authenticated への GRANT は無い
      expect(sql, name).not.toMatch(new RegExp(`GRANT [A-Z, ]+ ON FUNCTION public\\.${name}\\([^)]*\\) TO (anon|authenticated|PUBLIC)`));
    }
    // 表・索引・行には触れない (関数の差し替えと追加だけ)
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP) (TABLE|INDEX)\b/);
    expect(sql).not.toMatch(/\b(INSERT INTO|UPDATE public\.|DELETE FROM)\b/);
  });
});

describe('#1493 アプリの定数と migration の突き合わせ', () => {
  it('A-1: cron が呼ぶ関数の名前は、migration が作る関数と一致する', () => {
    expect(APP_LOG_ALERT_COUNT_RPC).toEqual({
      server: 'app_log_error_counts',
      client: 'app_log_client_error_counts',
      // #1193 届けられなかったメール (email_outbox の dead) を数える関数
      email_dead_letter: 'email_outbox_dead_counts',
      // #1125 (B) 定期処理の失敗を数える関数と、pg_cron の最新の実行を読む関数 (段 A の migration が作る)
      cron_failure: 'cron_failure_counts',
      pg_cron_stalled: 'pg_cron_last_run_at',
      // #1560 cron の共有シークレットの確認の結果を読む関数 (段 B の migration が作る)。ずれ (fail) と入れ替えの途中 (warn) は同じ 1 本から判定する
      cron_secret_drift: 'cron_secret_probe_results',
      cron_secret_rotation: 'cron_secret_probe_results',
    });
    for (const name of Object.values(APP_LOG_ALERT_COUNT_RPC)) {
      expect(latestDefinition(name), name).not.toBeNull();
    }
  });

  it('A-2: 通知のキーは種類ごとに別 (クールダウンを共有しない)。サーバーのキーは #1157 のまま', () => {
    expect(APP_LOG_ALERT_KEYS).toEqual({
      server: APP_LOG_ALERT_KEY,
      client: APP_LOG_CLIENT_ALERT_KEY,
      email_dead_letter: EMAIL_DEAD_LETTER_ALERT_KEY,
      cron_failure: CRON_FAILURE_ALERT_KEY,
      pg_cron_stalled: PG_CRON_STALLED_ALERT_KEY,
      cron_secret_drift: CRON_SECRET_DRIFT_ALERT_KEY,
      cron_secret_rotation: CRON_SECRET_ROTATION_ALERT_KEY,
    });
    expect(EMAIL_DEAD_LETTER_ALERT_KEY).toBe('email_dead_letter');
    expect(CRON_FAILURE_ALERT_KEY).toBe('cron_failure');
    expect(PG_CRON_STALLED_ALERT_KEY).toBe('pg_cron_stalled');
    expect(CRON_SECRET_DRIFT_ALERT_KEY).toBe('cron_secret_drift');
    expect(CRON_SECRET_ROTATION_ALERT_KEY).toBe('cron_secret_rotation');
    expect(new Set(Object.values(APP_LOG_ALERT_KEYS)).size).toBe(7);
    expect(APP_LOG_ALERT_KEY).toBe('app_logs_error_spike');
    expect(APP_LOG_CLIENT_ALERT_KEY).toBe('app_logs_client_error_spike');
    expect(APP_LOG_CLIENT_ALERT_KEY).not.toBe(APP_LOG_ALERT_KEY);
  });

  it('A-3: クライアントのしきい値 (既定) はサーバーより高い', () => {
    expect(APP_LOG_CLIENT_ALERT_ERROR_THRESHOLD).toBeGreaterThan(APP_LOG_ALERT_ERROR_THRESHOLD);
  });
});

describe('#1493 ロールバック', () => {
  it('R-1: 新しい関数を消し、app_log_error_counts を source で絞らない元の中身に戻す', () => {
    const sql = stripSqlComments(fs.readFileSync(ROLLBACK, 'utf8'));
    const restored = squash(functionDefinition(sql, 'app_log_error_counts') ?? '');

    expect(squash(sql)).toContain('DROP FUNCTION IF EXISTS public.app_log_client_error_counts(INTEGER, INTEGER);');
    expect(restored).toContain("WHERE l.level = 'error' AND l.created_at >=");
    expect(restored).not.toContain('l.source');

    // 元の中身 (20261010123500) と、WHERE 句が同じ
    const original = squash(
      functionDefinition(
        stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, '20261010123500_ops_alert_state.sql'), 'utf8')),
        'app_log_error_counts',
      ) ?? '',
    );
    const whereOf = (body: string) => body.slice(body.indexOf('WHERE l.level'), body.indexOf('GROUP BY'));
    expect(whereOf(restored)).toBe(whereOf(original));
    expect(squash(sql)).toContain(
      'REVOKE ALL ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;',
    );
  });
});
