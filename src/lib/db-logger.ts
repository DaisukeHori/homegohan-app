/**
 * DBログヘルパー - Next.js API Routes用
 * ログをapp_logsテーブルに保存する
 *
 * error レベルは運用アラートの種になる: 直近 15 分の error が 20 件を超えると、運用のメールに知らされる
 * (GET /api/cron/app-log-alerts。#1157)。想定内の失敗 (入力の誤りなど) は warn で書き、本物の障害だけを error にする。
 */

import { createClient } from '@supabase/supabase-js';
import { sanitizeLogEntry, sanitizeMetadata } from '../../supabase/functions/_shared/log-sanitizer';

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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
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

    // DB保存（非同期、待たない）
    saveLog({
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
      console.error(`[${timestamp}] [ERROR] [${routeName}] ${message}`, error, sanitizeMetadata(metadata) || '');

      saveLog({
        ...baseEntry,
        level: 'error',
        message,
        metadata,
        error_message: errorMessage,
        error_stack: errorStack,
      }).catch(() => {});
    },
    
    /**
     * ユーザーIDをログに含める
     */
    withUser: (userId: string) => {
      const userEntry = { ...baseEntry, user_id: userId };
      
      const userLog = (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${routeName}] [user:${userId}] ${message}`, sanitizeMetadata(metadata) || '');

        saveLog({
          ...userEntry,
          level,
          message,
          metadata,
        }).catch(() => {});
      };

      return {
        debug: (message: string, metadata?: Record<string, unknown>) => userLog('debug', message, metadata),
        info: (message: string, metadata?: Record<string, unknown>) => userLog('info', message, metadata),
        warn: (message: string, metadata?: Record<string, unknown>) => userLog('warn', message, metadata),
        error: (message: string, error?: Error | unknown, metadata?: Record<string, unknown>) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : undefined;

          console.error(`[${new Date().toISOString()}] [ERROR] [${routeName}] [user:${userId}] ${message}`, error, sanitizeMetadata(metadata) || '');

          saveLog({
            ...userEntry,
            level: 'error',
            message,
            metadata,
            error_message: errorMessage,
            error_stack: errorStack,
          }).catch(() => {});
        },
      };
    },
  };
}

/**
 * リクエストIDを生成
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
