/**
 * DBログヘルパー - Edge Functions用
 * ログをapp_logsテーブルに保存する
 */

// 版は supabase/functions/deno.json の imports で固定する (#1518。以前は esm.sh からメジャー版だけの指定で読んでいた)
import { createClient } from "@supabase/supabase-js";
import { sanitizeLogEntry } from "./log-sanitizer.ts";

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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

// Supabase クライアント（service_role）
function getSupabaseClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  // SERVICE_ROLE_JWT を優先し、なければ SUPABASE_SERVICE_ROLE_KEY を使用
  const supabaseServiceKey = Deno.env.get('SERVICE_ROLE_JWT') 
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL or service role key');
    return null;
  }
  
  return createClient(supabaseUrl, supabaseServiceKey);
}

/**
 * ログをDBに保存（非同期、失敗しても例外を投げない）
 */
async function saveLog(entry: LogEntry): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return;

    // #1171: 保存前に message / error_message / error_stack / metadata の秘密情報マスキングと
    // 文字数の切り詰めを行い、uuid でない user_id は NULL にする (Next.js 側の src/lib/db-logger.ts と同じ処理)
    const { error } = await supabase.from('app_logs').insert(sanitizeLogEntry(entry));

    if (error) {
      console.error('Failed to save log to DB:', error);
    }
  } catch (e) {
    console.error('Failed to save log to DB:', e);
  }
}

/**
 * app_logs への保存を待たせる上限 (ミリ秒)。Next.js 側の src/lib/db-logger.ts の LOG_SAVE_KEEPALIVE_TIMEOUT_MS と同じ値・同じ理由
 * (保存がこれより長くかかるときは、それ以上は関数を延命しない。Supabase に届かないときに、ログのたびに関数が止まれずに
 * 実行時間が伸びるのを防ぐ)。2 つが同じ値であることは tests/edge-db-logger-keepalive-1909.test.ts が確かめる。
 */
export const LOG_SAVE_KEEPALIVE_TIMEOUT_MS = 10_000;

/** EdgeRuntime.waitUntil の形 (Supabase の Edge Runtime だけにある。Deno の素の実行やテストには無い) */
interface EdgeRuntimeLike {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Supabase の Edge Runtime の EdgeRuntime を取り出す。無ければ (Supabase の外・テスト) null。
 * 型の宣言 (@supabase/functions-js/edge-runtime.d.ts) を読まずに済むよう、globalThis から形を確かめて取り出す。
 */
function getEdgeRuntime(): EdgeRuntimeLike | null {
  const runtime: unknown = Reflect.get(globalThis, "EdgeRuntime");
  if (typeof runtime !== "object" || runtime === null) return null;
  if (!("waitUntil" in runtime) || typeof runtime.waitUntil !== "function") return null;
  const waitUntil = runtime.waitUntil;
  return {
    waitUntil: (promise) => {
      waitUntil.call(runtime, promise);
    },
  };
}

/**
 * ログの保存を始め、保存が終わる (または LOG_SAVE_KEEPALIVE_TIMEOUT_MS を過ぎる) まで Edge Function を止めさせない (#1909)。
 *
 * 呼び出し元はログの保存を待たずに応答を返す。Supabase の Edge Runtime は、応答を返したあとの処理を
 * EdgeRuntime.waitUntil に渡された Promise の分だけ続ける (公式の文書 "Background Tasks":
 * "The Function instance continues to run until the promise provided to waitUntil completes")。
 * 渡さないと、保存の通信の途中で関数が止められ、その行は app_logs に残らない (Next.js 側の #1909 と同じ形)。
 * EdgeRuntime が無い環境 (テスト・素の Deno) では渡さずに保存だけを続ける。
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
    getEdgeRuntime()?.waitUntil(settled);
  } catch {
    // waitUntil が使えない状態でも、ログの保存そのものは続ける (ログの失敗で呼び出し元を止めない)
  }
}

/**
 * Edge Function用のロガー
 */
export function createLogger(functionName: string, requestId?: string) {
  const baseEntry = {
    source: 'edge-function' as const,
    function_name: functionName,
    request_id: requestId,
  };

  // 同時にコンソールにも出力
  const log = (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level.toUpperCase()}] [${functionName}] ${message}`;
    
    // コンソール出力
    if (level === 'error') {
      console.error(logLine, metadata || '');
    } else if (level === 'warn') {
      console.warn(logLine, metadata || '');
    } else {
      console.log(logLine, metadata || '');
    }
    
    // DB保存（非同期、待たない。保存が終わるまで関数は止めさせない (#1909)）
    saveLogInBackground({
      ...baseEntry,
      level,
      message,
      metadata,
    }).catch(() => {});
  };

  return {
    debug: (message: string, metadata?: Record<string, unknown>) => log('debug', message, metadata),
    info: (message: string, metadata?: Record<string, unknown>) => log('info', message, metadata),
    warn: (message: string, metadata?: Record<string, unknown>) => log('warn', message, metadata),
    error: (message: string, error?: Error | unknown, metadata?: Record<string, unknown>) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      const timestamp = new Date().toISOString();
      console.error(`[${timestamp}] [ERROR] [${functionName}] ${message}`, error, metadata || '');
      
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
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${functionName}] [user:${userId}] ${message}`, metadata || '');
        
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
        error: (message: string, error?: Error | unknown, metadata?: Record<string, unknown>) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : undefined;
          
          console.error(`[${new Date().toISOString()}] [ERROR] [${functionName}] [user:${userId}] ${message}`, error, metadata || '');
          
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
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(HEX_DIGITS_PER_BYTE, "0")).join("");
  return `req_${Date.now()}_${random}`;
}
