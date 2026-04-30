-- e2e テストユーザーの onboarding_completed_at を埋めて
-- /pantry や /home が onboarding 画面に飛ばされないようにする
UPDATE public.user_profiles
   SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
       onboarding_completed   = TRUE
 WHERE id IN (
   SELECT id FROM auth.users WHERE email IN (
     'e2e-user@homegohan.test',
     'e2e-admin@homegohan.test',
     'e2e-super@homegohan.test'
   )
 );
