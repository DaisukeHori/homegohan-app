/**
 * ヘルスチェック (死活監視) エンドポイント (#1181)
 *
 * 外部の uptime 監視 (Better Stack / UptimeRobot など) と、DR runbook・デプロイ後の
 * smoke test (scripts/smoke.mjs) が叩く窓口。
 *
 * - GET /api/health         : アプリが応答できるかだけを見る。DB には触れず、常に 200。
 * - GET /api/health?deep=1  : 加えて DB (Supabase) に 1 行読みに行く。失敗・2 秒超過は 503。
 * - HEAD も同じステータスを返す (UptimeRobot の既定は HEAD)。
 *
 * 認証は不要。個人情報・秘密情報・エラーの詳細・環境変数名は返さない
 * (失敗の原因は構造化ログ (app_logs / Vercel ログ) にだけ残す)。
 * CDN に古い「正常」を返させないよう、全レスポンスに Cache-Control: no-store を付ける。
 *
 * 注: /api/health/* 配下 (blood-tests / goals / records など) は健康記録機能の API で、
 * このファイルとは別物。そちらは従来どおり各 route で認証する。
 * このパスだけは src/middleware.ts の matcher で認証ミドルウェアから外してある
 * (Supabase のセッション処理を通さず、認証基盤の不調に引きずられないようにするため)。
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createLogger, generateRequestId } from '@/lib/db-logger';

// 静的化されて古い応答が返ることを防ぐ (GET の route handler は既定で静的化され得る)
export const dynamic = 'force-dynamic';

/** DB 疎通確認の打ち切り時間。監視側のタイムアウト (多くは 10 秒以上) より十分短くする */
const DB_PING_TIMEOUT_MS = 2000;

type DbFailureReason = 'config_missing' | 'timeout' | 'query_error' | 'exception';

interface HealthBody {
  status: 'ok' | 'degraded';
  version: string;
  time: string;
  /** deep=1 のときだけ付く。DB 疎通の可否だけを返し、原因は含めない */
  checks?: { database: 'ok' | 'fail' };
}

function isDeepRequested(request: Request): boolean {
  const deep = new URL(request.url).searchParams.get('deep');
  return deep === '1' || deep === 'true';
}

/** supabase-js は取得失敗を Error ではなく { message, code, ... } の素のオブジェクトで返すことがある */
function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value;
  const message = (value as { message?: unknown } | null | undefined)?.message;
  return new Error(typeof message === 'string' && message ? message : fallbackMessage);
}

/**
 * 失敗ログを書く間隔。この route は未認証で叩けるため、DB 障害中に ?deep=1 を連打されても
 * app_logs への書き込みが増え続けないよう、インスタンスごとに間引く (応答の 503 は毎回返す)。
 */
const FAILURE_LOG_INTERVAL_MS = 60_000;
let lastFailureLoggedAt = 0;

function logDbFailure(reason: DbFailureReason, cause?: unknown): void {
  const now = Date.now();
  if (now - lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return;
  lastFailureLoggedAt = now;

  const code = (cause as { code?: unknown } | null | undefined)?.code;
  createLogger('GET /api/health', generateRequestId()).error(
    'ヘルスチェック(deep): DB 疎通に失敗しました',
    toError(cause, reason),
    { reason, timeout_ms: DB_PING_TIMEOUT_MS, ...(typeof code === 'string' && code ? { code } : {}) },
  );
}

/**
 * 公開テーブル subscription_plans を anon キーで 1 行読めるかで DB 疎通を判定する。
 * (RLS: status が public / private の行は anon でも SELECT できる公開マスタ。
 *  このテーブルの anon SELECT を閉じる場合は、ここの確認先も変えること。
 *  tests/integration/security/health-endpoint.test.ts が回帰を検知する)
 *
 * service_role は使わない。行が 0 件でもエラーでなければ「届いている」とみなす。
 * 失敗の原因は応答に出さず、ログにだけ残す。
 */
async function pingDatabase(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    logDbFailure('config_missing');
    return false;
  }

  // 2 秒で打ち切る。abort すると supabase-js は例外ではなく error 付きで resolve する
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_PING_TIMEOUT_MS);
  try {
    const supabase = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { error } = await supabase
      .from('subscription_plans')
      .select('id')
      .limit(1)
      // 既定では 503 / ネットワークエラーを自動で再試行する。死活監視では実態をそのまま見たいので 1 回で判定する
      .retry(false)
      .abortSignal(controller.signal);

    if (error) {
      logDbFailure(controller.signal.aborted ? 'timeout' : 'query_error', error);
      return false;
    }
    return true;
  } catch (error) {
    logDbFailure(controller.signal.aborted ? 'timeout' : 'exception', error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function handle(request: Request, includeBody: boolean): Promise<NextResponse> {
  const deep = isDeepRequested(request);
  const databaseOk = deep ? await pingDatabase() : true;

  const body: HealthBody = {
    status: databaseOk ? 'ok' : 'degraded',
    // .env.example は NEXT_PUBLIC_APP_VERSION= (空) なので、空文字も未設定として扱う
    version: process.env.NEXT_PUBLIC_APP_VERSION || 'unknown',
    time: new Date().toISOString(),
    ...(deep ? { checks: { database: databaseOk ? ('ok' as const) : ('fail' as const) } } : {}),
  };
  const init = {
    status: databaseOk ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  };

  return includeBody ? NextResponse.json(body, init) : new NextResponse(null, init);
}

export async function GET(request: Request) {
  return handle(request, true);
}

export async function HEAD(request: Request) {
  return handle(request, false);
}
