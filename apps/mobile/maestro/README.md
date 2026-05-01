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
