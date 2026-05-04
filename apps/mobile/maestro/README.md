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

## 並列実行スクリプト

```bash
# 10 並列で全 flow を実行
PARALLEL_COUNT=10 PER_FLOW_TIMEOUT=300 ./scripts/maestro-parallel-runner.sh
```

- `PARALLEL_COUNT`: 並列数 (デフォルト 10)
- `PER_FLOW_TIMEOUT`: 1 flow あたりの最大秒数 (デフォルト 300)
- `RESULT_DIR`: 結果保存先 (デフォルト `/tmp/maestro-results`)

事前に iPhone-E2E-01..N の sim を作成し boot しておく。Metro bundler は別途起動。
