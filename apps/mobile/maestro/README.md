# Maestro E2E テスト

## Maestro CLI のインストール

```bash
curl -Ls https://get.maestro.mobile.dev | bash
```

インストール後、ターミナルを再起動してパスを通してください。

## テストの実行

シミュレーター/エミュレーターを起動した状態で以下を実行:

```bash
# apps/mobile ディレクトリから
maestro test maestro/

# 特定フローのみ
maestro test maestro/smoke.yaml
```

## ファイル構成

| ファイル | 説明 |
|---------|------|
| `smoke.yaml` | アプリ起動確認のスモークテスト |

## 前提条件

- iOS: Xcode + シミュレーター起動済み
- Android: Android Studio + エミュレーター起動済み
- アプリビルド済み (`expo run:ios` or `expo run:android`)

## E2E テストユーザーのデータリセット

テスト前にユーザー状態をリセットする必要がある場合 (issue #636 / #638):

```bash
# リポジトリルートから
npm run test:e2e:reset-data

# または直接
bash apps/mobile/maestro/scripts/reset-test-users.sh
```

前提:
- `.env.local` に `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` が設定済み
- `reset_e2e_test_users` RPC が Supabase に適用済み (`supabase/migrations/20260508150000_reset_e2e_test_users.sql`)

リセット内容:
- `E2E_USER_03` (`e2e-user-03@*.test`): `onboarding_completed_at` を NULL に戻す
- `E2E_USER_04` (`e2e-user-04@*.test`): `auth.users` から削除 (cascade で profiles も削除)

## mock サーバーが必要な flow

一部の異常系テスト (特定 HTTP エラーのシミュレーション) は実際の Supabase では再現できないため、
mock サーバー環境でのみ実行してください:

```bash
# mock サーバーを起動した状態で
MAESTRO_RUN_NETWORK_FAULT=1 maestro test maestro/flows/auth/16-signup-api-500-error.yaml
```

`MAESTRO_RUN_NETWORK_FAULT` が未設定または `"1"` 以外の場合、これらの flow は自動的にスキップされます。
(issue #641 参照)

## 並列実行スクリプト

```bash
# 10 並列で全 flow を実行
PARALLEL_COUNT=10 PER_FLOW_TIMEOUT=300 ./scripts/maestro-parallel-runner.sh
```

- `PARALLEL_COUNT`: 並列数 (デフォルト 10)
- `PER_FLOW_TIMEOUT`: 1 flow あたりの最大秒数 (デフォルト 300)
- `RESULT_DIR`: 結果保存先 (デフォルト `/tmp/maestro-results`)

事前に iPhone-E2E-01..N の sim を作成し boot しておく。Metro bundler は別途起動。
