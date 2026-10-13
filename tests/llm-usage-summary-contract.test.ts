/**
 * #1498 運営の LLM 使用量を DB の中で集計する関数 public.llm_usage_summary — migration とアプリの定数の突き合わせ
 * (DB を使わない静的な検査)。
 *
 * 背景: GET /api/super-admin/llm/usage は llm_usage_logs の行を読んで集計していたが、行は route の MAX_ROWS (5,000) と
 * PostgREST の max_rows (既定 1,000) で打ち切られ、1 人・JST の 1 日に 5,000 回超の異常使用は判定できず、期間の合計も小さく出ていた。
 *
 * ここで確かめること:
 *   - 関数の最新の定義 (migration の番号順で最後のもの) が 20261011110000 の migration にあり、
 *     行の集合ではなく 1 つの JSONB を返す (行の集合を返すと、また max_rows で打ち切られる)
 *   - 集計の条件が以前の route と同じ (is_summary = false・created_at は開始の時刻以上・終わりの時刻未満・絞り込みは指定があるときだけ)
 *   - 日の区切りは JST ((created_at AT TIME ZONE 'Asia/Tokyo')::DATE)。異常は 1 日の回数がしきい値を「超えた」日があること
 *   - service_role だけが呼べる (SECURITY INVOKER・search_path 固定・完全形の REVOKE → service_role への GRANT)
 *   - アプリ (route) が呼ぶ関数の名前・引数の名前と、migration の関数が一致する
 *   - ロールバックが同じ引数の形で関数を消す
 * DB の上の実際の挙動は tests/integration/security/llm-usage-summary.test.ts で確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LLM_USAGE_SUMMARY_RPC,
  LLM_USAGE_TOP_USERS_LIMIT,
  llmUsageSummaryRpcArgs,
} from '@/lib/super-admin/llm-usage-summary';
import { LLM_USAGE_ANOMALY_DAILY_REQUESTS } from '@/lib/super-admin/llm-usage-anomaly';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const MIGRATION = '20261011110000_llm_usage_summary.sql';
const ROLLBACK = path.join(ROOT, 'supabase/rollbacks/20261011110000_llm_usage_summary.down.sql');
const FUNCTION_NAME = 'llm_usage_summary';
/** 引数の型の並び (REVOKE / GRANT / COMMENT / DROP で関数を指すときの形) */
const SIGNATURE = 'public.llm_usage_summary(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER, INTEGER)';

/** SQL のコメント (-- から行末) を取り除く。コメントの中の語で検査が通ってしまわないように */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** 空白をまとめて 1 つにする (改行・字下げの違いで検査が外れないように) */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ');
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

const migrationSql = squash(stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8')));

describe('#1498 llm_usage_summary: 集計の定義', () => {
  it('S-1: 最新の定義は 20261011110000 の migration にあり、1 つの JSONB を返す (行の集合を返さない = max_rows で打ち切られない)', () => {
    const latest = latestDefinition(FUNCTION_NAME);

    expect(latest?.file).toBe(MIGRATION);
    const body = squash(latest?.definition ?? '');
    expect(body).toContain(') RETURNS JSONB LANGUAGE plpgsql');
    expect(body).not.toMatch(/RETURNS (TABLE|SETOF)/);
  });

  it('S-2: 集計する行の条件は以前の route と同じ (呼び出しごとの行だけ・期間は開始以上・終わり未満・絞り込みは指定があるときだけ)', () => {
    const body = squash(latestDefinition(FUNCTION_NAME)?.definition ?? '');

    expect(body).toContain('FROM public.llm_usage_logs l WHERE l.is_summary = false');
    expect(body).toContain('AND l.created_at >= p_from AND l.created_at < p_to_exclusive');
    expect(body).toContain('AND (p_model IS NULL OR l.model = p_model)');
    expect(body).toContain('AND (p_function_name IS NULL OR l.function_name = p_function_name)');
    expect(body).toContain('AND (p_provider IS NULL OR l.provider = p_provider)');
    // トークン・コストの NULL は 0 として足す (以前の route と同じ。NaN / NULL の合計にしない)
    expect(body).toContain('COALESCE(l.total_tokens, 0)::BIGINT AS tokens');
    expect(body).toContain('COALESCE(l.estimated_cost_usd, 0)::NUMERIC AS cost_usd');
  });

  it("S-3: 日の区切りは JST ((created_at AT TIME ZONE 'Asia/Tokyo')::DATE)。異常は 1 日の回数がしきい値を超えた日があること", () => {
    const body = squash(latestDefinition(FUNCTION_NAME)?.definition ?? '');

    expect(body).toContain("(l.created_at AT TIME ZONE 'Asia/Tokyo')::DATE AS jst_day");
    expect(body).toContain('GROUP BY b.user_id, b.jst_day');
    // ちょうどしきい値の日は異常にしない (>)
    expect(body).toContain('HAVING pg_catalog.max(d.requests) > p_anomaly_daily_requests');
    // 応答の項目 (src/lib/super-admin/llm-usage-summary.ts の LlmUsageSummaryRpcSchema が読む名前)
    for (const key of ['total_requests', 'total_tokens', 'total_cost_usd', 'by_model', 'by_function', 'top_users', 'timeseries', 'anomalous_users']) {
      expect(body, key).toContain(`'${key}'`);
    }
  });
});

describe('#1498 llm_usage_summary: 権限', () => {
  it('P-1: SECURITY INVOKER・search_path 固定。PUBLIC / anon / authenticated / service_role から外し、service_role にだけ EXECUTE を付ける', () => {
    const body = squash(latestDefinition(FUNCTION_NAME)?.definition ?? '');

    expect(body).toContain('SECURITY INVOKER');
    expect(body).not.toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path = ''");
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role;`);
    // ほかのロールに GRANT しない
    expect(migrationSql.match(/GRANT EXECUTE ON FUNCTION public\.llm_usage_summary/g)).toHaveLength(1);
  });
});

describe('#1498 llm_usage_summary: アプリとの突き合わせ', () => {
  it('A-1: route が呼ぶ関数の名前と引数の名前は、migration の関数と同じ', () => {
    expect(LLM_USAGE_SUMMARY_RPC).toBe(FUNCTION_NAME);
    const body = squash(latestDefinition(FUNCTION_NAME)?.definition ?? '');
    const args = llmUsageSummaryRpcArgs({ fromTimestamp: '2026-10-01T15:00:00.000Z', toTimestampExclusive: '2026-10-08T15:00:00.000Z' });
    for (const name of Object.keys(args)) {
      expect(body, name).toMatch(new RegExp(`[(,] ${name} (TIMESTAMPTZ|TEXT|INTEGER)`));
    }
    // しきい値と人数は、アプリの定数をそのまま渡す (SQL の既定値と同じ値にしておく)
    expect(args.p_anomaly_daily_requests).toBe(LLM_USAGE_ANOMALY_DAILY_REQUESTS);
    expect(args.p_top_users_limit).toBe(LLM_USAGE_TOP_USERS_LIMIT);
    expect(body).toContain(`p_top_users_limit INTEGER DEFAULT ${LLM_USAGE_TOP_USERS_LIMIT}`);
    expect(body).toContain(`p_anomaly_daily_requests INTEGER DEFAULT ${LLM_USAGE_ANOMALY_DAILY_REQUESTS}`);
  });

  it('A-2: route は行を読まず、この関数で集計する (MAX_ROWS・.from(llm_usage_logs) が残っていない)', () => {
    const route = fs.readFileSync(path.join(ROOT, 'src/app/api/super-admin/llm/usage/route.ts'), 'utf8');
    const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(code).toContain('.rpc(');
    expect(code).toContain('LLM_USAGE_SUMMARY_RPC');
    expect(code).not.toContain('MAX_ROWS');
    expect(code).not.toMatch(/\.from\(\s*['"]llm_usage_logs['"]/);
  });
});

describe('#1498 llm_usage_summary: ロールバック', () => {
  it('R-1: 同じ引数の形で関数を消す (何度流しても同じ)', () => {
    const sql = squash(stripSqlComments(fs.readFileSync(ROLLBACK, 'utf8')));
    expect(sql).toContain(`DROP FUNCTION IF EXISTS ${SIGNATURE};`);
  });
});
