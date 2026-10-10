import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'node:crypto';
import * as dotenv from 'dotenv';
import { grantE2eAiConsent } from './lib/e2e-ai-consent';

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SERVICE_ROLE_KEY');
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// 共通テストパスワード。E2E_USER_PASSWORD があればそれを使う
// (CI の e2e ローカルジョブは実行ごとにランダムな値を渡す。値はログに出さない)。
// 無ければ node:crypto でランダムに作り、ユーザーの作成・更新に使ったうえで .env.local に書く。
// リポジトリには既定のパスワードを置かない (値は標準出力にも出さない)。
const PASSWORD_FROM_ENV = process.env.E2E_USER_PASSWORD;
// アプリのパスワード要件 (8 文字以上・英数字混在) を満たすよう、末尾に Aa1! を付ける
const PASSWORD = PASSWORD_FROM_ENV || `${randomBytes(18).toString('base64url')}Aa1!`;
const accounts = Array.from({ length: 10 }, (_, i) => ({
  num: String(i + 1).padStart(2, '0'),
  email: `e2e-user-${String(i + 1).padStart(2, '0')}@homegohan.test`,
}));

(async () => {
  const created: { email: string; id: string }[] = [];
  let failed = 0;
  for (const a of accounts) {
    // 既存確認
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const existing = list?.users.find(u => u.email === a.email);
    let id = existing?.id;
    if (!existing) {
      const { data, error } = await admin.auth.admin.createUser({
        email: a.email,
        password: PASSWORD,
        email_confirm: true,
      });
      if (error) { console.error('create', a.email, error.message); failed++; continue; }
      id = data.user!.id;
    } else {
      // 既存ユーザーもパスワードをそろえる (前回と違うパスワードで実行してもログインできるように)
      const { error } = await admin.auth.admin.updateUserById(existing.id, { password: PASSWORD, email_confirm: true });
      if (error) { console.error('update', a.email, error.message); failed++; continue; }
    }
    // user_profiles upsert (PK は id = auth.uid)
    const { error: pErr } = await admin.from('user_profiles').upsert({
      id: id,
      nickname: `e2e-user-${a.num}`,
      onboarding_completed_at: new Date().toISOString(),
      nutrition_goal: 'maintain',
      exercise_frequency: 3,
      exercise_duration_per_session: 30,
      gender: 'male',
      age: 35,
      age_group: '30s',
      height: 170,
      weight: 65,
    }, { onConflict: 'id' });
    if (pErr) { console.error('user_profiles', a.email, pErr.message); failed++; continue; }
    // nutrition_targets upsert
    const { error: tErr } = await admin.from('nutrition_targets').upsert({
      user_id: id,
      daily_calories: 2000,
      protein_g: 60,
      fat_g: 60,
      carbs_g: 250,
      auto_calculate: true,
    }, { onConflict: 'user_id' });
    if (tErr) { console.error('nutrition_targets', a.email, tErr.message); failed++; continue; }
    // 外国の AI 事業者への提供の同意 (T15 / #1154)。未同意だと AI を使う e2e がサーバーに止められる (403 AI_CONSENT_REQUIRED)
    try {
      await grantE2eAiConsent(admin, id!);
    } catch (e) {
      console.error('ai_consent', a.email, e instanceof Error ? e.message : String(e));
      failed++;
      continue;
    }
    created.push({ email: a.email, id: id! });
    console.log('OK', a.email);
  }
  console.log('Created/verified', created.length);
  if (failed > 0) {
    console.error(`Failed: ${failed}`);
    process.exitCode = 1;
  }
  const envPath = path.resolve(__dirname, '..', '.env.local');
  const existingEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  // E2E_USER_PASSWORD を渡された場合は、呼び出し側がパスワードを持っているので .env.local に書かない
  if (PASSWORD_FROM_ENV) {
    // .env.local に今回と違う E2E_USER_XX_PASSWORD があると、テストはそちらを優先してログインに失敗する。気づけるよう警告する (値は出さない)
    for (const a of accounts) {
      const key = `E2E_USER_${a.num}_PASSWORD`;
      const current = readEnvValue(existingEnv, key);
      if (current !== undefined && current !== PASSWORD) {
        console.warn(`WARN: .env.local の ${key} が今回のパスワードと異なります (テストは個別の値を優先します)`);
      }
    }
    return;
  }
  // .env.local に書く。行が既にあれば値を書き換える (ランダムなので、前回の値と食い違うため)。無ければ追記する
  let env = existingEnv;
  for (const a of accounts) {
    env = upsertEnvLine(env, `E2E_USER_${a.num}_EMAIL`, a.email);
    env = upsertEnvLine(env, `E2E_USER_${a.num}_PASSWORD`, PASSWORD);
  }
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  console.log('.env.local updated');
})();

/** .env 形式の文字列から KEY の値を返す (無ければ undefined)。前後の引用符は外す */
function readEnvValue(env: string, key: string): string | undefined {
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) return undefined;
  return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** .env 形式の文字列で KEY=value の行を書き換える。行が無ければ末尾に追記する */
function upsertEnvLine(env: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) return env.replace(re, () => `${key}=${value}`);
  const sep = env === '' || env.endsWith('\n') ? '' : '\n';
  return `${env}${sep}${key}=${value}\n`;
}
