# 組織管理機能 要件定義書

**ドキュメントバージョン**: 1.0
**最終更新**: 2026-05-06
**作成者**: Opus (Claude)
**ステータス**: ドラフト (レビュー待ち)
**関連ドキュメント**: `01-family-management.md`, `03-operator-admin.md`

---

## 1. エグゼクティブサマリー

### 1.1 背景と目的

ほめゴハンを **法人 (企業 / 健保 / 自治体 / 教育機関)** に提供する事業 (B2B) のための管理機能。社員・組合員・職員に「健康増進ベネフィット」として配布し、会社が健康スコア・食事改善状況をモニタリングする。

組織管理機能は、法人契約者 (org_admin) が:
- 組織内のメンバーを招待・管理
- 部署単位で集計・チャレンジを運営
- ヘルススコアの可視化 (個人プライバシー保護下)
- 補助金 (健康経営優良法人取得支援等) のレポート作成

を行うための SaaS 管理画面である。

### 1.2 想定する顧客セグメント

| セグメント | 規模 | 主な用途 |
|------------|------|---------|
| **健康保険組合** | 1,000〜100,000 加入者 | 加入者の生活習慣病予防 |
| **大企業 (健康経営)** | 500〜10,000 従業員 | 健康経営優良法人取得 + ESG |
| **中小企業** | 30〜500 従業員 | 福利厚生強化、離職率低減 |
| **官公庁・教育機関** | 100〜5,000 職員 | 健康経営、生活習慣指導 |
| **介護・看護施設** | 50〜500 職員 | 夜勤者の食事管理 |
| **スポーツチーム** | 20〜200 選手 | パフォーマンス向上 |

### 1.3 ビジネスモデル

#### 1.3.1 課金体系
| プラン | 月額 (1 ユーザー) | 機能 |
|--------|------------------|------|
| **Org Starter** | 480 円 | 基本機能 + 月次レポート |
| **Org Standard** | 980 円 | + 部署別集計、チャレンジ |
| **Org Pro** | 1,980 円 | + AI 個別アドバイス、産業医連携 |
| **Org Enterprise** | 要相談 | + SSO (SAML)、API、SLA、専任カスタマーサポート |

#### 1.3.2 契約フロー
1. 法人問い合わせ (`/contact?type=org`)
2. 営業対応 → デモ → 見積もり
3. 契約締結 (オンライン or 紙)
4. 運営側で `organizations` レコード作成 + 主担当者を `org_admin` ロール付与
5. 主担当者がメンバー招待

### 1.4 現状実装サマリ

| 領域 | 状態 |
|------|------|
| `organizations` テーブル | ✅ |
| `organization_invites`, `organization_challenges` 等 | ✅ |
| `/org/dashboard`, `/org/members` 等 UI | ✅ |
| `/api/org/*` API | ✅ (基本機能) |
| 招待受諾フロー (`/invite/{token}`) | **未実装** |
| 招待メール自動送信 | **未実装** |
| メンバー除名 API | **未実装** |
| CSV 一括インポート | **未実装** |
| 部署と user_profiles の正規化 | **未整理** (現状 text 直参照) |
| 請求 / プラン管理 UI | **未実装** |
| チャレンジ参加・進捗 API | **未実装** |
| 月次レポート PDF 出力 | **未実装** |
| 産業医連携 (DB アクセス権限分離) | **未実装** |
| SSO (SAML) | **未実装** |

### 1.5 スコープ

#### 含む
- 組織レコード CRUD (運営側 + org_admin の自組織編集)
- メンバー招待 (Email、CSV 一括)、受諾フロー、除名
- 部署管理 (階層、メンバー割当)
- ロール (org_admin / org_manager / org_member / org_viewer / org_industrial_doctor)
- ヘルスダッシュボード (組織全体・部署別)
- チャレンジ機能 (作成・参加・進捗・報酬)
- 月次レポート PDF
- お知らせ (組織内アナウンス)
- プラン契約・課金 (Stripe 連携)
- SSO (SAML、Phase 3)

#### 含まない
- 個人ユーザーの食事記録の生データ閲覧 (プライバシー保護のため、運営含めても匿名化集計のみ)
- 給与・人事システム連携 (将来検討)
- 専用モバイル App (Web 完結、メンバーは個人 App 利用)
- ホワイトラベル化 (Phase 4)

---

## 2. 用語定義

| 用語 | 定義 |
|------|------|
| **組織 (Organization)** | 法人契約の単位。1 法人 = 1 組織 (グループ会社は別組織) |
| **組織管理者 (org_admin)** | 組織のオーナー権限 (請求・プラン変更・除名等) |
| **組織マネージャー (org_manager)** | メンバー追加・編集・チャレンジ運営権限 |
| **一般メンバー (org_member)** | 自分のデータ管理 + 組織内ランキング閲覧 |
| **閲覧者 (org_viewer)** | 部署集計の閲覧のみ (人事担当者向け) |
| **産業医 (org_industrial_doctor)** | 個別ユーザーの健康状態を閲覧可能 (同意取得後) |
| **部署 (Department)** | 組織内の階層構造単位。部署 → 課 → チームの 3 階層対応 |
| **チャレンジ (Challenge)** | 組織内で実施される健康増進企画 (例: 1 ヶ月で朝食を毎日食べる) |
| **健康スコア** | 食事バランス + 運動 + 睡眠から算出される総合スコア (0-100) |
| **匿名化集計** | 個人を特定できない形での集計値 (例: 部署平均、最低でも 10 名以上の集計) |
| **同意** | 個別ユーザーが組織への詳細データ提供に同意 (オプトイン) |

---

## 3. ペルソナ

### 3.1 ペルソナ A: 佐藤 健一 (45 歳、人事部長、従業員 800 名の製造業)

**プロフィール**
- 役職: 人事部長
- 担当: 健康経営優良法人 (Bright500) 取得プロジェクト
- 課題: 健保データはあるが「予防」にも投資したい。アプリ配布で食生活改善を可視化したい

**主要ニーズ**
- 全社員 800 名にアプリ展開、参加率 60% 以上
- 部署別の健康スコアで管理職に施策案内
- 月次レポートを役員報告に使用
- 個人プライバシーは厳守 (匿名化集計のみ閲覧)
- 健保連携でデータ二重管理を避ける

**主要ジャーニー**
1. ほめゴハンの法人問い合わせフォームから連絡
2. 営業デモ → 1 ヶ月パイロット (50 名) 提案
3. 契約締結 → 運営から `org_admin` 付与
4. CSV で 50 名の Email 一括招待
5. 1 ヶ月後にダッシュボードで「平均健康スコア +12 点」を確認
6. 経営会議でデモ → 全社 800 名展開を決定

### 3.2 ペルソナ B: 山口 真理子 (32 歳、健保保健師、加入者 5,000 名)

**プロフィール**
- 職業: 健保組合保健師
- 担当: 特定保健指導 + 健康増進プログラム
- 課題: 紙ベースの保健指導から脱却したい。リアルタイムで生活習慣を把握したい

**主要ニーズ**
- 加入者 5,000 名に展開、参加率 40% 以上
- 高リスク者を自動で抽出 (BMI 高、塩分過多 等)
- 産業医・保健師が個別に詳細データ閲覧 (同意済の人のみ)
- HbA1c や血圧と連携 (将来)

**主要ジャーニー**
1. 健保契約締結 → `org_admin` ロール
2. 加入者全員に招待メール送信 (1 度に 5,000 通)
3. 同意者のみ詳細プロファイル取得
4. ダッシュボードで「塩分摂取量 月平均 12g 以上」のメンバー 80 名を抽出
5. 個別保健指導の対象として抽出データを利用

### 3.3 ペルソナ C: 田村 浩二 (38 歳、IT スタートアップ CTO、社員 80 名)

**プロフィール**
- 職業: スタートアップ CTO
- 課題: 社員の健康のため福利厚生を充実させたい。コストは低めに抑えたい

**主要ニーズ**
- 80 名分の月額利用料を抑えつつ機能は使いたい
- 社内 Slack に通知連携 (チャレンジ達成等)
- API で勤怠データと統合 (オプション)
- 退職者の自動除名 (HR システムと連携)

**主要ジャーニー**
1. スタートアッププラン申し込み (Org Starter)
2. 社員 80 名に招待 → 65 名が参加 (81%)
3. 月次の社内チャレンジ「朝食を毎日食べよう」
4. 達成者は社内ポイントと連動
5. Slack に「今月の健康スコア No.1: ○○さん」自動投稿

### 3.4 ペルソナ D: 中村 太郎 (52 歳、役所 健康増進課、職員 1,200 名)

**プロフィール**
- 職業: 自治体職員
- 課題: 住民健康増進事業の効果を「数字」で示せていない

**主要ニーズ**
- 役所職員 → 住民へ展開する 2 段階モデル
- 報告書を国に提出 (匿名化必須)
- 高齢者向け簡易 UI

**主要ジャーニー**
1. 自治体契約 (Org Pro)
2. 第 1 期: 役所職員 1,200 名で試験運用
3. 第 2 期: 住民 50,000 名へ展開 (年金生活者多数)
4. 国の健康日本 21 報告書に活用

---

## 4. ユースケース

### 4.1 UC-ORG-01: 組織契約・初期セットアップ

**フロー**:
1. 法人が `/contact?type=org` で問い合わせ
2. 営業が対応 → 契約 (オフライン)
3. 運営 (super_admin) が `/admin/organizations/create` で組織レコード作成
   - 名前、業種、従業員数、プラン、契約期間
   - 主担当者の Email + 一時パスワード
4. 主担当者にウェルカムメール送信
5. 主担当者がログイン → `org_admin` ロール確認 → `/org/dashboard` 表示

### 4.2 UC-ORG-02: メンバー招待 (Email)

**フロー**:
1. org_admin が `/org/invites` → 「招待」
2. Email、ロール (org_admin / org_manager / org_member / org_viewer)、部署 (任意) を入力
3. 「招待を送る」 → API `POST /api/org/invites`
4. 招待メール自動送信 (Resend)
5. 受信者が `/invite/{token}` で受諾
6. 既存ユーザーならログイン、未登録なら新規登録
7. `user_profiles.organization_id` が設定 + 部署紐付け

### 4.3 UC-ORG-03: メンバー一括招待 (CSV)

**フロー**:
1. org_admin が `/org/invites/bulk` → CSV アップロード
2. CSV 形式:
```csv
email,role,department,nickname,employee_id
tanaka@example.com,org_member,営業部,田中太郎,EMP001
yamada@example.com,org_manager,営業部,山田花子,EMP002
```
3. プレビュー画面で件数・エラー確認
4. 「送信」 → 1 件ずつ非同期で招待作成 + Email 送信
5. 進捗画面で「85/100 件完了」表示
6. 完了後、エラー件 (Email 形式不正等) を CSV 出力

### 4.4 UC-ORG-04: メンバー除名

**フロー**:
1. `/org/members` で対象ユーザー → 「除名」
2. 確認モーダル: 「○○さんを組織から除名します。データはどうしますか?」
   - 「個人アカウントとして残す」(デフォルト): `organization_id = null`
   - 「アカウントごと削除」: 退職者向け、Supabase Auth から削除
3. 確定 → API `DELETE /api/org/members/{id}`
4. 監査ログに記録

### 4.5 UC-ORG-05: 部署管理

**フロー**:
1. `/org/departments` で階層ツリー表示
2. 新規部署: 「+ 部署を追加」 → 名前、親部署、マネージャー指定
3. メンバー割当: 部署詳細 → 「メンバーを追加」 → ドラッグドロップ or 一覧から選択
4. 部署変更: メンバー詳細 → 「所属部署変更」

### 4.6 UC-ORG-06: チャレンジ作成・運営

**フロー**:
1. `/org/challenges` → 「新規チャレンジ」
2. テンプレート選択 (朝食率 / 野菜スコア / 自炊率 / 歩数 / 減量 / カスタム)
3. 詳細入力:
   - タイトル: 「みんなで朝食習慣チャレンジ」
   - 期間: 2026-06-01 〜 2026-06-30
   - 対象: 全社 / 部署別 / 個別選択
   - 目標値: 朝食率 80% 以上
   - 報酬: 「達成者には 1,000 ポイント」
4. 「公開」 → 対象メンバーに通知
5. 期間中: ダッシュボードで進捗・参加率モニタ
6. 期間終了後: 達成者リストを CSV 出力 (人事に提出)

### 4.7 UC-ORG-07: ダッシュボード・レポート

**フロー** (org_admin):
1. `/org/dashboard` を開く
2. KPI カード: 参加率、平均健康スコア、朝食率、深夜食率、活動率
3. トレンドグラフ: 月次推移
4. 部署別ヒートマップ: スコア低い部署を赤表示
5. 「月次レポートを PDF で出力」 → 役員報告用 PDF 生成

### 4.8 UC-ORG-08: メンバー視点 (org_member)

**フロー**:
1. メンバーが個人アプリにログイン
2. 通常の食事管理 + 組織関連 UI:
   - 「会社のチャレンジ」タブ
   - 「部署内ランキング」 (匿名 or ニックネーム)
   - 「会社のお知らせ」
3. プライバシー設定: 「会社にデータを共有する範囲」
   - 匿名化集計のみ (デフォルト)
   - 部署マネージャーまで個別データ
   - 産業医まで詳細データ

### 4.9 UC-ORG-09: 産業医による個別データ閲覧 (同意済の人のみ)

**フロー**:
1. メンバーがプライバシー設定で「産業医にデータ提供を同意」
2. 産業医 (org_industrial_doctor ロール) が `/org/health/{userId}` で詳細閲覧
3. 食事記録、栄養トレンド、健康スコア、健診結果 (連携している場合)
4. 産業医メモを記録 (`org_health_notes` テーブル)

### 4.10 UC-ORG-10: 退職者の自動除名 (HR システム連携)

**フロー** (Org Pro 以上):
1. HR システムから退職者リストを Webhook で送信
2. ほめゴハン側が自動的に該当者を除名
3. データは個人アカウントとして残る
4. メンバーには「○○組織から除名されました」通知

### 4.11 UC-ORG-11: ライセンス購入

**アクター**: org_admin
**事前条件**: 組織契約済
**事後条件**: ライセンスプール (`org_license_pools`) に枚数追加

**フロー**:
1. `/org/licenses` を開く → 「ライセンス追加」ボタン
2. 購入数量を入力 (例: 100 名分)
3. プラン選択 (現在の組織プランがデフォルト、追加で家族プラン同梱オプション可)
4. 期間選択 (月額 / 年額、年額は 10% 割引)
5. 金額確認 (例: 980 円 × 100 = 月額 98,000 円)
6. Stripe で決済
7. `org_license_pools.total_licenses += 100`
8. メール: 「100 ライセンス追加完了」 + 領収書 PDF
9. 監査ログ記録

### 4.12 UC-ORG-12: ライセンス個別割当

**アクター**: org_admin or org_manager
**事前条件**: 空きライセンスあり (`available_licenses > 0`)
**フロー**:
1. `/org/licenses` で「未割当メンバー」一覧表示
2. 1 メンバー選択 → 「ライセンス割当」
3. 確認 → API `POST /api/org/licenses/assign`
4. `org_license_assignments` に新規行 (status=active)
5. プール: `used_licenses += 1`、`available_licenses -= 1`
6. 該当メンバーに通知「Pro 機能が解放されました」
7. メンバーアプリで Pro 機能解放

### 4.13 UC-ORG-13: ライセンス CSV 一括割当

**フロー**:
1. `/org/licenses/bulk-assign` で CSV アップロード
2. CSV: `email,license_plan,assignment_note`
3. プレビュー → 残ライセンス数チェック (足りなければ「+追加購入」リンク)
4. 確定 → 非同期で 1 件ずつ割当
5. 進捗: 「85/100 件割当完了」
6. 完了: 結果 CSV ダウンロード

### 4.14 UC-ORG-14: ライセンス回収・再割当

**フロー (回収)**:
1. メンバー除名 or 退職時に自動回収 (HR Webhook 連携 Pro 以上)
2. または手動: `/org/licenses` でメンバー選択 → 「ライセンス回収」
3. `org_license_assignments.revoked_at` セット、status=revoked
4. プール: `used_licenses -= 1`、`available_licenses += 1`
5. メンバーアプリで Pro 機能ロック (Free 状態に戻る)
6. ただし個人プランで Pro 課金していたら継続

**フロー (再割当)**:
1. プールに戻ったライセンスを別社員に再割当
2. 上記 UC-ORG-12 と同じ流れ

### 4.15 UC-ORG-15: ライセンス追加購入 (オーバーフロー時)

**フロー**:
1. メンバー招待時にプール残量 0 → モーダル「ライセンスが不足しています」
2. オプション:
   - 「+10 ライセンスを追加購入」 → 即時購入フロー
   - 「招待を取消」
   - 「他のメンバーから回収」
3. 追加購入完了後、招待を継続

### 4.16 UC-ORG-16: 家族プラン同梱配布 (組織が社員家族にも提供)

**アクター**: org_admin
**事前条件**: 組織プランが「家族プラン同梱可」のもの (Org Pro / Enterprise)
**シナリオ**: 福利厚生で社員本人だけでなく社員の家族 (配偶者・子供) にも家族管理機能を提供

**フロー**:
1. ライセンス購入時に「家族プランを同梱」オプション選択
2. 同梱内容:
   - 各社員に Org 機能 + 家族プラン (4 名まで or 8 名まで)
   - 家族プランの月額単価が組織契約価格に統合 (社員あたり +280 円等)
3. 社員にライセンス割当 → Org 機能 + 家族機能両方解放
4. 社員が家族グループを作成 → 配偶者・子供を招待 → 家族全員が Pro 機能
5. ただし家族メンバーは社員のライセンスに紐付くので、社員退職時に家族グループも凍結される (再契約 or 個人プランへ移行のオプション提示)

### 4.17 UC-ORG-17: ライセンス使用状況レポート

**アクター**: org_admin / finance
**フロー**:
1. `/org/licenses/report` を開く
2. 表示:
   - 月別購入推移
   - 月別使用率 (peaked usage / available)
   - メンバー別利用状況 (最終ログイン・機能使用回数)
   - 未使用ライセンスの自動回収候補 (90 日無ログインユーザー)
3. CSV / PDF 出力 (経理用)
4. 使用率低下時にアラート (例: 80% 以下が 3 ヶ月続いたら「ダウングレード提案」通知)

---

## 5. 機能要件

### 5.1 F-ORG-001: 組織レコード管理

#### 5.1.1 属性
- `id`, `name`, `industry` (業種)、`employee_count`、`plan`
- `subscription_status` (active / suspended / cancelled / trialing)
- `subscription_expires_at`, `billing_email`
- `logo_url`, `primary_color` (カラーカスタマイズ Pro 以上)
- `settings` JSONB (各種設定)

#### 5.1.2 操作
- 作成: 運営側 (`super_admin`) のみ
- 編集 (基本情報): `org_admin`
- 編集 (プラン変更): `org_admin` (再認証必須)
- 削除: 運営側のみ (契約終了時)
- 一時停止: 運営側 (未払い等)

### 5.2 F-ORG-002: メンバー管理

#### 5.2.1 メンバー追加方法
1. **個別招待 (Email)**: 1 件ずつ、招待リンク発行
2. **CSV 一括招待**: 100 件ずつバッチ処理
3. **直接作成**: org_admin が Email + パスワード設定で直接アカウント作成 (Admin API 経由)
4. **SSO (Phase 3)**: SAML 経由で自動プロビジョニング

#### 5.2.2 メンバー属性
- ユーザー基本情報 (`user_profiles`)
- 組織紐付け: `organization_id`
- 部署紐付け: `department_id` (新規追加、現在の `department` text を移行)
- 社員番号: `employee_id` (組織内ユニーク)
- 入社日: `joined_at`
- ロール: `org_member`, `org_manager`, `org_admin`, `org_viewer`, `org_industrial_doctor`
- 在籍状況: `is_active_in_org`

### 5.3 F-ORG-003: ロール・権限

#### 5.3.1 ロール定義

| ロール | 説明 | 主な権限 |
|--------|------|---------|
| **org_admin** | 組織管理者 | 全権限 (請求・プラン変更含む) |
| **org_manager** | マネージャー | メンバー管理、チャレンジ運営、部署管理 |
| **org_member** | 一般メンバー | 自分のデータ + 組織内ランキング閲覧 |
| **org_viewer** | 閲覧者 | 集計のみ (HR 担当者用) |
| **org_industrial_doctor** | 産業医 | 同意済メンバーの個別健康データ |

#### 5.3.2 権限マトリクス

| 操作 | org_admin | org_manager | org_member | org_viewer | org_industrial_doctor |
|------|-----------|-------------|------------|------------|----------------------|
| 組織情報編集 | ✅ | ❌ | ❌ | ❌ | ❌ |
| プラン変更 / 請求 | ✅ | ❌ | ❌ | ❌ | ❌ |
| メンバー招待 | ✅ | ✅ | ❌ | ❌ | ❌ |
| メンバー除名 | ✅ | ✅ | ❌ | ❌ | ❌ |
| ロール変更 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 部署管理 | ✅ | ✅ | ❌ | ❌ | ❌ |
| チャレンジ作成 | ✅ | ✅ | ❌ | ❌ | ❌ |
| チャレンジ参加 | ✅ | ✅ | ✅ | ❌ | ❌ |
| ダッシュボード (集計) | ✅ | ✅ | △ (自部署のみ) | ✅ | ✅ |
| 個別ユーザーデータ | ❌ | ❌ | ❌ | ❌ | ✅ (同意者のみ) |
| 月次レポート PDF | ✅ | ✅ | ❌ | ✅ | ❌ |

### 5.4 F-ORG-004: 招待機能

#### 5.4.1 個別招待
- Email、ロール、部署、ニックネーム、社員番号 (任意)
- 招待 URL: `/invite/{token}`
- 期限: 14 日
- メール文面: 組織ロゴ + カスタムメッセージ (org_admin が事前設定)

#### 5.4.2 CSV 一括招待
- 上限: 1 回 1,000 件、月 5,000 件
- フォーマット:
```csv
email,role,department,nickname,employee_id,joined_at
```
- バリデーション:
  - Email 形式
  - role が許可リスト内
  - department が存在 (or 自動作成オプション)
  - employee_id が組織内ユニーク
- 進捗: 非同期処理、リアルタイム進捗表示
- 結果: エラー件は CSV ダウンロード可

#### 5.4.3 受諾フロー (Phase 1 最重要)
- `/invite/{token}` ページ作成 (現状未実装)
- 既存ユーザーならログイン → 紐付け
- 未登録なら新規登録 (Email は招待 Email で自動入力、変更不可)
- 受諾後 `user_profiles.organization_id` 設定
- 同時に `organization_invites.accepted_at`, `accepted_by` 更新

### 5.5 F-ORG-005: 部署管理

#### 5.5.1 階層構造
- 最大 3 階層 (例: 「営業本部 > 関東支社 > 営業 1 課」)
- ツリー UI でドラッグ&ドロップ並べ替え

#### 5.5.2 部署属性
- `id`, `organization_id`, `parent_id` (self FK), `name`, `display_order`
- `manager_id` (部署マネージャー)
- メンバー数 (集計値、リアルタイム計算 or キャッシュ)

#### 5.5.3 メンバー割当
- 1 メンバー = 1 部署 (兼務は将来対応)
- `user_profiles.department_id` (新規追加)
- 移籍: 部署変更時に変更履歴 (`department_history`) を記録 (Pro 以上)

### 5.6 F-ORG-006: チャレンジ機能

#### 5.6.1 チャレンジ種類

| 種別 | 目標 | 計測 |
|------|------|------|
| 朝食率 | 朝食実施率 80% 以上 | 朝食記録/期間日数 |
| 野菜スコア | 野菜スコア 70 点以上 | 期間平均野菜スコア |
| 自炊率 | 自炊率 60% 以上 | 自炊記録/全食事 |
| 歩数 | 1 日平均 8,000 歩 | 歩数連携 (HealthKit 等) |
| 減量 | 期間中 -2kg | 体重記録の差分 |
| カスタム | 自由設定 | 手動評価 |

#### 5.6.2 チャレンジライフサイクル
1. `draft` (下書き)
2. `active` (公開中、参加受付)
3. `completed` (期間終了、達成判定済)
4. `cancelled` (中止)

#### 5.6.3 参加・進捗
- 対象メンバーは自動参加 or オプトイン
- 進捗計算は日次バッチ (深夜) or リアルタイム (Pro)
- ダッシュボード: 達成率、Top 10、未達者数

#### 5.6.4 報酬
- 報酬テキスト (例: 「達成者には Amazon ギフト 1,000 円」)
- 達成者リスト CSV 出力
- 自動配布は将来対応 (Stripe Coupon / Slack 連携 等)

### 5.7 F-ORG-007: ダッシュボード・レポート

#### 5.7.1 リアルタイムダッシュボード (`/org/dashboard`)
- KPI カード:
  - 参加メンバー数 / 全メンバー数 (参加率)
  - 平均健康スコア
  - 朝食率、深夜食率、自炊率
  - チャレンジ達成率
- グラフ:
  - 月次トレンド (折れ線)
  - 部署別ヒートマップ (赤=低、緑=高)
  - 年代別比較
- アラート: スコアが急低下した部署をハイライト

#### 5.7.2 月次レポート PDF
- ロゴ入り PDF (Pro 以上)
- セクション:
  - 表紙 (組織名 + 期間)
  - エグゼクティブサマリ (1 ページ)
  - KPI 詳細 (3-5 ページ)
  - 部署別比較 (1-2 ページ)
  - チャレンジ結果 (1 ページ)
  - 改善提案 (AI 生成、Pro)
- 出力: PDF / Excel / Google Slides 形式選択可

#### 5.7.3 健康経営優良法人レポート (Phase 2)
- 経済産業省提出フォーマット対応
- データを所定の様式に自動マッピング
- 取得支援: ほめゴハンの取り組みを項目別に紐付け

### 5.8 F-ORG-008: 通知・お知らせ

#### 5.8.1 組織内お知らせ
- org_admin が組織全員に告知
- タイトル + 本文 (Markdown)
- 配信: アプリ内通知 + Email (任意)
- 既読管理: `organization_announcement_reads`

#### 5.8.2 自動通知
| 種別 | 配信先 | 経路 |
|------|--------|------|
| 招待を受け取った | 受信者 | Email + Push |
| 組織から除名された | 除名対象 | Email + Push |
| チャレンジが開始 | 対象メンバー | Push |
| チャレンジ達成 | 達成者 | Push + アプリ内ポップアップ |
| 月次レポート完成 | org_admin | Email |
| 健康スコア低下警告 | org_admin (匿名集計) | アプリ内 |

### 5.9 F-ORG-009: 課金・契約管理

#### 5.9.1 プラン
- Org Starter / Standard / Pro / Enterprise (前述)
- 月額 / 年額 (年額は 10% 割引)
- 最低契約期間: 1 ヶ月 (Enterprise は 1 年)

#### 5.9.2 Stripe 連携
- カード決済 / 銀行振込 (Enterprise)
- 請求書発行 (PDF メール送付 + ASC ダッシュボード DL)
- 自動更新 / キャンセル
- 未払い時: 7 日後に組織を `suspended` 状態へ (機能制限)

#### 5.9.3 ライセンス管理 (基本)
- プランごとのメンバー上限
- 上限超過時: 招待不可 + アラート
- メンバー追加で従量課金 (オプション)

### 5.11 F-ORG-011: ライセンス管理 (詳細・拡張)

#### 5.11.1 ライセンスプール
- 組織が購入したライセンスを「プール」で管理
- プール属性: 総数、使用数、空き数、有効期限、プラン種別
- 1 組織が複数プール所持可能 (例: Org Standard 50 枚 + Org Pro 20 枚 + 家族同梱 30 枚)

#### 5.11.2 割当方法
- **手動個別**: 1 メンバーずつ選択して割当
- **CSV 一括**: 100 名分を CSV で一括割当
- **招待時自動付与**: 招待受諾時に空きライセンスから自動付与 (オプション)
- **ロール連動**: 部長以上は Org Pro、一般社員は Org Standard 等のルール設定

#### 5.11.3 回収・再割当
- **手動回収**: org_admin が任意のタイミングで回収
- **自動回収**:
  - メンバー除名時 (即時)
  - 90 日無ログイン (アラート → 30 日後自動回収、設定可)
  - 退職 HR Webhook 連携 (Pro 以上)
- **再割当**: 回収したライセンスをプールに戻し、別メンバーに付与

#### 5.11.4 アップグレード・ダウングレード
- 組織全体: Standard 全員 → Pro 全員へ一括変更
- 個別メンバー: 部分的にプラン変更
- 価格差は日割り精算

#### 5.11.5 残量アラート
- 残ライセンス < 10 でアラート
- 残ライセンス = 0 で招待ブロック + 「+追加購入」UI 表示
- 月末に未使用ライセンス分を自動返金 or 翌月繰越 (プラン契約による)

#### 5.11.6 個人プランとの併用ルール
- 組織から離脱したら組織ライセンス即無効化
- ただし個人で別途課金していた場合は個人プラン継続
- 組織復帰時は両方有効、組織ライセンス優先

#### 5.11.7 機能解放判定ロジック
```typescript
function getUserActivePlan(userId: string): PlanInfo {
  // 1. 組織ライセンス (優先)
  const orgLicense = getActiveOrgLicense(userId);
  if (orgLicense) {
    return {
      plan_key: orgLicense.plan_key,
      source: 'organization',
      organization_id: orgLicense.organization_id,
      expires_at: orgLicense.expires_at,
    };
  }
  // 2. 個人プラン
  const personalPlan = getUserPersonalPlan(userId);
  if (personalPlan) {
    return {
      plan_key: personalPlan.plan_key,
      source: 'personal',
      expires_at: personalPlan.expires_at,
    };
  }
  // 3. デフォルト Free
  return { plan_key: 'free', source: 'default', expires_at: null };
}
```

### 5.12 F-ORG-012: 家族プラン同梱配布

#### 5.12.1 概要
組織契約で社員本人だけでなく **社員の家族 (配偶者・子供)** にも家族管理機能を提供する福利厚生オプション。Org Pro / Enterprise プランで利用可能。

#### 5.12.2 同梱パターン
- **完全同梱**: 全社員に家族プラン (4 名まで) 自動付与
- **オプション同梱**: 各社員が自分で「家族プラン申請」 → org_admin 承認 → 付与
- **段階的拡張**: 基本 4 名、組織拠出で 8 名へ拡張も可

#### 5.12.3 ライセンス紐付け
```
Org License Pool (org_pro)
    ↓ 個別社員に割当
Member License (org_pro + family_addon)
    ↓ 家族グループ作成
Family Group (社員 + 配偶者 + 子供 2 名)
    ↓ 全員 Pro 機能解放
```

家族メンバーは組織ライセンスを **間接的に消費** する。社員退職で家族グループも凍結される (個人プランへ移行可能)。

#### 5.12.4 家族メンバー数の管理
- 各社員のライセンスに `family_addon_seats` 属性を持つ (4 / 8 / 12 等)
- 家族グループの `member_limit` がこれに連動
- 社員自身は 1 シート消費しない (ベースライセンスに含まれる)

#### 5.12.5 退職時の家族グループ
3 つのオプション (退職時にユーザーが選択):
- **凍結**: データは保持、家族プランは無効化
- **個人プランへ移行**: 個人で家族プラン (480 円/月) 契約 → 機能継続
- **解散**: 家族グループを完全削除

### 5.13 F-ORG-013: ライセンス使用状況分析

#### 5.13.1 使用率レポート
- 月別購入推移
- 月別使用率 (peak / available)
- メンバー別最終ログイン
- 未使用ライセンス候補リスト
- 使用率低下時のアラート

#### 5.13.2 ROI レポート (Pro 以上)
- 1 ライセンスあたりの利用率
- ライセンス費用 vs 健康改善効果
- 経営層向けダッシュボード

#### 5.13.3 監査出力
- ライセンス操作履歴 CSV (経理用)
- 未使用ライセンスの返金処理データ

### 5.10 F-ORG-010: 産業医・保健師連携

#### 5.10.1 ロール
- `org_industrial_doctor`: 産業医
- `org_health_nurse`: 保健師 (将来)

#### 5.10.2 アクセス制御
- 同意済メンバー (`user_profiles.consent_org_health_data = true`) のみ詳細閲覧
- 閲覧履歴を `org_health_access_logs` に記録
- 産業医メモ: `org_health_notes` (本人非公開、産業医のみ)

#### 5.10.3 連携機能
- 健診結果 PDF アップロード (将来)
- HbA1c / 血圧などの数値入力
- 個別保健指導の予約管理

---

## 6. 非機能要件

### 6.1 パフォーマンス

| 指標 | 目標 |
|------|------|
| ダッシュボード初回読み込み | < 1.5s |
| メンバー一覧 (1,000 名) | < 2s (ページング) |
| CSV 一括招待 (1,000 件) | バックグラウンド < 60s |
| 月次レポート PDF 生成 | < 30s |
| ダッシュボード KPI 更新間隔 | 5 分 (キャッシュ) |

### 6.2 拡張性

- 1 組織あたり最大メンバー: 100,000 名 (健保組合想定)
- 同時アクセス: 1,000 ユーザー (大企業想定)
- 部署数: 1 組織 1,000 まで

### 6.3 セキュリティ

- メンバー招待トークン: 32 byte hex + HMAC 署名
- RLS ポリシー: 自組織のデータのみアクセス
- 監査ログ: 全 admin 操作を `org_audit_logs` に記録
- IP 制限 (Enterprise): IP allowlist 設定
- 2FA 必須化 (Enterprise オプション)

### 6.4 プライバシー

- **匿名化集計の最低人数**: 10 名以上 (10 名未満の部署は集計対象外、または「その他」と統合)
- **個別データアクセス**: 産業医・保健師のみ、かつ本人同意必須
- **データ保持期間**: 退職後 6 ヶ月でデフォルト匿名化、本人申請で 30 日後削除可
- GDPR 対応 (EU 拠点企業向け、Phase 3)

### 6.5 法務・コンプライアンス

- 個人情報保護法準拠
- 健康保険法 (健保組合契約時)
- 企業の労働安全衛生法
- 健康経営優良法人取得要件をデータ提供で支援

### 6.6 SLA (Pro / Enterprise)

| 指標 | Pro | Enterprise |
|------|-----|-----------|
| 稼働率 | 99.5% | 99.9% |
| サポート応答 | 営業日 1 営業日 | 24/7、初動 1 時間 |
| バックアップ | 日次 | 1 時間ごと |
| RTO | 4 時間 | 1 時間 |
| RPO | 24 時間 | 1 時間 |

---

## 7. データモデル

### 7.1 既存テーブル (拡張)

#### 7.1.1 `organizations`
```sql
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_email VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS primary_color VARCHAR(7);  -- '#FF6B6B'
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS member_limit INT NOT NULL DEFAULT 30;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sso_metadata_url TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contract_started_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contract_ended_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
```

#### 7.1.2 `user_profiles` (department 正規化)
```sql
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS joined_org_at DATE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_active_in_org BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS consent_org_health_data BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS consent_org_data_at TIMESTAMPTZ;

CREATE UNIQUE INDEX idx_user_profiles_org_emp ON user_profiles(organization_id, employee_id) WHERE employee_id IS NOT NULL;

-- 旧 department text → department_id への移行 (バックフィル)
-- 一度限りのスクリプトで実行
```

#### 7.1.3 `departments` (拡張)
```sql
ALTER TABLE departments ADD COLUMN IF NOT EXISTS member_count_cache INT NOT NULL DEFAULT 0;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS member_count_updated_at TIMESTAMPTZ;
```

### 7.2 新規テーブル

#### 7.2.1 `organization_audit_logs`
```sql
CREATE TABLE organization_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id        UUID NOT NULL REFERENCES auth.users(id),
  action_type     VARCHAR(50) NOT NULL,  -- 'invite_sent', 'member_removed', 'role_changed', 'plan_changed', etc.
  target_id       UUID,
  target_type     VARCHAR(30),  -- 'user', 'department', 'challenge', 'organization'
  details         JSONB DEFAULT '{}',
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_audit_org ON organization_audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_org_audit_actor ON organization_audit_logs(actor_id, created_at DESC);
```

#### 7.2.2 `organization_announcements`
```sql
CREATE TABLE organization_announcements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  body            TEXT NOT NULL,  -- Markdown
  send_email      BOOLEAN NOT NULL DEFAULT FALSE,
  target_dept_id  UUID REFERENCES departments(id),  -- null = 組織全体
  scheduled_at    TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  created_by      UUID NOT NULL REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE organization_announcement_reads (
  announcement_id UUID NOT NULL REFERENCES organization_announcements(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, user_id)
);
```

#### 7.2.3 `org_health_access_logs`
```sql
CREATE TABLE org_health_access_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doctor_id       UUID NOT NULL REFERENCES auth.users(id),
  patient_id      UUID NOT NULL REFERENCES auth.users(id),
  access_type     VARCHAR(30) NOT NULL,  -- 'view_meals', 'view_health_score', 'add_note', 'view_history'
  details         JSONB DEFAULT '{}',
  accessed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_health_access_doctor ON org_health_access_logs(doctor_id, accessed_at DESC);
CREATE INDEX idx_org_health_access_patient ON org_health_access_logs(patient_id, accessed_at DESC);
```

#### 7.2.4 `org_health_notes`
```sql
CREATE TABLE org_health_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  doctor_id       UUID NOT NULL REFERENCES auth.users(id),
  note            TEXT NOT NULL,
  category        VARCHAR(50),  -- 'consultation', 'guidance', 'follow_up'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_health_notes_patient ON org_health_notes(patient_id, created_at DESC);
```

#### 7.2.5 `org_subscriptions`
```sql
CREATE TABLE org_subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan                    VARCHAR(50) NOT NULL,
  billing_cycle           VARCHAR(20) NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  amount_jpy              INT NOT NULL,
  currency                VARCHAR(3) NOT NULL DEFAULT 'JPY',
  starts_at               TIMESTAMPTZ NOT NULL,
  ends_at                 TIMESTAMPTZ NOT NULL,
  auto_renew              BOOLEAN NOT NULL DEFAULT TRUE,
  stripe_subscription_id  VARCHAR(255),
  status                  VARCHAR(30) NOT NULL DEFAULT 'active',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE org_invoices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id         UUID REFERENCES org_subscriptions(id),
  amount_jpy              INT NOT NULL,
  tax_jpy                 INT NOT NULL DEFAULT 0,
  status                  VARCHAR(30) NOT NULL,  -- 'draft', 'sent', 'paid', 'overdue', 'cancelled'
  invoice_number          VARCHAR(50) NOT NULL UNIQUE,
  due_date                DATE NOT NULL,
  paid_at                 TIMESTAMPTZ,
  pdf_url                 TEXT,
  stripe_invoice_id       VARCHAR(255),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 7.2.6 `department_history`
```sql
CREATE TABLE department_history (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_department_id      UUID REFERENCES departments(id),
  to_department_id        UUID REFERENCES departments(id),
  changed_by              UUID REFERENCES auth.users(id),
  changed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason                  TEXT
);

#### 7.2.7 `org_license_pools` (ライセンスプール)
```sql
CREATE TABLE org_license_pools (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key                VARCHAR(50) NOT NULL,  -- 'org_starter' / 'org_standard' / 'org_pro' / 'org_enterprise' / 'family_addon'
  total_licenses          INT NOT NULL DEFAULT 0,
  used_licenses           INT NOT NULL DEFAULT 0,  -- 実際に割当済の数
  available_licenses      INT GENERATED ALWAYS AS (total_licenses - used_licenses) STORED,
  family_addon_seats      INT NOT NULL DEFAULT 0,  -- 家族プラン同梱時の家族メンバー上限 (0 = 同梱なし)
  starts_at               TIMESTAMPTZ NOT NULL,
  ends_at                 TIMESTAMPTZ NOT NULL,
  auto_renew              BOOLEAN NOT NULL DEFAULT TRUE,
  unit_price_jpy          INT NOT NULL,  -- 1 ライセンスあたり月額/年額
  billing_cycle           VARCHAR(20) NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  stripe_subscription_id  VARCHAR(255),
  notes                   TEXT,
  created_by              UUID REFERENCES auth.users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (total_licenses >= used_licenses),
  CHECK (total_licenses >= 0),
  CHECK (used_licenses >= 0)
);

CREATE INDEX idx_org_license_pools_org ON org_license_pools(organization_id);
CREATE INDEX idx_org_license_pools_active ON org_license_pools(organization_id) WHERE ends_at > NOW();
```

#### 7.2.8 `org_license_assignments` (ライセンス割当)
```sql
CREATE TABLE org_license_assignments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_pool_id         UUID NOT NULL REFERENCES org_license_pools(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by             UUID REFERENCES auth.users(id),
  revoked_at              TIMESTAMPTZ,
  revoked_by              UUID REFERENCES auth.users(id),
  revoke_reason           VARCHAR(50),  -- 'manual', 'inactive_90d', 'left_org', 'auto_revoke', 'plan_change'
  expires_at              TIMESTAMPTZ,  -- ライセンスプールの ends_at と同じ or それより早い
  status                  VARCHAR(20) NOT NULL DEFAULT 'active' 
    CHECK (status IN ('active', 'revoked', 'expired')),
  -- 家族同梱の場合の使用状況
  family_seats_used       INT NOT NULL DEFAULT 0,  -- このライセンスから派生する家族メンバー数
  -- メタ
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_org_license_active_per_user ON org_license_assignments(user_id) WHERE status = 'active';
CREATE INDEX idx_org_license_pool ON org_license_assignments(license_pool_id, status);
CREATE INDEX idx_org_license_user ON org_license_assignments(user_id, status);
```

**RLS ポリシー**:
- SELECT: 本人 (`user_id = auth.uid()`) or org_admin / org_manager (同組織)
- INSERT: org_admin / org_manager
- UPDATE (revoke): org_admin / org_manager
- DELETE: 不可 (履歴保持)

**トリガー**: assignment 追加/削除時に `org_license_pools.used_licenses` を自動更新。

#### 7.2.9 `org_license_audit_log`
```sql
CREATE TABLE org_license_audit_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pool_id                 UUID REFERENCES org_license_pools(id),
  assignment_id           UUID REFERENCES org_license_assignments(id),
  actor_id                UUID REFERENCES auth.users(id),
  action_type             VARCHAR(50) NOT NULL,  -- 'pool_purchased', 'pool_extended', 'license_assigned', 'license_revoked', 'pool_expired'
  details                 JSONB DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_license_audit_org ON org_license_audit_log(organization_id, created_at DESC);
```

CREATE INDEX idx_dept_history_user ON department_history(user_id, changed_at DESC);
```

---

## 8. API 仕様

### 8.1 組織情報

#### 8.1.1 `GET /api/org/me`
**説明**: 自分が所属する組織情報 + ロール
**レスポンス**:
```json
{
  "organization": { /* organizations row */ },
  "my_roles": ["org_admin"],
  "member_count": 80,
  "department": { /* departments row */ }
}
```

#### 8.1.2 `PATCH /api/org/me`
**説明**: 組織情報更新 (org_admin のみ)

#### 8.1.3 `GET /api/org/{id}` (super_admin / org_admin)
**説明**: 組織詳細

### 8.2 メンバー管理

#### 8.2.1 `GET /api/org/members`
**クエリ**:
- `q`: 検索 (名前 / Email / 社員番号)
- `department_id`: 部署フィルタ
- `role`: ロールフィルタ
- `is_active`: 在籍中のみ
- `limit`, `offset`

#### 8.2.2 `POST /api/org/members`
**説明**: 直接アカウント作成 (Admin API 経由)

#### 8.2.3 `PATCH /api/org/members/{userId}`
**説明**: メンバー情報更新 (部署変更・ロール変更等)

#### 8.2.4 `DELETE /api/org/members/{userId}`
**説明**: メンバー除名

#### 8.2.5 `POST /api/org/members/bulk-import`
**説明**: CSV 一括招待
**リクエスト**: `multipart/form-data` with CSV file
**レスポンス**: 処理 ID (非同期処理開始)

#### 8.2.6 `GET /api/org/members/bulk-import/{importId}`
**説明**: 進捗・結果確認

### 8.3 部署管理

#### 8.3.1 `GET /api/org/departments`
**説明**: 階層ツリー取得

#### 8.3.2 `POST /api/org/departments`
**リクエスト**:
```json
{
  "name": "営業 1 課",
  "parent_id": "uuid",
  "manager_id": "uuid",
  "display_order": 1
}
```

#### 8.3.3 `PATCH /api/org/departments/{id}`

#### 8.3.4 `DELETE /api/org/departments/{id}`
**注**: 配下のメンバー・サブ部署がある場合は 409、移動先指定が必要

#### 8.3.5 `POST /api/org/departments/{id}/move-members`
**説明**: 一括メンバー移動

### 8.4 招待

#### 8.4.1 `GET /api/org/invites`
**説明**: 招待一覧 (pending / accepted / expired / cancelled でフィルタ)

#### 8.4.2 `POST /api/org/invites`
**説明**: 個別招待

#### 8.4.3 `POST /api/org/invites/bulk`
**説明**: 一括招待

#### 8.4.4 `DELETE /api/org/invites/{id}`
**説明**: 招待取消

#### 8.4.5 `POST /api/org/invites/{id}/resend`
**説明**: 再送

#### 8.4.6 `GET /api/invite/{token}`
**説明**: 招待トークン検証 (受諾画面用、認証不要)
**レスポンス**:
```json
{
  "organization": { "name": "株式会社ABC" },
  "role": "org_member",
  "department": { "name": "営業部" },
  "expires_at": "2026-05-20T12:00:00Z"
}
```

#### 8.4.7 `POST /api/invite/{token}/accept`
**説明**: 招待受諾 (認証必須)

### 8.5 チャレンジ

#### 8.5.1 `GET /api/org/challenges`
#### 8.5.2 `POST /api/org/challenges`
#### 8.5.3 `PATCH /api/org/challenges/{id}` (status 変更含む)
#### 8.5.4 `DELETE /api/org/challenges/{id}`
#### 8.5.5 `POST /api/org/challenges/{id}/join`
#### 8.5.6 `GET /api/org/challenges/{id}/participants`
#### 8.5.7 `GET /api/org/challenges/{id}/results` (達成者リスト CSV)

### 8.6 ダッシュボード・統計

#### 8.6.1 `GET /api/org/stats`
**クエリ**: `?period=7d|30d|90d|1y&department_id=...`
**レスポンス**: KPI 統計

#### 8.6.2 `GET /api/org/stats/trends`
**説明**: 時系列推移

#### 8.6.3 `GET /api/org/stats/heatmap`
**説明**: 部署別ヒートマップ

#### 8.6.4 `POST /api/org/reports/monthly`
**説明**: 月次レポート PDF 生成
**レスポンス**: `{ "report_id": "uuid", "status": "generating" }`

#### 8.6.5 `GET /api/org/reports/{id}`
**説明**: レポートダウンロード

### 8.7 お知らせ

#### 8.7.1 `GET /api/org/announcements`
#### 8.7.2 `POST /api/org/announcements`
#### 8.7.3 `PATCH /api/org/announcements/{id}`
#### 8.7.4 `DELETE /api/org/announcements/{id}`
#### 8.7.5 `POST /api/org/announcements/{id}/mark-read`

### 8.8 産業医

#### 8.8.1 `GET /api/org/health/patients`
**説明**: 同意済メンバー一覧 (org_industrial_doctor のみ)

#### 8.8.2 `GET /api/org/health/patients/{userId}`
**説明**: 患者個別データ

#### 8.8.3 `POST /api/org/health/patients/{userId}/notes`
**説明**: 産業医メモ追加

### 8.9 課金・契約

#### 8.9.1 `GET /api/org/subscription`
#### 8.9.2 `POST /api/org/subscription/upgrade`
#### 8.9.3 `POST /api/org/subscription/cancel`
#### 8.9.4 `GET /api/org/invoices`
#### 8.9.5 `GET /api/org/invoices/{id}/pdf`

### 8.10 監査ログ

#### 8.10.1 `GET /api/org/audit-logs`
**クエリ**: `?action_type=...&actor_id=...&limit=50&offset=0`

### 8.11 ライセンス管理

#### 8.11.1 `GET /api/org/licenses`
**説明**: 組織のライセンスプール一覧 (有効・期限切れ・全件)
**レスポンス**:
```json
{
  "pools": [
    {
      "id": "uuid",
      "plan_key": "org_pro",
      "total_licenses": 100,
      "used_licenses": 67,
      "available_licenses": 33,
      "family_addon_seats": 4,
      "ends_at": "2026-12-31T23:59:59Z"
    }
  ],
  "total_active": 67
}
```

#### 8.11.2 `POST /api/org/licenses/purchase`
**説明**: ライセンス追加購入
**リクエスト**:
```json
{
  "plan_key": "org_pro",
  "quantity": 100,
  "billing_cycle": "monthly",
  "include_family_addon": true,
  "family_seats_per_member": 4
}
```
→ Stripe 決済 → `org_license_pools` に新規行 or 既存プールに増枠

#### 8.11.3 `POST /api/org/licenses/extend`
**説明**: 既存プールの期間延長 (更新)

#### 8.11.4 `GET /api/org/licenses/assignments`
**クエリ**: `?status=active&pool_id=...&user_id=...`

#### 8.11.5 `POST /api/org/licenses/assign`
**説明**: 個別割当
```json
{
  "pool_id": "uuid",
  "user_id": "uuid",
  "notes": "優先順位高"
}
```

#### 8.11.6 `POST /api/org/licenses/bulk-assign`
**説明**: CSV 一括割当
**リクエスト**: `multipart/form-data` with CSV
**CSV**: `email,plan_key,assignment_note`

#### 8.11.7 `POST /api/org/licenses/auto-assign`
**説明**: 未割当の組織メンバー全員に空きライセンスを自動割当

#### 8.11.8 `DELETE /api/org/licenses/assignments/{id}`
**説明**: ライセンス回収 (revoke)
**リクエスト**:
```json
{
  "reason": "manual",
  "notify_user": true
}
```

#### 8.11.9 `POST /api/org/licenses/auto-revoke-inactive`
**説明**: 90 日無ログインユーザーから自動回収

#### 8.11.10 `GET /api/org/licenses/usage-report`
**クエリ**: `?period=30d|90d|1y`
**レスポンス**: 利用率推移、未使用候補リスト、ROI 指標

#### 8.11.11 `GET /api/org/licenses/audit-log`
**説明**: ライセンス操作履歴

### 8.12 家族プラン同梱管理

#### 8.12.1 `GET /api/org/family-addon`
**説明**: 家族プラン同梱の状態と利用状況

#### 8.12.2 `POST /api/org/family-addon/enable`
**説明**: 組織契約に家族プラン同梱を追加

#### 8.12.3 `GET /api/org/family-addon/usage`
**説明**: 各社員の家族グループ利用状況 (匿名化集計、家族の食事記録は閲覧不可)

#### 8.12.4 `POST /api/org/family-addon/expand-seats`
**説明**: 家族メンバー上限を増やす (4 → 8 等)

---

## 9. UI 画面仕様

### 9.1 `/org/dashboard`
- KPI カード × 5 (参加率・健康スコア・朝食率・自炊率・チャレンジ達成率)
- 月次トレンドグラフ (折れ線、3 ヶ月分)
- 部署別ヒートマップ
- 「月次レポートを生成」ボタン
- 最近のアクティビティ (新規参加、チャレンジ達成等)

### 9.2 `/org/members`
- 一覧テーブル (名前 + Email + 部署 + ロール + 在籍状況 + 健康スコア)
- 検索バー、フィルタ (部署 / ロール / 在籍状況)
- 「メンバー追加」「CSV インポート」ボタン
- 行アクション: 編集 / ロール変更 / 部署変更 / 除名
- 1 行クリックでメンバー詳細

### 9.3 `/org/members/{id}`
- メンバー基本情報
- 健康スコアトレンド (集計のみ、個別データは産業医のみ)
- 部署変更履歴 (Pro)
- アクティビティログ (招待受諾・最終ログイン等)

### 9.4 `/org/invites`
- タブ: Pending / Accepted / Expired / Cancelled
- 招待リスト (Email + ロール + 部署 + 期限 + 状態)
- 「招待」「CSV インポート」ボタン
- 行アクション: リンクコピー / 再送 / 取消

### 9.5 `/org/invites/bulk`
- CSV ファイルアップロード
- プレビュー (件数、エラー件)
- 「送信」ボタン → 進捗バー
- 完了後、エラー件 CSV ダウンロード

### 9.6 `/invite/{token}` (受諾画面、最重要)
- 組織ロゴ + 組織名
- 招待者、ロール、部署表示
- 期限表示
- 「ログインして参加」「新規登録して参加」ボタン
- 認証後 → 確認画面 → 「参加する」 → ダッシュボードへ

### 9.7 `/org/departments`
- 階層ツリー UI (左ペイン)
- 選択部署の詳細 (右ペイン): 名前、マネージャー、メンバー、サブ部署
- ドラッグ&ドロップで階層変更
- 「部署追加」「部署削除」「メンバー追加」ボタン

### 9.8 `/org/challenges`
- アクティブ・終了済タブ
- カード一覧 (タイトル、期間、参加者数、達成率)
- 「新規チャレンジ」ボタン → 作成ウィザード (テンプレ選択 → 詳細入力 → プレビュー → 公開)

### 9.9 `/org/challenges/{id}`
- チャレンジ詳細
- 進捗グラフ (日次/週次)
- 参加者リスト (達成者バッジ)
- 「達成者 CSV ダウンロード」「中止」「複製して再開催」ボタン

### 9.10 `/org/announcements`
- お知らせリスト
- 「新規」 → エディタ画面 (Markdown プレビュー)
- 配信対象選択 (組織全体 / 部署別)
- 既読率 (送信後)

### 9.11 `/org/settings`
- 組織情報 (ロゴ、業種、住所、連絡先)
- カスタムカラー (Pro)
- 通知設定
- SSO 設定 (Enterprise)
- 「プラン変更」「契約解除」リンク

### 9.12 `/org/billing`
- 現在のプラン
- 次回請求日 + 金額
- 過去の請求書一覧 (PDF DL)
- 支払方法 (カード変更)

### 9.13 `/org/audit-logs`
- 監査ログ一覧
- フィルタ (アクション種別 / 担当者 / 日付)
- 詳細展開で詳細 JSON 表示

### 9.14 産業医画面 (`/org/health/*`)
- `/org/health/patients`: 同意済メンバー一覧
- `/org/health/patients/{id}`: 個別ダッシュボード (食事 / 栄養 / スコア)
- 「メモ追加」「保健指導記録」ボタン

### 9.15 メンバー視点 (`/org/me`)
- 自分が所属する組織情報
- 部署内ランキング (匿名)
- 進行中のチャレンジ

### 9.16 `/org/licenses` (ライセンス管理、新規)
レイアウト:
```
┌──────────────────────────────────────────────────┐
│ ライセンス管理                                     │
├──────────────────────────────────────────────────┤
│ 現在保有                                           │
│ ┌────────────────┐ ┌────────────────┐           │
│ │ Org Pro        │ │ Family Addon   │           │
│ │ 100 / 100 枠   │ │ 同梱 (4 名 / 人) │           │
│ │ 使用 67 / 残 33 │ │ 使用 268 名     │           │
│ │ 期限: 2026-12-31│ │                 │           │
│ └────────────────┘ └────────────────┘           │
│                                                   │
│ [ + ライセンス追加 ]  [ プラン変更 ]               │
│                                                   │
├──────────────────────────────────────────────────┤
│ 割当状況                                           │
│ ┌────────────────────────────────────────────┐  │
│ │ ✓ 田中太郎       Org Pro   2024-04-01 ~       │ │
│ │ ✓ 佐藤花子       Org Pro   2024-04-15 ~       │ │
│ │ ✗ 山田次郎       回収済   2026-03-31 退職     │ │
│ │ ⚠ 未割当 33 名                                │ │
│ │   [ 自動割当 ]  [ CSV 一括割当 ]              │ │
│ └────────────────────────────────────────────┘  │
│                                                   │
│ [ 利用状況レポート ]  [ 監査ログ ]                  │
└──────────────────────────────────────────────────┘
```

機能:
- プール一覧 (プラン別、残数表示)
- 割当 / 回収 (個別 / 一括)
- 90 日無ログイン候補リスト
- 家族プラン同梱状況
- ROI レポート

### 9.17 `/org/licenses/purchase` (購入フロー)
- ステップ 1: プラン選択 (Org Standard / Pro / Enterprise)
- ステップ 2: 数量入力
- ステップ 3: 家族プラン同梱オプション
- ステップ 4: 期間 (月額 / 年額)
- ステップ 5: 金額確認 + Stripe 決済
- ステップ 6: 完了 (自動でプール更新)

### 9.18 `/org/licenses/usage-report` (利用状況レポート)
- 月別購入推移 (折れ線)
- 月別使用率
- 未使用候補リスト (90 日無ログイン)
- 「自動回収」「手動回収」ボタン
- ROI 指標 (Pro)
- CSV / PDF 出力
- お知らせ一覧

---

## 10. エラー / バリデーション

### 10.1 バリデーション

| 項目 | 制約 |
|------|------|
| 組織名 | 1-100 文字 |
| 業種 | enum (IT / 製造 / 小売 / etc.) |
| 従業員数 | 1-1,000,000 |
| Email (招待) | RFC 5322 |
| 社員番号 | 1-50 文字、組織内ユニーク |
| 部署名 | 1-100 文字 |
| 部署階層 | 最大 3 |
| チャレンジ期間 | 1-180 日 |

### 10.2 主要エラーコード

| コード | 意味 |
|--------|------|
| `ORG_MEMBER_LIMIT_EXCEEDED` | プランのメンバー数上限超過 |
| `ORG_INVITE_DOMAIN_NOT_ALLOWED` | 招待 Email ドメインが許可リスト外 |
| `ORG_USER_ALREADY_IN_ORG` | 既に他組織所属 |
| `ORG_DEPARTMENT_HAS_MEMBERS` | 部署にメンバーが残っている |
| `ORG_SUBSCRIPTION_SUSPENDED` | 契約一時停止中 |
| `ORG_PERMISSION_DENIED` | 権限不足 |
| `ORG_PLAN_FEATURE_REQUIRED` | 上位プランが必要 |

---

## 11. 段階的実装計画

### Phase 1: 招待受諾フロー完成 (1 週間)
- `/invite/{token}` 受諾画面
- API: `GET /api/invite/{token}`, `POST /api/invite/{token}/accept`
- 招待メール自動送信 (Resend)
- メンバー除名 API + UI

### Phase 2: CSV 一括 + 部署正規化 (2 週間)
- CSV 一括招待 API + UI
- `user_profiles.department_id` への移行
- 部署変更履歴

### Phase 3: ダッシュボード強化 (3 週間)
- 月次レポート PDF 生成
- 部署別ヒートマップ
- アラート機能

### Phase 4: チャレンジ機能 (3 週間)
- 進捗計算 (日次バッチ)
- 自動通知
- 達成者管理

### Phase 5: 課金・契約 (4 週間)
- Stripe 連携
- 請求書 PDF
- プラン変更フロー

### Phase 6: 産業医・SSO・SLA (6 週間)
- 産業医ロール + アクセス制御
- 同意フロー
- SAML SSO (Enterprise)
- 監査ログ強化

---

## 12. テスト計画

- 各 API の権限テスト
- 招待受諾の各種ケース
- CSV import のバリデーション
- 1,000 名規模の負荷テスト
- セキュリティテスト (他組織データへのアクセス試行)
- E2E (Playwright):
  - `org/01-create-organization.spec.ts`
  - `org/02-invite-and-accept.spec.ts`
  - `org/03-bulk-import.spec.ts`
  - `org/04-challenge-create-join.spec.ts`
  - `org/05-monthly-report.spec.ts`

---

## 13. リリース基準

- [ ] Phase 1-3 全機能 E2E パス
- [ ] パイロット組織 3 社で 4 週間運用
- [ ] サポートマニュアル整備
- [ ] 営業向けセールスシート
- [ ] 利用規約・プライバシーポリシー法務確認
- [ ] Stripe 本番接続テスト

---

## 14. 付録

### 14.1 招待メールテンプレート

```
件名: 【ほめゴハン】{org_name} から組織に招待されました

{inviter_name} さんから、ほめゴハンの組織「{org_name}」に招待されました。

ロール: {role_label}
部署: {department}
有効期限: {expires_at_jst} まで

下記リンクから参加してください:
{invite_url}

このサービスは {org_name} 様が福利厚生として提供しています。
ご利用にあたっての注意事項は別途 {org_terms_url} をご確認ください。

ご質問は {support_email} までお気軽にどうぞ。

---
ほめゴハン運営チーム
```

### 14.2 CSV 一括招待フォーマット

```csv
email,role,department,nickname,employee_id,joined_org_at
yamada.taro@example.com,org_member,営業部,山田太郎,E001,2024-04-01
sato.hanako@example.com,org_manager,開発部,佐藤花子,E002,2023-04-01
```

### 14.3 月次レポート PDF サンプル構成

1. 表紙: 組織ロゴ + 期間
2. エグゼクティブサマリ: 主要 KPI ハイライト
3. 参加状況: 招待数、参加率、アクティブ率
4. 健康スコア推移: 月次トレンド
5. 部署別比較: ヒートマップ + ランキング
6. チャレンジ結果: 開催チャレンジと達成率
7. 改善提案 (AI、Pro): 部署・年代別の傾向分析
8. 付録: 利用規約変更点・お知らせ

### 14.4 関連ドキュメント

- `01-family-management.md`
- `03-operator-admin.md`
- `docs/architecture/multi-tenancy.md` (組織テナント分離設計)
- `docs/security/rls-policies.md`

---

**END OF ORGANIZATION MANAGEMENT REQUIREMENTS DOCUMENT**

次のドキュメント: `03-operator-admin.md` (運営者管理)
