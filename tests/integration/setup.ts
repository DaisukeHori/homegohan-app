/**
 * Integration test global setup.
 * dotenv で .env.local を明示的に読み込む。
 * vitest.integration.config.ts の loadEnv と二重になるが、
 * fork worker 内で process.env が欠落するケースへの保険として維持する。
 */
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';

import { installAuthTransientRetry } from './helpers/auth-transient-retry';

dotenvConfig({ path: path.resolve(process.cwd(), '.env.local') });

// ローカル Supabase の認証 (/auth/v1) へのゲートウェイの一時的な失敗 (502 / 503 / 504・接続の失敗) を、このプロセスの fetch でやり直す。
// 負荷が高い機械で beforeAll のユーザー作成・サインインが `{}` のエラーで落ちたため (理由と線引きは helpers/auth-transient-retry.ts)
installAuthTransientRetry(process.env);
