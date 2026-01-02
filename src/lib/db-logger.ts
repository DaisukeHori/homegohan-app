/**
 * DBログヘルパー - Next.js API Routes用
 * ログをapp_logsテーブルに保存する
 */

import { createClient } from '@supabase/supabase-js';

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
    
    const { error } = await supabase.from('app_logs').insert(entry);
    
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
    
    // コンソール出力
    if (level === 'error') {
      console.error(logLine, metadata || '');
    } else if (level === 'warn') {
      console.warn(logLine, metadata || '');
    } else {
      console.log(logLine, metadata || '');
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
      console.error(`[${timestamp}] [ERROR] [${routeName}] ${message}`, error, metadata || '');
      
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
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${routeName}] [user:${userId}] ${message}`, metadata || '');
        
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
          
          console.error(`[${new Date().toISOString()}] [ERROR] [${routeName}] [user:${userId}] ${message}`, error, metadata || '');
          
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
