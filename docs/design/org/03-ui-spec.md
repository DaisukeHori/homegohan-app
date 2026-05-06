# org/ UI 仕様

## 1. 目的・スコープ

組織管理ドメインの全画面仕様を定義する。対象:
- `org_admin` / `org_manager` 向け管理画面
- `org_industrial_doctor` 向け産業医画面
- `org_member` / `org_viewer` 向け一般メンバー画面
- 招待受諾画面 (`/invite/org/{token}`)

## 2. 関連要件

- 要件定義 02 §9 (UI 画面仕様)
- 100-scenarios.md D (組織 admin 15 件), E (組織 member/産業医 10 件)

## 3. ルーティング概要

```
(org)/
├── org/                    ダッシュボード
├── org/members/            メンバー一覧
│   └── [id]/               メンバー詳細
├── org/departments/        部署管理
│   └── [id]/               部署詳細
├── org/invites/            招待管理
│   └── bulk/               一括招待
├── org/licenses/           ライセンス管理
│   ├── purchase/           購入フロー
│   └── usage-report/       利用状況レポート
├── org/family-addon/       家族同梱管理
├── org/challenges/         チャレンジ一覧
│   └── [id]/               チャレンジ詳細
├── org/health/             産業医画面
│   └── [userId]/           患者個別
├── org/billing/            課金・契約
└── org/settings/           組織設定

invite/
└── org/[token]/            招待受諾 (認証不要)
```

## 4. `/org` — ダッシュボード

### 4.1 画面概要

- **アクセス**: `org_admin`, `org_manager`, `org_viewer`
- **初回読み込み目標**: < 1.5s (キャッシュ 5 分)

### 4.2 コンポーネント構成

```
OrgDashboardPage
├── DashboardHeader (組織名、期間セレクタ 7d/30d/90d/1y)
├── KpiCards (grid 2x3)
│   ├── ParticipationRateCard (参加率)
│   ├── AvgHealthScoreCard (平均健康スコア)
│   ├── BreakfastRateCard (朝食率)
│   ├── HomecookRateCard (自炊率)
│   ├── ChallengeAchievementCard (チャレンジ達成率)
│   └── ActiveMemberCard (アクティブメンバー数)
├── TrendChart (折れ線グラフ、3 ヶ月分)
├── DepartmentHeatmap (部署別スコア、赤=低/緑=高)
├── AlertBanner (スコア急低下部署のアラート)
├── RecentActivities (新規参加、達成等)
└── MonthlyReportButton → POST /api/org/reports/monthly
```

### 4.3 状態管理

- Server Component でデータ取得 (RSC + Suspense)
- KPI は Upstash Redis にキャッシュ (TTL 5 分)
- 期間変更は URL パラメータ (`?period=30d`) でステートレスに管理

---

## 5. `/org/members` — メンバー一覧

### 5.1 画面概要

- **アクセス**: `org_admin`, `org_manager`, `org_viewer` (viewer は閲覧のみ)

### 5.2 コンポーネント構成

```
OrgMembersPage
├── MemberSearchBar (名前/Email/社員番号)
├── FilterPanel
│   ├── DepartmentFilter
│   ├── RoleFilter
│   ├── StatusFilter (在籍中/退職済)
│   └── LicenseFilter (割当済/未割当)
├── BulkActionBar (選択時表示: ライセンス割当/回収/部署変更/除名)
├── MemberTable
│   └── MemberRow
│       ├── Avatar, 名前, Email, 社員番号
│       ├── DepartmentBadge
│       ├── RoleBadge
│       ├── HealthScoreBar (集計のみ、個別データ不可)
│       ├── LicenseStatusIcon
│       └── ActionMenu (編集/ロール変更/除名)
├── Pagination
└── ActionButtons
    ├── InviteMemberButton → /org/invites
    └── CsvImportButton → bulk-import API
```

### 5.3 メンバー除名モーダル

```
RemoveMemberModal
├── 確認メッセージ「{name} を組織から除名します」
├── DataPolicySelect
│   ├── keep_personal (デフォルト): 個人アカウントとして残す
│   └── delete_account: アカウントごと削除
├── NotifyUserCheckbox
└── ConfirmButton (危険操作: 赤ボタン)
```

---

## 6. `/org/members/{id}` — メンバー詳細

### 6.1 コンポーネント構成

```
MemberDetailPage
├── MemberProfileCard (Avatar, 基本情報, ロール)
├── OrgInfoCard (部署, 入社日, 在籍状況, ライセンス情報)
├── HealthScoreTrend (集計グラフ、産業医のみ個別データ)
├── DepartmentHistoryTimeline (Pro 以上)
├── ActivityLog (招待受諾, 最終ログイン, チャレンジ参加)
└── ActionPanel
    ├── EditButton (org_admin/org_manager)
    ├── RoleChangeButton (org_admin のみ)
    ├── DepartmentChangeSelect
    └── RemoveMemberButton
```

---

## 7. `/org/departments` — 部署管理

### 7.1 画面概要

- **アクセス**: `org_admin`, `org_manager`

### 7.2 コンポーネント構成

```
DepartmentManagementPage (2 ペインレイアウト)
├── LeftPane: DepartmentTree
│   ├── TreeNode (expand/collapse)
│   ├── DragHandle (並び替え)
│   └── AddDepartmentButton
└── RightPane: DepartmentDetail (選択部署)
    ├── DepartmentNameEdit
    ├── ManagerSelect
    ├── MemberList (部署メンバー)
    ├── SubDepartmentList
    ├── MoveMembersButton → move-members API
    └── DeleteDepartmentButton (メンバーなし時のみ活性)
```

### 7.3 部署追加モーダル

```
AddDepartmentModal
├── NameInput (1-100 文字)
├── ParentDeptSelect (最大 3 階層チェック)
├── ManagerSelect
└── DisplayOrderInput
```

---

## 8. `/org/invites` — 招待管理

### 8.1 コンポーネント構成

```
InvitesPage
├── TabBar (Pending / Accepted / Expired / Cancelled)
├── InviteTable
│   └── InviteRow
│       ├── Email, ロール, 部署, 期限, 状態
│       └── ActionMenu (リンクコピー/再送/取消)
└── ActionButtons
    ├── InviteButton → InviteModal
    └── BulkInviteButton → /org/invites/bulk
```

### 8.2 個別招待モーダル

```
InviteModal
├── EmailInput (RFC 5322 バリデーション)
├── RoleSelect (org_admin/manager/member/viewer/industrial_doctor)
├── DepartmentSelect (任意)
├── NicknameInput (任意)
├── EmployeeIdInput (任意)
└── CustomMessageTextarea (任意、招待メールに含まれる)
```

---

## 9. `/org/invites/bulk` — 一括招待

### 9.1 コンポーネント構成

```
BulkInvitePage
├── StepIndicator (1: CSV選択 → 2: プレビュー → 3: 送信 → 4: 完了)
├── Step1: CsvUploadZone
│   ├── CSV フォーマット説明
│   └── DragDropArea or FileInput
├── Step2: ImportPreview
│   ├── 件数 / エラー件数サマリ
│   ├── ErrorList (エラー行詳細)
│   └── ValidRowsTable (プレビュー上位 10 件)
├── Step3: ProgressBar (リアルタイム: "85/100 件完了")
└── Step4: Result
    ├── 成功 / 失敗件数
    └── ErrorCsvDownloadButton
```

---

## 10. `/invite/org/{token}` — 招待受諾画面 (最重要)

### 10.1 画面概要

- **アクセス**: 認証不要 (招待リンクを踏んだユーザー)
- **優先度**: Phase 1 最重要 (現状未実装)

### 10.2 コンポーネント構成

```
OrgInviteAcceptPage
├── OrgLogoHeader (組織ロゴ + 組織名)
├── InviteInfoCard
│   ├── 「{inviter_name} さんから招待されました」
│   ├── ロール表示 (バッジ)
│   ├── 部署表示 (あれば)
│   └── 期限表示 (残り N 日)
├── AuthSection
│   ├── ログイン済: ConfirmJoinButton
│   └── 未ログイン:
│       ├── LoginButton → 認証後にリダイレクトバック
│       └── SignupButton → Email を自動入力 (変更不可)
├── TosNotice (利用規約)
└── ExpiredBanner (期限切れ時)
```

### 10.3 フロー

```mermaid
flowchart TD
  A[/invite/org/{token} アクセス] --> B{トークン有効?}
  B -- 無効/期限切れ --> C[期限切れ画面]
  B -- 有効 --> D{ログイン済?}
  D -- NO --> E[ログイン / 新規登録]
  E --> D
  D -- YES --> F[招待情報表示]
  F --> G[「参加する」クリック]
  G --> H[POST /api/org/invites/{token}/accept]
  H --> I[/org/dashboard へリダイレクト]
```

---

## 11. `/org/licenses` — ライセンス管理

### 11.1 画面概要

- **アクセス**: `org_admin` (編集), `org_manager`, `org_viewer` (閲覧)

### 11.2 コンポーネント構成

```
LicenseManagementPage
├── LicensePoolCards (保有プール一覧)
│   └── PoolCard
│       ├── プラン名バッジ (org_pro etc.)
│       ├── 使用数 / 総数 (プログレスバー)
│       ├── 空き数 (残量少ない時は赤表示)
│       ├── 期限 / 自動更新ステータス
│       └── FamilyAddonBadge (同梱あり時)
├── AlertBanner (空き < 10 で警告)
├── AddLicenseButton → /org/licenses/purchase
├── AssignmentSection
│   ├── AssignedMemberTable
│   │   └── AssignmentRow (名前/プラン/割当日/状態/操作)
│   ├── UnassignedAlert (未割当メンバー数)
│   ├── AutoAssignButton
│   └── BulkAssignButton
└── FooterActions
    ├── UsageReportButton → /org/licenses/usage-report
    └── AuditLogButton
```

---

## 12. `/org/licenses/purchase` — ライセンス購入

### 12.1 コンポーネント構成

```
LicensePurchasePage (5 ステップウィザード)
├── Step1: PlanSelect (Org Standard / Pro / Enterprise)
├── Step2: QuantityInput (数量入力 + 単価計算)
├── Step3: FamilyAddonOption
│   ├── 同梱有無トグル
│   └── 家族人数選択 (4 / 8 / 12)
├── Step4: BillingCycleSelect (月額 / 年額 10% 割引)
├── Step5: ConfirmAndPay
│   ├── 料金サマリ (月額 × 数量 = 合計)
│   ├── 年間見積もり
│   └── Stripe Checkout ボタン
└── CompleteStep (Stripe 決済完了後)
```

---

## 13. `/org/licenses/usage-report` — 利用状況レポート

### 13.1 コンポーネント構成

```
UsageReportPage
├── DateRangePicker
├── LicenseUtilizationChart (月別使用率折れ線)
├── RoiMetrics (Pro 以上)
│   ├── コストパーアクティブユーザー
│   └── 健康スコア改善効果 (before/after)
├── InactiveUsersTable (90 日無ログイン候補)
│   ├── 各ユーザーの最終ログイン
│   └── AutoRevokeButton / ManualRevokeButton
└── ExportButtons (CSV / PDF)
```

---

## 14. `/org/family-addon` — 家族同梱管理

### 14.1 コンポーネント構成

```
FamilyAddonPage
├── FamilyAddonStatusCard
│   ├── 同梱有無 / 家族シート数
│   └── EnableFamilyAddonButton (未設定時)
├── DistributionTable (各社員の家族グループ利用状況)
│   └── 匿名化集計のみ (家族の個人データは不可)
└── BulkDistributeButton → POST /api/org/family-addon/distribute
```

---

## 15. `/org/challenges` — チャレンジ一覧

### 15.1 コンポーネント構成

```
ChallengesPage
├── TabBar (進行中 / 終了済 / 下書き)
├── ChallengeCardGrid
│   └── ChallengeCard
│       ├── タイトル、期間
│       ├── 参加者数 / 達成率プログレスバー
│       └── StatusBadge
└── NewChallengeButton (org_admin/manager)
```

---

## 16. `/org/challenges/{id}` — チャレンジ詳細

### 16.1 コンポーネント構成

```
ChallengeDetailPage
├── ChallengeHeader (タイトル / 期間 / ステータス)
├── ProgressChart (日次/週次達成率)
├── ParticipantList
│   └── 達成者バッジ / 未達者リスト
├── RewardText
└── ActionButtons (org_admin/manager)
    ├── PublishButton (draft → active)
    ├── CompleteButton (active → completed)
    ├── CancelButton
    ├── AchieversExportButton (CSV)
    └── DuplicateButton (再開催)
```

---

## 17. `/org/health` — 産業医トップ

### 17.1 画面概要

- **アクセス**: `org_industrial_doctor` (同組織のみ)

### 17.2 コンポーネント構成

```
IndustrialDoctorPage
├── ConsentStatusSummary (同意済: N 名 / 全体: M 名)
├── PatientTable
│   └── PatientRow
│       ├── 名前 (仮名表示設定可)
│       ├── 部署
│       ├── 最終健康スコア / 異常フラグ
│       ├── 同意日
│       └── ViewButton → /org/health/{userId}
└── SearchFilter (部署 / 健康スコア範囲 / 同意日)
```

---

## 18. `/org/health/{userId}` — 患者個別

### 18.1 コンポーネント構成

```
PatientDetailPage
├── PatientProfileCard (名前/部署/同意日)
├── NutritionTrendChart (週次カロリー/PFC/塩分)
├── HealthScoreHistory (月次推移)
├── CheckupDataTable (最新 3 件の健診結果)
├── HealthNotesList
│   └── NoteCard (date / category / AI generated badge)
├── AddNoteButton → POST /api/org/health/patients/{userId}/notes
└── AiAdviceButton (Org Pro 以上) → ai-advice API
    ├── PeriodSelect
    ├── FocusAreaCheckboxes
    └── GenerateButton
```

### 18.2 アクセス制御 UI

- 退職者データにアクセスしようとした場合: `403 AccessDenied` バナー
- 同意撤回済: `ConsentRevokedBanner` を表示

---

## 19. `/org/billing` — 課金・契約

### 19.1 コンポーネント構成

```
BillingPage
├── CurrentPlanCard
│   ├── プラン名 / シート数
│   ├── 次回請求日 / 金額
│   └── UpgradePlanButton / CancelButton
├── PaymentMethodCard
│   └── ChangeCardButton (→ Stripe Customer Portal)
└── InvoiceList
    └── InvoiceRow (番号/金額/日付/ステータス/PDF ダウンロード)
```

---

## 20. `/org/settings` — 組織設定

### 20.1 コンポーネント構成

```
OrgSettingsPage
├── BasicInfoForm (組織名/業種/従業員数/ロゴ/連絡先)
├── AppearanceSection (カスタムカラー - Pro 以上)
├── NotificationSettings
│   ├── 月次レポート自動送信
│   └── ライセンス残量アラート閾値
├── InviteSettings
│   └── EmailDomainAllowlist
├── HrWebhookSettings (Pro 以上)
│   ├── ScimTokenDisplay (マスク表示 + Regenerate)
│   └── WebhookUrl
└── SsoSection (Enterprise - 別タブ)
    └── → docs/design/org/08-sso-saml.md 参照
```

---

## 21. 100-scenarios.md D / E ペルソナ対応マッピング

| シナリオ | 対応画面 / API |
|---------|--------------|
| D1 組織契約購入 | `/org/licenses/purchase` + Stripe Checkout |
| D2 Stripe Checkout 月額決済 | `/org/billing` + Stripe |
| D3 100 人 CSV 一括招待 | `/org/invites/bulk` |
| D4 Email バウンス検出 | `POST /api/webhooks/resend` → invite.status=failed 表示 |
| D5 ライセンス 50 人個別割当 | `/org/licenses` + BulkAssign |
| D6 家族プラン同梱 30 名配布 | `/org/family-addon` → bulk distribute |
| D7 退職 HR Webhook 自動 revoke | `POST /api/webhooks/hr` → pg_cron 自動処理 |
| D8 退職者が家族グループ owner | 退職者へ通知 → `/org` 側は凍結状態表示 |
| D9 ライセンス枯渇追加購入 | `/org/licenses` AlertBanner → `/org/licenses/purchase` |
| D10 プランダウングレード | `/org/billing` → DowngradeFlow (影響者リスト確認) |
| D11 産業医招待 | `/org/invites` → role=org_industrial_doctor |
| D12 部署マスター登録 + 50 人配属 | `/org/departments` + move-members |
| D13 チャレンジ開催 1 ヶ月 | `/org/challenges` → 新規作成ウィザード |
| D14 月次レポート PDF | `/org/dashboard` → MonthlyReportButton |
| D15 全社員 Slack 通知 | `/org/settings` → Slack Webhook 設定 |
| E1 個人 family_group 同梱 | 自動付与 (通知のみ) |
| E2 副業 2 社所属 | `GET /api/org/me` で複数組織情報返却 |
| E3 個人 Pro + 組織 Pro 重複 | `/account/billing` に一時停止モーダル表示 |
| E4 部署別レポート確認 | `/org/dashboard` 部署フィルタ |
| E5 org_viewer CSV エクスポート | `/org/licenses/usage-report` → ExportButtons |
| E6 産業医健康指導 | `/org/health/{userId}` → AiAdviceButton |
| E7 産業医別組織アクセス試行 | `403 ORG_PERMISSION_DENIED` バナー表示 |
| E8 産業医メモ記録 | `/org/health/{userId}` → AddNoteButton |
| E9 退職者データ参照試行 | `403` + AccessDeniedBanner |
| E10 同意撤回後のデータ | ConsentRevokedBanner + データ非表示 |

## 22. エラーハンドリング

- 403 / 402: `AccessDeniedBanner` コンポーネントで表示 (エラーコードを人間可読テキストに変換)
- 409 ライセンス枯渇: `ConflictModal` で「+追加購入」リンク表示
- ネットワークエラー: `sonner` toast + 再試行ボタン
- CSV 形式不正: 行ごとにエラーを表示 (インライン validation)

## 23. テスト方針

- Playwright E2E:
  - `org/02-invite-and-accept.spec.ts`: 招待送付 → `/invite/org/{token}` 受諾 → dashboard
  - `org/03-bulk-import.spec.ts`: CSV 100 件 → 進捗バー → 完了確認
  - `org/04-challenge-create-join.spec.ts`: チャレンジ作成 → メンバー参加 → 達成確認
- axe-core: 全ページで a11y チェック (CI 必須)

## 24. 既存実装との関連

- `/org/dashboard`, `/org/members`: 既存 UI を基に拡張
- `/invite/org/{token}`: 新規作成 (現状未実装)
- 旧 `/org/settings`, `/org/stats`, `/org/departments`: clean-build で削除済み

## 25. 未解決事項

- `/org/licenses` のリアルタイム更新: Supabase Realtime で `org_license_pools` を Subscribe するか、5 分ポーリングか
- 月次レポート PDF の生成エンジン: Puppeteer (Vercel 対応) vs react-pdf vs Playwright headless → 要選定
- 部署ツリーのドラッグ&ドロップ: dnd-kit vs react-sortable-tree → 要選定
