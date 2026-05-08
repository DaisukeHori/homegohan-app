/**
 * Integration test global setup.
 * dotenv で .env.local を明示的に読み込む。
 * vitest.integration.config.ts の loadEnv と二重になるが、
 * fork worker 内で process.env が欠落するケースへの保険として維持する。
 */
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';

dotenvConfig({ path: path.resolve(process.cwd(), '.env.local') });
