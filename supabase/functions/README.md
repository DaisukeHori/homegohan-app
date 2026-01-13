# Supabase Edge Functions

このディレクトリには Supabase Edge Functions（Deno ランタイム）が格納されています。

## 接続情報

| 項目 | 値 |
|------|-----|
| Project ID | `flmeolcfutuwwbjmzyoz` |
| URL | `https://flmeolcfutuwwbjmzyoz.supabase.co` |
| ANON_KEY | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsbWVvbGNmdXR1d3diam16eW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NzAxODYsImV4cCI6MjA3OTU0NjE4Nn0.VVxUxKexNeN6dUiAMDkCNlnIoXa-F5rfBqHPBDcwdnU` |

### Functions呼び出し例

```bash
curl -X POST "https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/<function-name>" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsbWVvbGNmdXR1d3diam16eW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NzAxODYsImV4cCI6MjA3OTU0NjE4Nn0.VVxUxKexNeN6dUiAMDkCNlnIoXa-F5rfBqHPBDcwdnU" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

## デプロイ方法

### 自動デプロイ（推奨）

**GitHub Actions による自動デプロイが設定されています。**

`main` ブランチに `supabase/functions/**` 配下の変更がpushされると、自動的に Supabase にデプロイされます。

```
main へ push → GitHub Actions → Supabase Functions デプロイ
```

ワークフロー: `.github/workflows/deploy-supabase-functions.yml`

### 手動デプロイ

ローカルから手動でデプロイする場合：

```bash
# 全関数をデプロイ
supabase functions deploy --project-ref flmeolcfutuwwbjmzyoz

# 特定の関数のみデプロイ
supabase functions deploy <function-name> --project-ref flmeolcfutuwwbjmzyoz
```

## 関数一覧

| 関数名 | 説明 |
|--------|------|
| `generate-menu-v4` | 献立生成 v4（メイン） |
| `knowledge-gpt` | 知識検索・レシピ検索 |
| `normalize-shopping-list` | 買い物リスト正規化 |
| `analyze-meal-photo` | 食事写真分析（Gemini） |
| `analyze-fridge` | 冷蔵庫写真分析（OpenAI Vision） |
| `analyze-health-photo` | 健康写真分析 |
| `generate-health-insights` | 健康インサイト生成 |
| `create-derived-recipe` | 派生レシピ作成 |
| `aggregate-org-stats` | 組織統計集約 |
| `calculate-segment-stats` | セグメント統計計算 |
| `backfill-ingredient-embeddings` | 材料埋め込みバックフィル |
| `regenerate-embeddings` | 埋め込み再生成 |
| `regenerate-shopping-list-v2` | 買い物リスト再生成 v2 |

## ディレクトリ構成

```
supabase/functions/
├── _shared/                 # 共有ユーティリティ（全関数から参照可能）
│   ├── cors.ts             # CORS設定
│   ├── db-logger.ts        # ログ記録
│   ├── allergy.ts          # アレルギー処理
│   ├── nutrition-*.ts      # 栄養計算関連
│   ├── meal-generator.ts   # 献立生成ロジック
│   └── ...
├── <function-name>/
│   ├── index.ts            # エントリポイント（必須）
│   └── deno.json           # Deno設定（オプション）
└── README.md               # このファイル
```

## 開発ガイド

### 新しい関数の作成

```bash
# 新規関数ディレクトリ作成
mkdir supabase/functions/<function-name>

# index.ts を作成（必須）
touch supabase/functions/<function-name>/index.ts
```

### 基本テンプレート

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { data } = await req.json();

    // ロジック実装

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
```

### ローカルでのテスト

```bash
# Supabase ローカル環境起動
supabase start

# 関数をローカルで実行
supabase functions serve <function-name>
```

## 環境変数

Supabase Dashboard → Edge Functions → 対象関数 → Settings で設定。

主な環境変数：
- `OPENAI_API_KEY` - OpenAI API キー
- `GOOGLE_AI_API_KEY` - Gemini API キー

## 注意事項

- `_shared/` ディレクトリは関数としてデプロイされません
- 各関数は独立した Deno プロセスで実行されます
- コールドスタートを考慮した設計を推奨
