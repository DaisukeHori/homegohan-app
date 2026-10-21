/**
 * DBログヘルパー - Next.js API Routes用
 * ログをapp_logsテーブルに保存する
 *
 * error レベルは運用アラートの種になる: 直近 15 分の error が 20 件を超えると、運用のメールに知らされる
 * (GET /api/cron/app-log-alerts。#1157)。想定内の失敗 (入力の誤りなど) は warn で書き、本物の障害だけを error にする。
 */

import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import { sanitizeLogEntry, sanitizeMetadata } from '../../supabase/functions/_shared/log-sanitizer';
// 何も import しないファイル。ここから読んでも、ブラウザ・Edge のバンドルに余計なものは入らない
import { getSupabaseServiceConfig, isMissingEnvError } from './env-required';

// #1044 (F6-20) / #1171: マスキング・切り詰めの実体は Edge Functions と共用の log-sanitizer.ts にある。
// 従来どおり '@/lib/db-logger' から import できるよう、ここから再エクスポートする
// (src/app/api/log/route.ts や src/__tests__/lib/db-logger.test.ts が使っている)。
export {
  maskSecrets,
  truncateMetadata,
  sanitizeMetadata,
  sanitizeLogText,
  sanitizeLogEntry,
} from '../../supabase/functions/_shared/log-sanitizer';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 必須の環境変数が欠けていたとき (MissingEnvError)、その変数名を入れる metadata のキー (#1182)。
 * MissingEnvError の message には変数名を入れない (500 の本文に漏れないように。#1172)。
 * 例外が error() に渡った経路 (internalError() など) では、構造化ログ (console と app_logs) の metadata のこのキーに
 * 欠けている変数名が入る。値は記録しない。error() を通らない経路でも、env-required.ts が投げる前に
 * サーバーのログへ変数名を 1 行出す (MISSING_ENV_SERVER_LOG_PREFIX)。
 */
export const MISSING_ENV_NAME_LOG_KEY = 'missing_env_name';

/**
 * error() に渡されたエラーが MissingEnvError なら、欠けている変数名を metadata に足す。
 * それ以外のエラーでは metadata をそのまま返す。
 */
export function withMissingEnvName(
  error: unknown,
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isMissingEnvError(error)) return metadata;
  return { ...metadata, [MISSING_ENV_NAME_LOG_KEY]: error.envName };
}

interface LogEntry {
  level: LogLevel;
  source: 'edge-function' | 'api-route' | 'client';
  function_name?: string;
  user_id?: string;
  message: string;
  metadata?: Record<string, unknown>;
  error_message?: string;
  error_stack?: string;
  request_id?: string;
}

/**
 * Supabase クライアント（service_role）。接続情報が欠けていれば null (ログは console にだけ残り、app_logs には書かない)。
 * 接続情報は env-required の getter で取り出す (#1434。空白だけの値も欠けているとみなす)。
 * 欠けている変数名は getter がサーバーのログに 1 行残す (MISSING_ENV_SERVER_LOG_PREFIX)。
 * ログを書く処理なので、ここでは例外を投げない (MissingEnvError 以外の失敗は saveLog の catch が受ける)。
 * canonical の getSupabaseAdmin (lib/supabase/server.ts) を使わないのは、このファイルがブラウザ向けのページからも
 * import され、next/headers を読むあちらを取り込めないため (#1162。tests/supabase-service-role-client-scan.test.ts の例外の一覧)。
 * app_logs への insert にだけ使い、ほかの用途で service_role のクライアントをここから出さない。
 * クライアントの設定 (autoRefreshToken・persistSession を切る) は getSupabaseAdmin とそろえる (#1555。
 * service_role の鍵にはサインインのセッションが無いので、トークンの更新もセッションの保存も要らない)。
 */
function getSupabaseClient() {
  let config: { url: string; serviceRoleKey: string };
  try {
    config = getSupabaseServiceConfig();
  } catch (error) {
    if (isMissingEnvError(error)) return null;
    throw error;
  }

  return createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * ログをDBに保存（非同期、失敗しても例外を投げない）
 */
async function saveLog(entry: LogEntry): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return;

    // #1044 (F6-20) / #1171: 保存前に message / error_message / error_stack / metadata の
    // 秘密情報マスキングと文字数の切り詰めを行い、uuid でない user_id は NULL にする
    const { error } = await supabase.from('app_logs').insert(sanitizeLogEntry(entry));

    if (error) {
      console.error('Failed to save log to DB:', error);
    }
  } catch (e) {
    console.error('Failed to save log to DB:', e);
  }
}

/**
 * app_logs への保存を待たせる上限 (ミリ秒)。undici (Node.js の fetch) の接続のタイムアウトの既定値 (10 秒) と同じにする。
 * 保存がこれより長くかかるときは、それ以上は関数を延命しない (Supabase に届かないときに、ログのたびに関数が止まれずに課金が伸びるのを防ぐ)。
 */
export const LOG_SAVE_KEEPALIVE_TIMEOUT_MS = 10_000;

/**
 * ログの保存を始め、保存が終わる (または LOG_SAVE_KEEPALIVE_TIMEOUT_MS を過ぎる) まで Vercel の関数を止めさせない (#1909)。
 *
 * 呼び出し元はログの保存を待たずに応答を返す。Vercel は応答を返した関数を止める (凍結する) ので、
 * 保存の通信 (Supabase への接続・TLS の握手・insert) の途中で止められると、次の呼び出しで関数が起こされたときに
 * 接続が切れていて `TypeError: fetch failed` (ECONNRESET / UND_ERR_SOCKET) になり、その行は保存されない。
 * waitUntil に渡すと、Vercel は渡した Promise が終わるまで関数を止めない。Vercel の外 (ローカル・テスト・ブラウザ) では
 * waitUntil は何もしない (@vercel/functions の getContext が空を返す)。
 * 渡す Promise は reject しない (saveLog は例外を投げない。上限のタイマーも resolve だけ)。
 */
function saveLogInBackground(entry: LogEntry): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const saving = saveLog(entry).catch(() => {});
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LOG_SAVE_KEEPALIVE_TIMEOUT_MS);
  });
  const settled = Promise.race([saving, deadline]).finally(() => clearTimeout(timer));
  try {
    waitUntil(settled);
  } catch {
    // waitUntil が使えない環境でも、ログの保存そのものは続ける (ログの失敗で呼び出し元を止めない)
  }
}

/**
 * API Route用のロガー
 */
export function createLogger(routeName: string, requestId?: string) {
  const baseEntry = {
    source: 'api-route' as const,
    function_name: routeName,
    request_id: requestId,
  };

  // 同時にコンソールにも出力
  const log = (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level.toUpperCase()}] [${routeName}] ${message}`;
    // #1044 round-2: DB保存時と同様、コンソール出力にも秘密情報マスキングを適用する
    // (Vercel の関数ログにも生の metadata が残らないようにする)
    const sanitizedMetadata = sanitizeMetadata(metadata);

    // コンソール出力
    if (level === 'error') {
      console.error(logLine, sanitizedMetadata || '');
    } else if (level === 'warn') {
      console.warn(logLine, sanitizedMetadata || '');
    } else {
      console.log(logLine, sanitizedMetadata || '');
    }

    // DB保存（非同期、待たない。保存が終わるまで関数は止めさせない (#1909)）
    saveLogInBackground({
      ...baseEntry,
      level,
      message,
      metadata,
    });
  };

  return {
    debug: (message: string, metadata?: Record<string, unknown>) => log('debug', message, metadata),
    info: (message: string, metadata?: Record<string, unknown>) => log('info', message, metadata),
    warn: (message: string, metadata?: Record<string, unknown>) => log('warn', message, metadata),
    error: (message: string, error?: Error | unknown, rawMetadata?: Record<string, unknown>) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      // 必須の環境変数が欠けていたなら、その変数名を metadata に残す (#1182)
      const metadata = withMissingEnvName(error, rawMetadata);
      
      const timestamp = new Date().toISOString();
      console.error(`[${timestamp}] [ERROR] [${routeName}] ${message}`, error, sanitizeMetadata(metadata) || '');

      saveLogInBackground({
        ...baseEntry,
        level: 'error',
        message,
        metadata,
        error_message: errorMessage,
        error_stack: errorStack,
      });
    },
    
    /**
     * ユーザーIDをログに含める
     */
    withUser: (userId: string) => {
      const userEntry = { ...baseEntry, user_id: userId };
      
      const userLog = (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${routeName}] [user:${userId}] ${message}`, sanitizeMetadata(metadata) || '');

        saveLogInBackground({
          ...userEntry,
          level,
          message,
          metadata,
        });
      };

      return {
        debug: (message: string, metadata?: Record<string, unknown>) => userLog('debug', message, metadata),
        info: (message: string, metadata?: Record<string, unknown>) => userLog('info', message, metadata),
        warn: (message: string, metadata?: Record<string, unknown>) => userLog('warn', message, metadata),
        error: (message: string, error?: Error | unknown, rawMetadata?: Record<string, unknown>) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : undefined;
          // 必須の環境変数が欠けていたなら、その変数名を metadata に残す (#1182)
          const metadata = withMissingEnvName(error, rawMetadata);

          console.error(`[${new Date().toISOString()}] [ERROR] [${routeName}] [user:${userId}] ${message}`, error, sanitizeMetadata(metadata) || '');

          saveLogInBackground({
            ...userEntry,
            level: 'error',
            message,
            metadata,
            error_message: errorMessage,
            error_stack: errorStack,
          });
        },
      };
    },
  };
}

/** リクエスト ID の乱数の部分のバイト数 (16 進で 12 文字 = 48 ビット。同じミリ秒に作った ID どうしが重ならない程度) */
const REQUEST_ID_RANDOM_BYTES = 6;
/** 1 バイトを 16 進で書いたときの桁数 */
const HEX_DIGITS_PER_BYTE = 2;

/**
 * リクエストIDを生成
 *
 * 形は「req_<ミリ秒>_<英小文字と数字>」(以前と同じ)。乱数の部分は crypto.getRandomValues で作る
 * (#1444 CodeQL js/insecure-randomness: Math.random は推測できる。ID はログの突き合わせに使うだけだが、
 * 推測できる乱数を使う場所を残さない)。ブラウザ・Node・Deno のどれにも globalThis.crypto がある。
 */
export function generateRequestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(REQUEST_ID_RANDOM_BYTES));
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(HEX_DIGITS_PER_BYTE, '0')).join('');
  return `req_${Date.now()}_${random}`;
}

/**
 * クライアントサイドログを保存するためのAPI呼び出し
 */
export async function logToServer(
  level: LogLevel,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, metadata }),
    });
  } catch {
    // 失敗しても無視
  }
}
