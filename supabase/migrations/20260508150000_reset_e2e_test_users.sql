-- E2E テストユーザーの DB 状態をテスト前提にリセットする RPC
-- 解決: issue #636 (USER_03 onboarding 完了済) / issue #638 (USER_04 既登録)
--
-- 呼び出し: reset-test-users.sh または npm run test:e2e:reset-data
-- 権限: service_role のみ実行可 (SECURITY DEFINER)

CREATE OR REPLACE FUNCTION public.reset_e2e_test_users()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user03_id uuid;
  v_user04_id uuid;
BEGIN
  -- USER_03: onboarding_completed_at を NULL に戻す
  -- 対象: メールアドレスが e2e-user-03@*.test パターン
  SELECT au.id INTO v_user03_id
  FROM auth.users au
  WHERE au.email ~ '^e2e-user-03@.+\.test$'
  LIMIT 1;

  IF v_user03_id IS NOT NULL THEN
    UPDATE public.user_profiles
    SET onboarding_completed_at = NULL
    WHERE id = v_user03_id;

    RAISE NOTICE 'USER_03 (%) の onboarding_completed_at を NULL にリセットしました', v_user03_id;
  ELSE
    RAISE NOTICE 'USER_03 (e2e-user-03@*.test) が見つかりません。スキップします';
  END IF;

  -- USER_04: auth.users から DELETE (cascade で user_profiles も削除)
  -- 対象: メールアドレスが e2e-user-04@*.test パターン
  SELECT au.id INTO v_user04_id
  FROM auth.users au
  WHERE au.email ~ '^e2e-user-04@.+\.test$'
  LIMIT 1;

  IF v_user04_id IS NOT NULL THEN
    DELETE FROM auth.users WHERE id = v_user04_id;
    RAISE NOTICE 'USER_04 (%) を auth.users から削除しました (cascade)', v_user04_id;
  ELSE
    RAISE NOTICE 'USER_04 (e2e-user-04@*.test) が見つかりません。スキップします';
  END IF;
END;
$$;

-- service_role のみに EXECUTE 権限を付与
-- (SECURITY DEFINER なので呼び出し者権限ではなく関数定義者権限で動く)
REVOKE ALL ON FUNCTION public.reset_e2e_test_users() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_e2e_test_users() FROM anon;
REVOKE ALL ON FUNCTION public.reset_e2e_test_users() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reset_e2e_test_users() TO service_role;
