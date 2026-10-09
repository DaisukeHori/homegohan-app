# @homegohan/core

Web / Mobile 共通の **API クライアント・計算エンジン** パッケージ。
純粋ロジック・定数は `@homegohan/shared` に置く。

## 境界定義

| カテゴリ | 内容 | 例 |
|--------|------|-----|
| HTTP client | fetch ラッパー・認証トークン付与・タイムアウト・リトライ | `createHttpClient`, `HttpClient` |
| 栄養計算エンジン | DRI2020 準拠の栄養目標計算 | `calculateNutritionTargets` |
| 型定義 | API・プロフィール型 | `UserProfileLite`, `NutritionCalculatorInput` |
| Zod スキーマ | API レスポンス検証 | `DishSchema`, `MenuResponseSchema` |
| 週計算 | 週範囲・日付操作 | `getWeekRange`, `shiftWeek` |
| アダプティブループ | チェックイン分析・推奨調整 | `analyzeCheckinLoop`, `applyRecommendations` |

## HTTP client のタイムアウトとリトライ (#1168)

`createHttpClient` は、通信が止まったままにならないように、タイムアウトと自動のやり直しを持つ。

| 項目 | 既定の動き |
|------|-----------|
| タイムアウト | 1 回の通信を 20 秒で打ち切る (`timeoutMs`。呼び出しごとにも指定できる。0 以下で上限なし) |
| やり直す呼び出し | GET / HEAD / PUT / DELETE だけ。**POST と PATCH は既定ではやり直さない** (AI の生成のように、二重に走ると困る呼び出しがあるため) |
| やり直す失敗 | 応答を受け取れなかったとき、HTTP 408 / 429 / 5xx (501 と 505 を除く)。4xx と、タイムアウトはやり直さない |
| 回数と待ち時間 | 最大 2 回。待ち時間は 500ms を基準に倍々で増やし、半分を乱数で散らす。`Retry-After` があればそれ以上待ち、10 秒より長く待たされるときはやり直さずにエラーにする |

- POST などをやり直したい呼び出しは、`api.post(path, body, { retry: true })` のように呼び出しごとに明示する。サーバーが同じリクエストを二重に処理しても困らないと確かめた呼び出しにだけ使うこと。
- やり直しを止めるときは `{ retry: false }` (クライアント全体なら `createHttpClient({ retry: false })`)。
- 応答を受け取れなかったときは `HttpNetworkError` を投げる。`kind` が `'timeout'` (待ち時間切れ) か `'offline'` (圏外・機内モードなど)。画面は `isHttpNetworkError(error)` で見分けて「通信できません」と案内できる。`networkErrorMessages` で、エラーの文面を画面に出せる文にできる。
- HTTP のエラー応答 (4xx / 5xx) は、従来どおり `HTTP <status> <statusText>: <本文>` の `Error`。
- 成功 (2xx) なのに本文が JSON として読めない応答 (公衆 Wi-Fi のログイン画面、障害時のエラーページなど) は、`SyntaxError` ではなく `HttpParseError` を投げる (`isHttpParseError(error)` で見分けられる。同じ応答が返るだけなのでやり直さない)。`invalidResponseMessage` で、エラーの文面を画面に出せる文にできる (#1049)。

## 含めないもの

- 純粋定数・ラベル → `@homegohan/shared`
- UI コンポーネント → 各プラットフォームの `src/components`
- Supabase client インスタンス → 各プラットフォームで初期化 (環境変数が異なるため)
- プラットフォーム固有のストレージ → 各プラットフォームの `src/lib`

## インポート方法

```ts
import { createHttpClient, calculateNutritionTargets } from '@homegohan/core';
```

## モジュール一覧

| ファイル | エクスポート |
|---------|------------|
| `api/httpClient.ts` | `createHttpClient`, `HttpClient`, `HttpRequestOptions`, `RetryOptions`, `GetAccessToken`, `HttpNetworkError`, `isHttpNetworkError`, `HttpParseError`, `isHttpParseError`, `DEFAULT_TIMEOUT_MS` |
| `nutrition/calculate.ts` | `calculateNutritionTargets` |
| `nutrition/types.ts` | `NutritionCalculatorInput`, `NutritionCalculationResult`, etc. |
| `nutrition/dri-tables.ts` | DRI2020 参照テーブル |
| `nutrition/adaptive-loop.ts` | `analyzeCheckinLoop`, `applyRecommendations` |
| `schemas/dish.ts` | `DishSchema`, `DishRole`, `Dish` |
| `schemas/menu-response.ts` | `MenuResponseSchema` |
| `schemas/generation-config.ts` | `GenerationConfigSchema` |
| `types/userProfile.ts` | `UserProfileLite`, `DbUserProfileLite` |
| `converters/userProfile.ts` | `toUserProfileLite` |
| `utils/week-utils.ts` | `getWeekRange`, `shiftWeek`, `formatLocalDate`, `getDaysBetween` |
