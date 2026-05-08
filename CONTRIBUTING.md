# Contributing Guide

## PR を出す前のローカルチェック

### E2E テスト (MVP スイート) — 必須

PR を出す前に、必ずローカルで MVP スイートを実行してください。

```bash
npm run test:e2e:mvp
```

このコマンドは `tests/e2e/01-*.spec.ts` 〜 `05-*.spec.ts` の 5 spec を実行します。

> **注意**: CI (GitHub Actions) でも PR トリガーで同じ MVP スイートが自動実行されます。
> ただし CI コスト削減のため、将来的に PR トリガーの E2E を一時停止する場合は
> ローカル実行結果を PR 本文に貼り付けて確認を取ってください。

### フルスイートを手動実行する場合

認証必須テストを含むフルスイートは GitHub Actions の `workflow_dispatch` で実行します。

1. GitHub リポジトリの Actions タブを開く
2. `e2e` ワークフローを選択
3. "Run workflow" から `full_suite=true` を指定して実行

### ローカルで特定 spec だけ実行する場合

```bash
# 特定の spec のみ
npx playwright test tests/e2e/01-login.spec.ts

# レポートを UI で確認
npm run test:e2e:report
```

## コミットメッセージ

Conventional Commits 形式 + 日本語サマリを使用してください。

```
feat: 新機能の概要
fix: バグ修正の概要
test: テスト追加・修正
chore: 雑務・設定変更
```
