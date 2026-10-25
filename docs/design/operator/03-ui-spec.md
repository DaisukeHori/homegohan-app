# operator/ UI 画面仕様

## 1. 目的・スコープ

運営管理コンソール (`/admin`, `/super-admin`, `/support`, `/sales`, `/finance`) の全画面仕様を定義する。各画面のコンポーネント構成・状態・操作フローを記述する。

## 2. 関連要件

- 要件 03 §9 UI 画面仕様
- 要件 03 §3 ペルソナ (A〜E)
- 100-scenarios.md F ペルソナ F1〜F20
- cross/03-design-system.md
- cross/05-i18n-a11y.md

## 3. 共通レイアウト

### 3.1 管理コンソール共通 Layout

```
┌───────────────┬─────────────────────────────────────┐
│               │ ヘッダー: ロゴ / 環境バッジ / ユーザー │
│  サイドバー   ├─────────────────────────────────────┤
│  (ロール別)   │                                     │
│               │  メインコンテンツ                    │
│               │                                     │
└───────────────┴─────────────────────────────────────┘
```

**赤バナー (なりすまし中の表示)**: 提供しない (#1124)。なりすまし (impersonate) 自体を提供しないため、画面上部の赤バナーは作らない。

**環境バッジ**: 本番=赤 `PROD`、Staging=黄 `STAGING`、Preview=青 `PREVIEW` を常時表示 (Stripe テスト/本番切替の誤操作防止)

### 3.2 サイドバー (ロール別)

| メニュー項目 | 表示ロール |
|------------|----------|
| ダッシュボード | admin, super_admin, support, finance, sales |
| ユーザー管理 | admin, super_admin, support |
| 組織管理 | admin, super_admin |
| モデレーション | admin, super_admin, content_moderator |
| サポートチケット | admin, super_admin, support |
| 開示等の請求 (`/admin/data-requests`。個人情報の請求。cross/15 §9.2) | admin, super_admin |
| 売上・経理 | admin, super_admin, finance |
| クーポン | admin, super_admin, sales |
| 営業 CRM | admin, super_admin, sales |
| 通知配信 | admin, super_admin |
| 不正検知 | admin, super_admin |
| 監査ログ | super_admin |
| お知らせ | admin, super_admin |
| super_admin 専用 ▼ | super_admin |
| └ プラン管理 | super_admin |
| └ 機能パッケージ | super_admin |
| └ 機能フラグ | super_admin |
| └ A/B テスト | super_admin |
| └ Stripe 設定 | super_admin |
| └ Cron ジョブ | super_admin |
| └ データエクスポート | super_admin |
| └ インフラ監視 | super_admin |
| └ メール送信 (`/super-admin/email-outbox`。送信待ち・届けられなかったメールの一覧と再送。`10-logs-and-mail-retry.md` §9.2。#1708) | super_admin |
| └ 管理者管理 | super_admin |
| └ DB 管理 | super_admin |
| └ LLM 使用量 | super_admin |
| └ システム設定 | super_admin |
| └ バックアップ・DR (`/super-admin/backups`。取得の状態と DR 訓練の記録。`cross/17-backup-automation.md` §7.4。#1129・#1191) | super_admin |

`/admin/moderation` と `/admin/moderation/{type}/{id}` の画面の仕様は、本書に節が無い。隠したコンテンツを戻す欄 (「非表示の解除」のカード) と一覧の「非表示中」のバッジは `operator/13-hidden-content-restore.md` §9 が正本。

---

## 4. `/admin` — 管理者ダッシュボード

**対象ロール**: admin, super_admin

### コンポーネント

**KPI カード群**:
- 全ユーザー数 / 今日のアクティブユーザー (前日比 %)
- 今月の MRR (前月比 %)
- 未対応チケット数 (赤バッジ)
- 今日の食事記録数
- LLM コスト今月 (予算比 %)

**グラフセクション**:
- 月次 DAU/WAU/MAU 推移 (折れ線)
- プラン別ユーザー数 (ドーナツ)

**直近アクティビティ**:
- `admin_audit_logs` 最新 10 件 (アクション / 操作者 / 時刻)

**クイックアクション**:
- 「ユーザー検索」
- 「チケット確認」
- 「緊急通知送信」

---

## 5. `/admin/users` — ユーザー一覧

### コンポーネント

**検索バー**: 全文検索 (email/name/id)

**フィルタパネル**:
- プラン (チェックボックス)
- ロール (チェックボックス)
- ステータス (active / banned / deleted)
- 登録日範囲
- 最終ログイン

**テーブル**:

| カラム | 表示内容 |
|------|--------|
| ユーザー | アバター + 名前 + email |
| プラン | バッジ (plan_key) |
| ロール | バッジ一覧 |
| ステータス | active / banned (赤) |
| 最終ログイン | 相対時刻 |
| 食事記録数 | 数値 |
| アクション | 詳細ボタン |

**バルク操作** (チェックボックス選択時):
- CSV ダウンロード
- 一括 BAN (super_admin のみ)

---

## 6. `/admin/users/{id}` — ユーザー詳細

### レイアウト

```
[基本情報セクション]
  名前 / email / 登録日 / 最終ログイン / プラン / ロール
  [BAN ボタン] [ロール変更ボタン]

[タブ]
  食事記録 | AI 利用 | 健康データ | チケット | 監査ログ | 管理ノート
```

**impersonate ボタン**: 提供しない (#1124)。以前は super_admin にだけ、押せない状態で表示していた。サポート (support) は、本人として操作せず、読み取り専用のユーザー画面 (この画面と `/support/users`) で対応する。

**凍結 (BAN) の画面** (モーダルでなく専用のページ `/admin/users/[id]/freeze`。`src/components/admin/UserFreezeForm.tsx`。凍結中なら解除のフォーム (理由を入力して `DELETE`)):
- 理由カテゴリ (ドロップダウン)
- 詳細テキストエリア
- BAN 種別 (一時 / 永久。永久は super_admin だけが選べる)
- 期間は日数の数値入力 (一時 BAN の場合。1〜365)
- 「利用者に凍結をメールで知らせる (アカウントの登録メールアドレス宛)」のチェック (既定 on。API の `notify_user`) と、on のときだけ出る「利用者へのメッセージ (任意・1000 文字まで)」の欄 (API の `notification_message`。メールの「▼ 運営からのメッセージ」の段に入る)。成功の文に通知の結果 (送信待ちに登録した / 送っていない / 未送信と理由) を添える (cross/24 §6.4)
- [凍結する] ボタン (パスワードの再認証は無い)

**管理ノートタブ**:
- 時系列ノート一覧
- 追加フォーム (Markdown エディタ)

**ログイン履歴 (直近 20 回)** (#1720 段 D。cross/16 §17):
- 出す条件: 実行者が admin / super_admin のとき (`GET /api/admin/users/{id}/login-history` を呼ぶ。support には節を出さず、API も呼ばない)
- 列見出しは左から「日時」「端末」「IP」「国」「印」「通知メールを送信待ちに登録した日時」「終了」の 7 つ。日時は日本時間。端末は `device_label` に、端末名があれば「(端末名: …)」を添える。印は「新しい端末」「新しい接続元」「新しい地域」(無ければ「-」)。送信待ちに登録した日時が無い行は「なし」。終了は理由と日時 (ログイン中は「-」)
- 0 件は「記録なし」。読み込めない (403 / 500 / 通信の失敗) ときは節の中に「ログイン履歴を読み込めませんでした」だけを出し、ページの他の節は描く

**二段階認証を解除** (段 C #1707。`src/components/admin/OperatorMfaResetSection.tsx`。cross/12 §15・§15.3):
- 出す条件: 実行者が super_admin で、対象が二段階認証の必須ロール (super_admin / admin / finance / org_industrial_doctor) のどれかを持つとき
- 理由 (必須・500 文字まで)・本人確認の方法 (選択)・「本人確認を行った」のチェックがそろうまで [解除する] を押せない
- 押すと確認ダイアログ → `POST /api/super-admin/admins/{id}/mfa/reset` → 消した数 (認証アプリ・バックアップコード) か、失敗の文を出す。対象はすべての端末でログアウトされる

**手動のプラン付与** (`src/components/admin/ManualPlanGrantSection.tsx`。billing/02 §10): 出す条件 = 実行者が super_admin で対象が自分でない。契約なし → プラン・有効期限 (任意)・理由 → 確認ダイアログ → `POST /api/super-admin/users/{id}/manual-plan`。手動付与の契約あり → 理由 → 確認 → `DELETE`。Stripe の契約あり → 案内だけ。履歴 (付与 / 取り消し / 期限切れ) を直近 10 件

---

## 7. `/admin/organizations` — 組織一覧

**テーブル**:

| カラム | 内容 |
|------|------|
| 組織名 | ロゴ + 名前 |
| プラン | badge + 変更 (選び直して「変更」で PATCH /api/admin/organizations/{id}。組織の段階は運営だけが変える #1912。組織の管理者の /org/settings は表示だけ。409 CONFLICT_STALE_DATA (別の運営が先に変えた)・404 NOT_FOUND (組織がもう無い) で断られたときは、行の表示が古いので今の条件 (検索・ページ) のまま一覧を読み直し、理由の文を一覧の上に出す。変更できたときは変更の通知を一覧の上に出す (行だけを返ってきた値に置き換え、一覧は取り直さない)。次の変更を始めたら一覧の上の結果の表示 (変更の通知と読み直しの文) は消す。別の一覧へ移る操作 (検索・ページ送り・組織の作成の開始) でも消す (前の一覧の行についての文を残さない)。同じ一覧を取り直すだけの「再読み込み」・読み直しでは消さない。読み込んだ一覧が 0 行で、今のページが件数から出した最後のページより後ろのとき (最後のページの唯一の行が消えたあとの読み直しなど。読み直しに限らず、どの読み込みでも。`src/app/admin/organizations/OrganizationsManager.tsx` の一覧を読む処理) は、空のページを出さずに同じ条件で最後のページを取り直す。それ以外の失敗 (500・400・code の無い 404 など) は行の欄にエラーの文を出し、一覧は読み直さない。変更の応答を待つ間に別の一覧へ移った (検索・ページ送り・組織の作成の成功) ら、遅れて届いた結果 (成功・409・404) の文は出さず、新しい一覧も触らない (変更を始めたときの一覧の世代と比べる。#1917)。409・404 のあとの理由の文は一覧の読み直しの状態に合わせ、読み直しの最中は読み込み直している旨、失敗しているあいだは読み込み直せなかった旨 (「再読み込み」を促す) にし、読めたら読み込み直した旨にする (#1917)。`src/app/admin/organizations/OrganizationsManager.tsx`) |
| Seat 数 | 使用中/上限 |
| 期限 | 日付 + 残日数 |
| 売上/月 | JPY |
| 担当営業 | 名前 |
| アクション | 詳細 / 課金詳細 |

---

## 8. `/admin/organizations/{orgId}/billing` — 組織課金詳細

### セクション

**Stripe 連携情報**:
- Stripe Customer ID → 「🔗 Stripe で開く ↗」ボタン
- ライセンスプール一覧
  - 各プールの Stripe Subscription → 「🔗 Stripe Subscription で開く ↗」
- Invoice 履歴 → 各行に「🔗 Stripe Invoice で開く ↗」

**担当メモ**: 営業/経理コメントフィールド

**操作ボタン**:
- 請求書一括ダウンロード (Stripe API 経由 PDF)
- ライセンス強制終了 (super_admin のみ)

---

## 9. `/admin/finance/dashboard` — 売上ダッシュボード

> **現状 (2026-10, #1125・#1911)**: 元になるデータ (Stripe の Webhook の集計・収益の日次スナップショット) を作る処理が無いため、
> MRR / ARR / Churn Rate / LTV / MRR 内訳 / 契約数 (個人課金者・家族グループ・法人) のカードは出さない
> (#1911: 未完成の機能は画面に出さない。「準備中」とも出さない)。MAU は実データ (`daily_active_users`) のまま出す (見出し「ユーザー数」)。
> 以下は元データができたときの仕様。

**KPI カード**:
- 今月の MRR / 前月比
- ARR / 前月比
- 解約率 (Churn Rate)
- LTV / CAC / LTV:CAC
- 新規 MRR / 拡張 MRR / 縮小 MRR / 解約 MRR

**グラフ**:
- MRR 月次推移 (折れ線)
- プラン別内訳 (積み上げ棒)
- コホート分析ヒートマップ (登録月 × 継続月)
- アップグレードファネル

**Stripe ダッシュボードリンク**: 「↗ Stripe Dashboard で開く」(finance 頻用)

**対象ロール**: admin, super_admin, finance

---

## 10. `/admin/finance/personal` — 個人課金者一覧

**テーブル**:

| カラム | 内容 |
|------|------|
| ユーザー | email + 名前 |
| プラン | badge |
| ステータス | active / trialing / past_due |
| 開始日 | 日付 |
| 次回更新日 | 日付 |
| MRR | JPY |
| アクション | 詳細 |

---

## 11. `/admin/finance/personal/{userId}` — 個人課金詳細 ⭐

### セクション

| セクション | 内容 |
|----------|------|
| 基本情報 | nickname / email / 登録日 / 最終ログイン |
| 現在のプラン | `personal_subscriptions` 全行 (active + 履歴) |
| Stripe 直接リンク | 🔗 Stripe Customer Dashboard / Stripe Subscription |
| Invoice 履歴 | 直近 12 ヶ月 + 各行の 🔗 Stripe Invoice |
| 適用クーポン | 現在有効なもの + 履歴 |
| 操作 | 解約予約 / 即時解約 / プラン変更 / 返金 (Stripe へ誘導) |
| 監査ログ | このユーザーへの全操作履歴 |

**権限別操作制限**:
- `support`: 閲覧 + 解約予約のみ
- `finance`: 上記 + 返金誘導 (Stripe 側で実行)
- `admin` / `super_admin`: 全操作

**返金の記録 (#1185)**: 返金は Stripe ダッシュボードで行うが、その前に理由を必須で入力させ、
`admin.refund.issue` を監査ログに記録する (`07-audit-monitoring.md` §4.1.2)。記録できたときだけ Stripe を新しいタブで開く。
この画面 (個人課金詳細) の実装までは、請求書詳細 (`/admin/finance/invoices/{id}`) の「返金を記録して Stripe で開く」から行う。

---

## 12. `/admin/finance/licenses` — 組織ライセンス販売管理

**アラートバー**: 30 日以内に期限切れの組織数 (黄色バナー)

**テーブル**:

| カラム | 内容 |
|------|------|
| 組織名 | リンク |
| プラン | badge |
| Seat 数 | 使用/上限 |
| 有効期限 | 日付 + 残日数 (残 7 日以内は赤) |
| 月額売上 | JPY |
| 自動更新 | ON/OFF |
| ステータス | active / expiring / expired |
| アクション | 詳細 / Stripe リンク |

**グラフ**: 月別販売推移 (棒グラフ)

---

## 13. `/admin/finance/invoices` — 請求書管理

> **現状 (2026-10, #1125)**: 請求書一覧・収益推移 (`/admin/finance/revenue`)・Stripe 整合チェック (`/admin/finance/reconciliation`) は、
> 請求書・収益推移・整合チェックの元データ (集計バッチ・reconcile) は配線の冊で作るため、それまで画面は出さない: URL で開かれたら 404 にし、
> 売上・経理のクイックリンク (`src/components/operator/finance/FinanceQuickLinks.tsx`) にも並べない
> (#1911 で案内 `BillingNotStartedNotice.tsx` を部品ごと取り除いた。未完成の機能は画面に出さず、「準備中」とも出さない。
> Stripe の Webhook の受け口と契約の写しは billing/01 で入った)。以下は元データができたときの仕様。

**操作バー**: 「全組織分一括生成」ボタン (確認モーダル付き)

**テーブル**: 請求書 ID / 組織名 / 請求額 / ステータス / 発行日 / 支払期限 / アクション (PDF / 再送)

---

## 14. `/super-admin/coupons` — クーポン管理 ⭐

### クーポン一覧テーブル

| カラム | 内容 |
|------|------|
| コード | モノスペースフォント |
| 割引 | `20%` or `¥5,000 OFF` |
| 対象 | all / personal / org |
| 有効期限 | 日付 |
| 利用数 | `42 / 100` |
| ステータス | badge |
| アクション | 詳細 / 一時停止 |

**「+ 新規クーポン」モーダル**:
```
コード: [入力欄 or 自動生成]
表示名: [入力欄]
割引種別: ○ 固定額 (円)  ○ パーセント (%)
割引値: [数値入力]
適用対象: ○ 全て ○ 個人 ○ 組織
有効期限: [日付範囲ピッカー]
最大利用回数: [数値 / 無制限]
ユーザー毎の上限: [数値 (default: 1)]
割引期間: [月数 / ずっと]

[実質粗利プレビュー: ¥XXX (XX%)]

[キャンセル] [作成]
```

---

## 15. `/admin/support/tickets` — サポートチケット一覧 (拡張)

**フィルタタブ**: すべて / 未対応 / 対応中 / 解決済

**テーブル**:

| カラム | 内容 |
|------|------|
| チケット ID | #1234 |
| ユーザー | email |
| 件名 | 最大 50 文字 |
| カテゴリ | badge |
| 優先度 | badge (urgent は赤) |
| ステータス | badge |
| 担当者 | アバター |
| SLA | 残時間 (超過は赤) |
| 作成日 | 相対時刻 |

---

## 16. `/admin/support/tickets/{id}` — チケット詳細 (新規)

### レイアウト

```
[左カラム: ユーザー情報パネル]
  名前 / email / プラン / 登録日
  [ユーザー詳細を見る]リンク

[右カラム: メインエリア]
  ┌──────────────────────────────┐
  │ チケットヘッダー              │
  │ 件名 / カテゴリ / 優先度 / SLA │
  │ 担当者割当 [ドロップダウン]   │
  ├──────────────────────────────┤
  │ メッセージスレッド           │
  │  [ユーザー] 09:00            │
  │  「ログインできません...」   │
  │  [サポート] 10:30            │
  │  「パスワードリセットを...」  │
  ├──────────────────────────────┤
  │ 返信フォーム                 │
  │  [外部返信 / 内部メモ タブ]  │
  │  テキストエリア              │
  │  テンプレート選択 ▼         │
  │  [送信ボタン]               │
  └──────────────────────────────┘
```

**内部メモ**: 背景色が薄黄色で視覚的区別

---

## 17. `/admin/sales/leads` — 営業 CRM ⭐

**カンバンビュー** (ステージ別カラム):

```
[アプローチ]  [商談中]  [提案]  [交渉]  [契約済]  [失注]
  3 件          5 件     2 件    1 件    12 件     4 件
  ...カード...
```

**カード表示**: 会社名 / 担当者 / 推定 ACV / 最終活動日

**「+ 新規リード」ボタン**: サイドパネルで入力

---

## 18. `/admin/notifications` — 通知配信管理

**タブ**:
- キャンペーン一覧
- テンプレート
- 配信履歴

**キャンペーン新規作成ウィザード**:

```
Step 1: ターゲット設定
  [全ユーザー / フィルタ / CSV アップロード]
  フィルタ: プラン / 登録月 / 最終ログイン / 食事記録なし期間

Step 2: メッセージ作成
  チャネル: [Push / Email / アプリ内]
  バリアント: A / B (A/B テスト有効化)
  タイトル: [入力]
  本文: [リッチエディタ]
  ディープリンク: [入力]

Step 3: スケジュール
  [即時] or [予約: 日時ピッカー]
  [プレビュー] → [配信確定]
```

---

## 19. `/admin/abuse` — 不正検知キュー (admin)

**検知一覧テーブル**: ユーザー / ルール / 検知日時 / 自動アクション / レビューステータス

**手動レビュー**: 確認 / false_positive / エスカレーション

---

## 20. `/admin/audit-logs` — 監査ログ閲覧 (拡張)

**フィルタ**:
- アクション種別 (マルチセレクト)
- 操作者
- 対象
- 重要度 (info / warn / critical)
- 期間

**テーブル**:

| カラム | 内容 |
|------|------|
| 日時 | 絶対時刻 |
| 操作者 | email + role |
| アクション | タグ (例: `admin.user.ban`) |
| 対象 | email or ID |
| 重要度 | badge |
| 詳細 | 展開 → JSON |

**CSV エクスポート**: 法務対応用

**権限**: `super_admin` のみ

---

## 21. `/admin/announcements` — お知らせ管理

テーブル + 作成モーダル (タイトル / 本文 / 表示期間 / 対象プラン)

---

## 22. `/super-admin` — super_admin ダッシュボード

**KPI カード**:
- 全 KPI + システム健全性スコア
- LLM コストアラート (前日比 +30% 以上で赤)
- 過去 24 時間の重要イベント (severity='critical' の監査ログ)

**インフラステータスパネル**:
- Vercel: エラー率 + p95 レイテンシ
- Supabase DB: クエリ時間 + 接続数
- LLM APIs: 各モデルの応答時間

**バックアップ・DR**: サイドバーの「バックアップ・DR」(`/super-admin/backups`。`cross/17-backup-automation.md` §7.4) から開く。取得の状態と DR 訓練の記録の画面はここ 1 か所

---

## 23. `/super-admin/plans` — プラン定義・販売管理 ⭐

### プラン一覧

**テーブル**:

| カラム | 内容 |
|------|------|
| plan_key | モノスペース |
| 表示名 | テキスト |
| 種別 | badge (personal / family / org) |
| 月額 | ¥XXX |
| 年額 | ¥XXX |
| パッケージ数 | 数値 |
| ステータス | badge (draft/public/private/deprecated) |
| 表示順 | ドラッグ変更可 |
| アクション | 編集 / 公開 / 廃止 |

**フィルタ**: 種別 / ステータス

**「+ 新規プラン作成」ボタン**

---

## 24. `/super-admin/plans/{id}` — プラン編集 ⭐

### タブ構成

**基本情報タブ**:
- plan_key (公開後は変更不可)
- 表示名 / 説明 (Markdown エディタ)
- 種別 / 上限値 (メンバー数)
- バナー画像アップロード
- 試用期間 / 最低契約期間

**価格設定タブ**:
- 月額 / 年額 (JPY)
- Stripe Product ID / Price ID (masked)
- 「価格変更」ボタン → モーダル

**価格変更モーダル**:
```
新しい月額: [¥入力]
新しい年額: [¥入力]
適用範囲:
  ○ 新規契約のみ
  ○ 次回更新時 (既存契約は次の請求サイクルから)
  ○ 即時 (proration あり)
理由: [テキストエリア]
有効日: [日付ピッカー]

[影響シミュレーション]
  影響契約数: 3,420 件
  月次収益変化: +¥680,000
  [影響ユーザーリスト (最大 20 件)]

[キャンセル] [価格変更を実行]
```

**機能パッケージタブ**:
- マトリクス UI: パッケージ × プランのチェックボックス
- ワンクリックで機能追加/削除

**ステータスタブ**:
- 現在のステータス表示
- ライフサイクル遷移ボタン
  - [公開する] (draft → public)
  - [非公開にする] (public → private)
  - [廃止する] (→ deprecated、移行先プラン指定必須)
  - [廃止をロールバック] (deprecated → private, super_admin 限定)

**価格変更履歴タブ**:
- 変更日 / 旧価格 → 新価格 / 適用範囲 / 変更者

---

## 25. `/super-admin/feature-packages` — 機能パッケージ管理 ⭐

### パッケージ一覧

**テーブル**: package_key / 表示名 / feature flags 数 / 利用プラン数

**編集モーダル**:
- パッケージ名 / 説明
- 含める feature flag チェックボックス (全フラグ一覧から選択)

**マトリクスビュー タブ**: プラン × パッケージの俯瞰 (read-only)

---

## 26. `/super-admin/integrations/stripe` — Stripe 設定 ⭐

**テスト/本番モードバナー**: 現在のモードを画面上部に常時表示
- テストモード: 黄色バナー「⚠ Stripe テストモード」
- 本番モード: 緑バナー「✓ Stripe 本番モード」

**設定フォーム** (Publishable Key は持たない: Checkout と Billing Portal はサーバーが作った Stripe のページの URL へ移るだけで、公開鍵を使わない。billing/01):
- Secret Key (masked、変更時は再入力)
- Webhook Signing Secret (masked)
- Webhook Endpoint: `https://homegohan.app/api/webhooks/stripe` (read-only)
- Stripe API バージョン (表示のみ + 更新通知)

**Stripe Dashboard リンク**: 「↗ Stripe Dashboard を開く」

---

## 27. `/super-admin/cron-jobs` — Cron ジョブ管理

### テーブル

| カラム | 内容 |
|------|------|
| ジョブ名 | テキスト |
| 種別 | pg_cron / Vercel Cron |
| スケジュール | cron 式 + 人間語 |
| 最終実行 | 日時 + 結果 (success/failed) |
| 次回実行 | 日時 |
| 操作 | [今すぐ実行] / [一時停止] |

**今すぐ実行 モーダル**: 「ジョブ名 を手動実行しますか？」+ [実行確定]

**実行ログ**: 直近 10 回のログ (成功/失敗/実行時間)

---

## 28. `/super-admin/exports` — データエクスポート

> **現状 (2026-10, #1126・#1911)**: 使えない (未対応)。ファイルを作る処理が無いため、画面 (一覧と `/new`) は出さない:
> サイドバーに並べず、URL で開かれたら 404 にする (#1911: 未完成の機能は画面に出さない。「準備中」とも出さない)。
> 以下のフォームと一覧は、作るときの仕様。API は 501 `OP_NOT_SUPPORTED`。

**エクスポートリクエストフォーム**:
- エクスポート種別 (ユーザーデータ / 監査ログ / 食事記録 / 組織データ)
- 形式 (CSV / JSON / Parquet)
- フィルタ (期間 / プラン / etc.)
- PII マスキング (ON/OFF、デフォルト ON)

**エクスポート一覧テーブル**: ID / 種別 / ステータス / 作成日時 / ダウンロード

---

## 29. `/super-admin/abuse` — 不正検知ルール管理

**ルール一覧**: ルール名 / 種別 / しきい値 / アクション / 有効/無効

**ルール作成フォーム**: GUI でルール条件を設定 (コードレス)

---

## 30. `/super-admin/experiments` — A/B テスト管理

### 実験一覧

**テーブル**: 実験名 / ステータス / 期間 / バリアント数 / 主要メトリクス / 操作

**実験詳細画面**:
- 仮説 / バリアント設定
- 統計分析パネル: p 値 / 信頼区間 / サブグループ別
- 採用/却下ボタン

---

## 31. `/super-admin/admins` — 管理者管理

**テーブル**: email / ロール一覧 / 最終ログイン / 2FA 状態 (未実装。cross/12 §0.3 の範囲外・§27 Q-10) / 操作

**ロール変更フロー**:
1. [ロール変更] → モーダル
2. チェックボックスでロール選択
3. パスワードの再認証はしない (operator/02 の `PATCH / PUT /api/admin/users/{id}/role` と同じ。`reauth_token` は受け取るが検証しない)
4. [確定] → 監査ログ + 対象者メール通知

---

## 32. `/super-admin/database` — DB 管理

**テーブル**: テーブル名 / 行数 / サイズ / 最終更新 / インデックス数

**スロークエリ**: `pg_stat_statements` 上位 20 件

**バックアップ状態**: この画面では出さず、`/super-admin/backups` (`cross/17-backup-automation.md` §7.4) へのリンクを置く (取得・訓練の記録の正は `admin_audit_logs` の `backup.*` / `dr.test.*` で、状態を出す画面は 1 か所)

---

## 33. `/super-admin/llm` — LLM 使用量 (強化)

> **現状 (2026-10, #1524)**: 画面のパスは `/super-admin/llm` (プロバイダー別の内訳は `/super-admin/llm/[provider]`)。
> データは `GET /api/super-admin/llm/usage` から読む (`/super-admin/llm-usage` という画面は無い)。

**期間選択**: 今日 / 7 日 / 30 日 / カスタム

**ダッシュボード**:
- 総コスト カード (USD + JPY、前期比)
- モデル別内訳 グラフ (ドーナツ)
- 機能別内訳 グラフ (棒グラフ)
- ユーザー別 Top 50 テーブル (異常検知用、赤ハイライト)
- 時系列推移 (時間/日別)

**異常アラート**: 1 ユーザー 5,000 req/日超 → バナー表示

**クォータ設定ボタン**: ユーザー個別クォータ変更モーダル

> **現状 (2026-10, #1149)**: 「AI の利用上限」へのリンクを出し、`/super-admin/llm/quotas` でプランごとの 1 日の上限
> (全機能の合計・日本時間の 0 時に戻る。空欄は無制限) を一覧し、行ごとに保存する (`GET` / `PATCH /api/super-admin/llm/quotas`)。
> 保存した値は次の AI の利用から効く。利用者ごとの上限 (モーダル) は無い。
> 組織のプランの値 (`standard` / `premium` / `enterprise`) の行は「<値>（組織のプラン）」と出て保存できる。プランの表にも組織のプランにも無いキーの行は、入力欄と保存のボタンを止める (#1912)。
> `subscription_plans` の組織のプランの行 (`org_*`。`plan_type = 'org'`) は読み取りだけ: いまの上限は出すが、入力欄と保存のボタンを止め、
> 「組織の上限は組織のプランの値 (standard / premium / enterprise) の行で決まります」の案内 (#1917 の続きで英字の値を括弧に入れた)を行に出す (文は `src/lib/super-admin/ai-daily-limits.ts` の `AI_DAILY_LIMIT_READ_ONLY_NOTES`。PATCH も 409 `PLAN_READ_ONLY` で断る。#1912)。保存が 409 `CONFLICT_STALE_DATA` (別の運営が先に同じプランの上限を変えた) で断られたら、一覧を読み直していまの上限を出し、行に読み込み直した旨の文を出す。書きかけの行 (新しい上限・理由) は残し、書きかけの無い行は読み直した値にする (#1917。判定は `src/lib/admin/api-error-message.ts` の `isStaleDataConflict`。`PLAN_READ_ONLY` では読み直さない)。表を出したあとの読み直しは表を外さずに行い (入力欄のフォーカスも外さない)、失敗しても表と書きかけを残して、表の上に文と「再試行」を出す。409 のあとの読み直しに失敗したら行の文も読み込み直せなかった旨にし、どの経路の読み直し (「再試行」・ほかの行の保存のあとの読み直し) でも読み直せたら読み込み直した旨に変える。その行 (入力した値と理由を残すと伝えている行) の書きかけは、ほかの行の保存のあとの読み直しでも消さない (#1917)。

---

## 34. `/super-admin/settings` — システム設定

- お知らせバナー設定
- 全ユーザーへの緊急メッセージ送信
- LLM プロバイダー優先度

> **現状 (2026-10, #1457 / #1486)**: メンテナンスモードと機能フラグは、この画面ではなく `/super-admin/flags` (§7 の機能フラグ API) で切り替える
> (メンテナンスモードは `maintenance_mode`、AI 相談の緊急停止は `ai_chat_enabled`)。`system_settings` の `feature_flags` 行は
> もう何も読まず、システム設定では読み取り専用 (「使われていない」と出し、保存させない)。
> Web にこの画面 (`src/app/super-admin/settings`) は無い。`system_settings` の一覧・保存は、モバイルの運営画面の「システム設定」が
> `GET / PUT /api/super-admin/settings` で行う (各行の `key` / `value` / `description` / `updated_at` を出し、`description` も保存する)。

---

## 35. シーケンス — プラン廃止フロー

```mermaid
sequenceDiagram
  participant SA as super_admin
  participant UI as /super-admin/plans/{id}
  participant API as /api/super-admin/plans/{id}/deprecate
  participant DB as Supabase DB
  participant Email as Resend

  SA->>UI: [廃止する]ボタン
  UI->>SA: 移行先プラン選択モーダル
  SA->>UI: 移行先 + ends_at を入力
  UI->>API: POST /deprecate
  API->>DB: UPDATE subscription_plans SET status='deprecated'
  API->>DB: UPDATE org_license_pools SET auto_renew=FALSE WHERE plan_key=xxx
  API->>DB: INSERT admin_audit_logs (severity=critical)
  API->>Email: 90日前通知ジョブをキュー
  API-->>UI: 200 OK
  UI->>SA: 「廃止処理を開始しました」トースト
```

## 36. エラーハンドリング

| シナリオ | UI の対応 |
|---------|---------|
| 権限不足 (403) | トーストで「権限がありません」表示、操作ボタンは disabled (ブラウザで API を呼ぶ画面は、応答の本文の文が二段階認証の確認・登録が要る・凍結の文なら、「権限がありません」などの固定の文の代わりにその文を出す。`forbiddenMessageForScreen`。サーバーで描く画面・失敗を出さないところ・本文の `code` だけから文を引く節は対象の外 (cross/04 §5.2 の認可の失敗の段)。#1917) |
| BAN 操作の再認証 | 無い (凍結の画面にパスワードの確認は無い) |
| プラン廃止で移行先未指定 | バリデーションエラー「移行先プランを選択してください」 |
| Stripe 連携失敗 | 「Stripe との同期に失敗しました。管理者に連絡してください」|
| 監査ログ取得エラー | 「閲覧は super_admin のみ可能です」|

## 37. テスト方針

- **a11y**: `@axe-core/playwright` で全ページ violations = 0
- **Keyboard**: Tab キーで全インタラクティブ要素にフォーカス到達
- **E2E**:
  - `op/01-user-search.spec.ts`
  - `op/03-moderation-resolve.spec.ts`
  - `op/07-mrr-dashboard.spec.ts`
  - `op/plan-deprecate.spec.ts`

## 38. 既存実装との関連

- `src/app/(admin)/` および `src/app/(super-admin)/` は commit `32d13e1` で全削除済み → PR #816-#824 で `src/app/admin/` / `src/app/super-admin/` (実 segment) として新規実装済み (PR #821 で route group から実 segment にリネーム)
- 既存の UI パーツ (`components/ui/*`) は活用する

## 39. 未解決事項

- `/super-admin/database` の直接 SQL 実行機能 (将来要件) は Phase 3 以降で検討
- `/admin/sales/leads` のカンバン vs テーブルビューはユーザビリティテスト後に決定
- モバイル対応: 管理コンソールは desktop-first で設計、モバイルは responsive 対応のみ (テーブルはスクロール)
