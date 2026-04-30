-- e2e テストユーザーの onboarding_completed_at を埋めて
-- /pantry や /home が onboarding 画面に飛ばされないようにする
-- (アプリは onboarding_completed_at の有無のみで完了判定しているため、このカラムのみ更新)
UPDATE public.user_profiles
   SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW())
 WHERE id IN (
   SELECT id FROM auth.users WHERE email IN (
     'e2e-user@homegohan.test',
     'e2e-admin@homegohan.test',
     'e2e-super@homegohan.test'
   )
 );
