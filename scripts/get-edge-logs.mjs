#!/usr/bin/env node

/**
 * Supabase Edge Functions のログを取得するスクリプト
 * 
 * 使い方:
 *   node scripts/get-edge-logs.mjs                          # 最新50件のログ
 *   node scripts/get-edge-logs.mjs --function generate-menu-v5  # 特定の関数のログ (いまある関数名。supabase/functions/ を参照)
 *   node scripts/get-edge-logs.mjs --since 1h               # 過去1時間のログ
 *   node scripts/get-edge-logs.mjs --tail                   # リアルタイムでログをポーリング
 */

const PROJECT_REF = 'flmeolcfutuwwbjmzyoz';

// Supabase Access Token (Dashboard -> Account -> Access Tokens で取得)
// 環境変数 SUPABASE_ACCESS_TOKEN に設定してください
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('❌ SUPABASE_ACCESS_TOKEN 環境変数を設定してください');
  console.error('');
  console.error('取得方法:');
  console.error('1. https://supabase.com/dashboard/account/tokens にアクセス');
  console.error('2. "Generate new token" をクリック');
  console.error('3. トークンを以下のように設定:');
  console.error('   export SUPABASE_ACCESS_TOKEN="your-token-here"');
  process.exit(1);
}

// コマンドライン引数をパース
const args = process.argv.slice(2);
let functionName = null;
let sinceHours = 24;
let tailMode = false;
let limit = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--function' && args[i + 1]) {
    functionName = args[i + 1];
    i++;
  } else if (args[i] === '--since' && args[i + 1]) {
    const match = args[i + 1].match(/^(\d+)([hm])$/);
    if (match) {
      sinceHours = match[2] === 'h' ? parseInt(match[1]) : parseInt(match[1]) / 60;
    }
    i++;
  } else if (args[i] === '--tail') {
    tailMode = true;
  } else if (args[i] === '--limit' && args[i + 1]) {
    limit = parseInt(args[i + 1]);
    i++;
  }
}

async function fetchLogs() {
  const startTime = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  
  // Supabase Analytics API (Logs)
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.edge-functions`;
  
  const params = new URLSearchParams({
    iso_timestamp_start: startTime,
    iso_timestamp_end: new Date().toISOString(),
  });

  try {
    const response = await fetch(`${url}?${params}`, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`❌ API Error: ${response.status} ${response.statusText}`);
      console.error(text);
      return [];
    }

    const data = await response.json();
    let logs = data.result || [];

    // 関数名でフィルタ
    if (functionName) {
      logs = logs.filter(log => 
        log.function_id === functionName || 
        log.metadata?.function_id === functionName ||
        JSON.stringify(log).includes(functionName)
      );
    }

    return logs.slice(0, limit);
  } catch (error) {
    console.error('❌ Fetch error:', error.message);
    return [];
  }
}

function formatLog(log) {
  const timestamp = log.timestamp || log.iso_timestamp || new Date().toISOString();
  const level = log.level || log.severity || 'INFO';
  const message = log.message || log.msg || log.event_message || JSON.stringify(log);
  const functionId = log.function_id || log.metadata?.function_id || 'unknown';

  const levelColors = {
    'ERROR': '\x1b[31m',
    'WARN': '\x1b[33m',
    'INFO': '\x1b[36m',
    'DEBUG': '\x1b[90m',
  };
  const color = levelColors[level] || '\x1b[0m';
  const reset = '\x1b[0m';

  return `${color}[${timestamp}] [${level}] [${functionId}]${reset} ${message}`;
}

async function main() {
  console.log('🔍 Supabase Edge Functions ログを取得中...');
  console.log(`   Project: ${PROJECT_REF}`);
  if (functionName) console.log(`   Function: ${functionName}`);
  console.log(`   期間: 過去${sinceHours}時間`);
  console.log('');

  if (tailMode) {
    console.log('📡 Tail モード（5秒ごとにポーリング）- Ctrl+C で終了');
    console.log('─'.repeat(80));
    
    let lastTimestamp = null;
    
    while (true) {
      const logs = await fetchLogs();
      
      for (const log of logs) {
        const ts = log.timestamp || log.iso_timestamp;
        if (!lastTimestamp || ts > lastTimestamp) {
          console.log(formatLog(log));
          lastTimestamp = ts;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } else {
    const logs = await fetchLogs();
    
    if (logs.length === 0) {
      console.log('📭 ログが見つかりませんでした');
    } else {
      console.log(`📋 ${logs.length} 件のログ:`);
      console.log('─'.repeat(80));
      
      for (const log of logs) {
        console.log(formatLog(log));
      }
    }
  }
}

main().catch(console.error);
