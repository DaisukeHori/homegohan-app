/**
 * DBログヘルパー - Edge Functions用
 * ログをapp_logsテーブルに保存する
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  // Edge Functionsでは DATASET_SERVICE_ROLE_KEY を使用（Supabase CLIの制限回避）
  const supabaseServiceKey = Deno.env.get('DATASET_SERVICE_ROLE_KEY') 
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
    
    const { error } = await supabase.from('app_logs').insert(entry);
    
    if (error) {
      console.error('Failed to save log to DB:', error);
    }
  } catch (e) {
    console.error('Failed to save log to DB:', e);
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
      console.error(`[${timestamp}] [ERROR] [${functionName}] ${message}`, error, metadata || '');
      
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
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${functionName}] [user:${userId}] ${message}`, metadata || '');
        
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
          
          console.error(`[${new Date().toISOString()}] [ERROR] [${functionName}] [user:${userId}] ${message}`, error, metadata || '');
          
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
