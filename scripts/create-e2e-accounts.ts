import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SERVICE_ROLE_KEY');
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// 共通テストパスワード。E2E_USER_PASSWORD があればそれを使う
// (CI の e2e ローカルジョブは実行ごとにランダムな値を渡す。値はログに出さない)
const PASSWORD_FROM_ENV = process.env.E2E_USER_PASSWORD;
const PASSWORD = PASSWORD_FROM_ENV ?? 'TestE2E2026!secure';
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
    created.push({ email: a.email, id: id! });
    console.log('OK', a.email);
  }
  console.log('Created/verified', created.length);
  if (failed > 0) {
    console.error(`Failed: ${failed}`);
    process.exitCode = 1;
  }
  // E2E_USER_PASSWORD を渡された場合は、呼び出し側がパスワードを持っているので .env.local に書かない
  if (PASSWORD_FROM_ENV) return;
  // .env.local 追記
  const envPath = path.resolve(__dirname, '..', '.env.local');
  let env = fs.readFileSync(envPath, 'utf8');
  for (const a of accounts) {
    const keyEmail = `E2E_USER_${a.num}_EMAIL`;
    const keyPwd = `E2E_USER_${a.num}_PASSWORD`;
    if (!env.includes(keyEmail)) env += `\n${keyEmail}=${a.email}`;
    if (!env.includes(keyPwd)) env += `\n${keyPwd}=${PASSWORD}`;
  }
  fs.writeFileSync(envPath, env);
  console.log('.env.local updated');
})();
