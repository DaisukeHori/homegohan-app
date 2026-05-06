# 家族管理機能 要件定義書

**ドキュメントバージョン**: 1.0
**最終更新**: 2026-05-06
**作成者**: Opus (Claude)
**ステータス**: ドラフト (レビュー待ち)
**関連ドキュメント**: `02-organization-management.md`, `03-operator-admin.md`

---

## 1. エグゼクティブサマリー

### 1.1 背景と目的

ほめゴハンは個人ユーザー向けの食事管理アプリとして開発されてきたが、現実の食事は **家族単位** で営まれることが多い。母親が家族 4 人分の献立を考え、父親が買い物に行き、子供が成長期の栄養を必要とする。これらは個人アカウント単位では完結しない。

家族管理機能は、複数の個人アカウントを「家族グループ」としてまとめ、メンバー間で食事記録・献立・買い物リストを共有・閲覧できる仕組みである。同時に、アカウントを持たない子供や高齢者を「管理対象メンバー」として登録し、家族の代表が代理で管理する用途にも対応する。

### 1.2 想定するユーザー像

- **核家族世帯** (親 2 + 子 1〜3): 親が家族全員の献立を一括管理
- **多世代同居** (祖父母 + 親 + 子): 高齢者の塩分制限と子供の成長期栄養を両立
- **単身赴任**: 別居家族とも献立や買い物リストを共有
- **シェアハウス**: 同居人と食材費を分担、当番制で食事担当

### 1.3 ビジネス価値

| 価値 | 説明 |
|------|------|
| 利用継続率向上 | 家族で使うと退会しにくい (ネットワーク効果) |
| 単価向上機会 | 「家族プラン」として有料化の余地 |
| 法人連携 | 家族健康増進プログラムへの法人契約展開 |
| 競合差別化 | 個人特化のフードログアプリには無い独自機能 |

### 1.4 現状実装サマリ

調査結果 (2026-05-06):

| 領域 | 状態 |
|------|------|
| `family_groups` / `family_members` テーブル | 実装済 |
| `/api/family/groups` (GET/POST) | 実装済 |
| `/api/family/members` (GET/POST) | 実装済 |
| モバイル App `/family` 画面 | 部分実装 |
| Web 版家族管理画面 | **未実装** |
| 招待リンク生成・受諾 | **未実装** |
| メンバー間データ閲覧 | **未実装** |
| 子供アカウント | **未実装** |
| 家族プラン課金 | **未実装** |

本要件定義書は、この未実装領域を全て補完し、家族管理機能を完成形にする。

### 1.5 スコープ

#### 含む
- 家族グループの作成・更新・削除
- メンバー招待 (Email + リンク)、受諾、参加、退出
- メンバー間の食事記録閲覧、献立共有
- 子供アカウント (アカウント無しメンバー → 後でアカウント発行)
- ロール (オーナー / 管理者 / メンバー / 子供)
- 通知 (招待・参加・退出)
- Web + Mobile App 両対応
- 家族プラン (1 オーナー = 4 メンバー無料、5 人目以降は有料)

#### 含まない
- 家族グループ間の連合機能 (例: 親戚グループ)
- 共同決済 / 家計簿連動 (将来検討)
- 共同買い物カート (本書スコープ外、別 Phase で)
- グループチャット (家族メンバー間の会話、別機能で)

---

## 2. 用語定義

| 用語 | 定義 |
|------|------|
| **家族グループ (Family Group)** | 1 名以上のメンバーで構成される食事管理上の単位。1 ユーザーは 1 グループのみ所属可能 (ver 1.0) |
| **オーナー (Owner)** | 家族グループ作成者。請求・解散・他全員除名の権限を持つ |
| **管理者 (Admin)** | オーナーから委任された管理権限を持つメンバー。メンバー追加・削除・献立編集が可能 |
| **メンバー (Member)** | 一般メンバー。閲覧・自分のデータ更新・献立提案が可能 |
| **子供メンバー (Child Member)** | アカウントを持たない管理対象メンバー。親が代理で食事を記録 |
| **ペンディングメンバー (Pending Member)** | 招待は送られたが受諾していないメンバー (アカウントは作成済 or 未作成) |
| **招待トークン (Invite Token)** | 招待リンクに含まれる一意の文字列。HMAC SHA256 + 期限付き |
| **管理対象データ (Managed Data)** | 子供メンバーやアカウント未紐付けメンバーの代理記録データ |
| **共有献立 (Shared Menu)** | グループ全員に表示される共通の週間献立 |
| **個別献立 (Individual Menu)** | 特定メンバー (アレルギー対応等) のために個別に管理される献立 |
| **食材按分 (Servings Allocation)** | 1 つのレシピを複数メンバーに対してどう配分するかの定義 |

---

## 3. ペルソナ

### 3.1 ペルソナ A: 田中 美咲 (40 歳、共働き母親、2 児)

**プロフィール**
- 職業: 会社員 (システムエンジニア)
- 家族: 夫 (40 歳)、長男 (10 歳)、次男 (6 歳)
- IT リテラシー: 高 (スマホ・PC 両方使用)
- 課題: 平日の献立を考えるのが苦痛。子供のアレルギー (卵) と夫の高血圧 (減塩) を両立した献立を毎日作らねばならない

**主要ニーズ**
- 家族 4 人分の献立を一括生成、メンバー個別の制約 (アレルギー / 減塩) を AI が考慮
- 夫が買い物に行くとき、共有買い物リストを iPhone でリアルタイム参照
- 子供の食事記録を親が代理入力 (子供はアカウントなし)
- 成長期の長男のタンパク質摂取量を週次でモニター

**主要ジャーニー**
1. ほめゴハンで自分のアカウント作成 → 家族グループ「田中家」作成 (オーナー)
2. 夫を Email で招待 → 夫がアプリインストール → 受諾 → メンバーとして参加
3. 長男 (10 歳) を「子供メンバー」として登録 (アカウント無し) → アレルギー: 卵
4. 次男 (6 歳) も同様に登録
5. AI に「家族 4 人の今週の献立を作って」と依頼 → 個別制約を考慮した献立生成
6. 夫が買い物 → 共有リストにチェック → 美咲のアプリでも反映

### 3.2 ペルソナ B: 山田 太郎 (35 歳、単身赴任、別居家族 2 人)

**プロフィール**
- 職業: 会社員 (営業)
- 家族: 妻 (33 歳、別居)、長女 (4 歳、別居)
- IT リテラシー: 中
- 課題: 単身赴任で自炊が続かない。妻が長女の食事管理を一人で担当しており、栄養バランスが心配

**主要ニーズ**
- 単身赴任中の自分の食事と、別居家族の食事を 1 つのアプリで把握
- 妻に長女の食事記録をプッシュ通知で確認
- 帰省時の食事計画を妻と共同で立てる
- 長女の月次成長レポートを妻と共有

**主要ジャーニー**
1. 太郎が家族グループ「山田家」作成 (オーナー)
2. 妻を招待 → 妻が管理者ロールで参加
3. 長女 (4 歳) を子供メンバーとして登録
4. 太郎は赴任先で自分の食事記録、妻は自宅で長女の食事を記録
5. 太郎のアプリで「家族全員の今週の食事」を閲覧 → 長女の野菜摂取量が少ない日に通知
6. 帰省週末は共有献立で「家族で食べる料理」を計画

### 3.3 ペルソナ C: 鈴木 健 (68 歳、シニア、配偶者 + 同居娘夫婦)

**プロフィール**
- 職業: 退職 (元教員)
- 家族: 妻 (65 歳)、娘 (40 歳)、娘婿 (42 歳)、孫 (8 歳)
- IT リテラシー: 低 (スマホ操作はできるが PC は苦手)
- 健康課題: 軽度高血圧 + 糖尿病予備軍 → 減塩 + 糖質制限が必要
- 課題: 多世代同居で食事の好みが分かれる。健の特殊な食事制限を娘がフォロー

**主要ニーズ**
- 健の医師指示の塩分・糖質上限を超えないよう毎日チェック
- 娘 (家族管理者) が両親の食事を代理で確認・調整
- 孫の成長期栄養を一緒に管理
- 写真撮影で食事記録 (操作が簡単)

**主要ジャーニー**
1. 娘がオーナーで家族グループ「鈴木家」作成
2. 健 (父親) を Email 招待 → 健はメンバーロール
3. 健は毎食の写真を撮るだけ、AI が自動解析
4. 娘の管理画面で「父の今日の塩分: 6.8g (目標 6g 超過)」 アラート
5. 娘が今夜の献立を「減塩版」に切り替え → 家族全員に通知

---

## 4. ユースケース

### 4.1 UC-FAM-01: 家族グループの作成

**アクター**: ユーザー (オーナーになる)
**事前条件**: ユーザーがログイン済、家族グループ未所属
**事後条件**: 家族グループが作成され、ユーザーがオーナーとして登録

**フロー**:
1. ユーザーが Web/Mobile の「家族管理」メニューを開く
2. 「家族グループを作成」ボタンをタップ
3. グループ名 (例: 「田中家」)、説明 (任意) を入力
4. プラン選択 (無料 4 人まで / 家族プラン 8 人まで月額 480 円 等)
5. 「作成」ボタン → API `POST /api/family/groups`
6. 作成完了画面に「家族メンバーを招待しよう!」のフォロー UI

**例外フロー**:
- E1: 既に家族グループに所属中 → エラー「1 グループのみ所属可能」(ver 1.0 制約)
- E2: グループ名が空・101 文字以上 → バリデーションエラー
- E3: プラン課金失敗 → 無料プランで作成、後で upgrade 可

### 4.2 UC-FAM-02: メンバー招待 (Email リンク方式)

**アクター**: オーナー or 管理者
**事前条件**: 家族グループ作成済、招待者がオーナー or 管理者ロール
**事後条件**: 招待トークン生成、Email 送信、ペンディングメンバー追加

**フロー**:
1. オーナーが「家族メンバー」画面 → 「招待」ボタン
2. Email アドレス + ロール (管理者 / メンバー) + ニックネーム (任意) を入力
3. 「招待を送る」 → API `POST /api/family/invites`
   - サーバー側でトークン生成 (`crypto.randomBytes(32).toString('hex')`)
   - `family_invites` テーブルに保存 (期限 7 日)
   - Email 送信 (Resend / SendGrid 経由)
   - URL 例: `https://homegohan-app.vercel.app/invite/family/{token}`
4. 受信者は Email リンクをクリック
5. アプリ起動 (Mobile) or Web 表示
6. 受諾画面で「家族グループ「○○家」に招待されています」表示
7. 「参加する」ボタン → 既存ユーザーならログイン、未登録なら新規登録
8. 参加完了 → グループメンバー一覧に追加

**例外フロー**:
- E1: 既に他グループ所属 → 受諾不可、メッセージ表示
- E2: トークン期限切れ → 「招待が期限切れです」、再送依頼
- E3: トークン使用済 → 「既に受諾済の招待です」

### 4.3 UC-FAM-03: 子供メンバー登録 (アカウント無し)

**アクター**: オーナー or 管理者
**事前条件**: 家族グループ作成済
**事後条件**: アカウント無しメンバーが追加 (`family_members.user_id = null`)

**フロー**:
1. 「メンバー追加」 → 「子供 / アカウント無しで追加」選択
2. 名前、続柄 (息子/娘/祖父/祖母/etc.)、生年月日、性別、身長・体重 (任意)、アレルギー、嫌いな食べ物、健康状態
3. 「追加」 → API `POST /api/family/members` with `user_id: null`
4. メンバー一覧に表示 (アバター + 名前 + 「アカウントなし」表示)

**将来拡張**:
- 子供が大きくなりアカウント発行 → 既存 family_member レコードと紐付け

### 4.4 UC-FAM-04: メンバー除名

**アクター**: オーナー (管理者は同ロールメンバー除名のみ可、オーナー除名不可)
**事前条件**: 対象メンバーがグループ所属
**事後条件**: メンバーがグループから除外 (`is_active = false`)

**フロー**:
1. メンバー一覧で対象メンバー長押し → 「除名」
2. 確認モーダル: 「○○さんを家族から外します。記録した食事データはどうしますか?」
   - オプション A: 「メンバーには残す (履歴として参照可)」
   - オプション B: 「完全に削除する」
3. 確定 → API `DELETE /api/family/members/{id}`
4. 通知: 除名されたメンバーに「家族グループから外されました」push 通知

### 4.5 UC-FAM-05: メンバー間食事記録閲覧

**アクター**: 任意のメンバー (権限による制限あり)
**事前条件**: 同一グループ所属、対象メンバーの食事記録あり
**事後条件**: 食事記録一覧 / 詳細を閲覧

**フロー**:
1. 「家族メンバー」一覧で他メンバーをタップ
2. メンバー詳細画面に「今週の食事」「栄養トレンド」「健康状態」表示
3. 食事カード一覧 → タップで詳細
4. プライバシー設定 (個人で「食事記録を家族に公開しない」設定可)

**権限ロジック**:
- オーナー: 全メンバー閲覧可
- 管理者: 全メンバー閲覧可 (子供メンバー含む)
- メンバー: 公開設定したメンバーのみ閲覧可
- 子供メンバー: 自分のみ (ただし子供はアカウントなしなので閲覧者にはならない)

### 4.6 UC-FAM-06: 共有献立 / 個別献立

**アクター**: オーナー or 管理者
**事前条件**: グループ所属メンバー 2 人以上
**事後条件**: 週間献立が共有 (グループ全員) or 個別 (特定メンバー) で生成

**フロー (共有献立)**:
1. 献立生成 UI で「対象: 家族全員」を選択
2. 制約 (アレルギー、減塩等) は **全メンバーの和集合** で適用 (誰か 1 人でも卵アレルギーなら卵不使用)
3. AI 献立生成 → 全員の週間献立に表示

**フロー (個別献立)**:
1. メンバー詳細画面で「○○の個別献立」生成
2. 特定メンバーの制約のみで生成
3. 共有献立とは別タブで表示

### 4.7 UC-FAM-07: メンバー脱退 (本人意思)

**アクター**: メンバー (オーナーは脱退不可、解散のみ)
**事前条件**: グループ所属
**事後条件**: グループから脱退 (`is_active = false`)

**フロー**:
1. 「家族管理」メニュー → 「家族から脱退」
2. 確認モーダル: 「家族グループから抜けますか? 自分の食事記録は保持されます」
3. 確定 → API `POST /api/family/members/leave`
4. 通知: オーナーに「○○さんが家族から脱退しました」

### 4.8 UC-FAM-08: グループ解散 (オーナーのみ)

**アクター**: オーナー
**事前条件**: ユーザーがオーナー
**事後条件**: グループ削除、全メンバーが孤立化

**フロー**:
1. グループ設定 → 「グループを解散」
2. 警告: 「メンバー全員が家族から離れます。共有献立・買い物リストは削除されます。記録した食事は各個人に残ります」
3. パスワード再認証
4. 確定 → API `DELETE /api/family/groups/{id}`
5. 全メンバーに「家族グループ「○○家」が解散されました」通知

### 4.9 UC-FAM-09: ロール変更

**アクター**: オーナー
**事前条件**: 対象メンバーがグループ所属
**事後条件**: 対象メンバーのロールが変更

**フロー**:
1. メンバー詳細画面 → 「ロール: メンバー」をタップ → 「管理者」に変更
2. 確認 → API `PATCH /api/family/members/{id}` with `role`
3. 通知: 対象メンバーに「○○家の管理者に任命されました」

### 4.10 UC-FAM-10: オーナー権限の譲渡

**アクター**: オーナー
**事前条件**: 管理者がいる
**事後条件**: オーナーが交代 (元オーナーは管理者になる)

**フロー**:
1. グループ設定 → 「オーナーを変更」
2. 譲渡先メンバー (管理者ロールから選択)
3. パスワード再認証
4. 確定 → API `POST /api/family/groups/{id}/transfer-owner`
5. 双方に通知

---

## 5. 機能要件

### 5.1 F-FAM-001: 家族グループ管理

#### 5.1.1 概要
家族グループを作成・編集・解散できる。1 ユーザー 1 グループ制限。

#### 5.1.2 機能詳細

**作成**
- グループ名 (必須、1-100 文字)
- 説明 (任意、500 文字以内)
- アイコン画像 (任意、デフォルトは家族アイコン)
- プラン選択 (無料 / 家族プラン)

**編集**
- オーナーのみ
- グループ名、説明、アイコン変更可
- プラン変更は別フロー (UC-FAM-13、本書 Phase 2)

**解散**
- オーナーのみ
- パスワード再認証必須
- 全関連データ (`family_groups`, `family_members`, `family_invites`) を CASCADE 削除
- ただしメンバーの個人食事記録 (`meals`) は保持

#### 5.1.3 受け入れ基準
- ✅ オーナーがグループ名を変更すると、全メンバーのアプリで反映される
- ✅ 既にグループ所属のユーザーが新規グループ作成しようとすると 409 エラー
- ✅ 解散後は招待トークンも全て無効化される

### 5.2 F-FAM-002: 招待管理

#### 5.2.1 招待方法
- **Email 招待**: アドレス入力 → 招待メール送信
- **リンク招待 (Phase 2)**: 招待リンクを生成してオーナーが SNS 等で共有
- **QR コード (Phase 3)**: 同居家族向けに対面で QR スキャン

#### 5.2.2 招待トークン仕様
```
{
  "id": "uuid",
  "family_group_id": "uuid (FK)",
  "email": "string (招待先メアド、未登録 OK)",
  "role": "admin | member",
  "token": "string (32 byte hex)",
  "expires_at": "timestamp (作成 + 7 日)",
  "accepted_at": "timestamp | null",
  "created_by": "uuid (FK: auth.users)",
  "created_at": "timestamp"
}
```

#### 5.2.3 招待フロー
1. オーナーが招待作成 → トークン生成 + Email 送信
2. 受信者がリンクをクリック → 受諾画面
3. ログイン (or 新規登録)
4. 「家族「○○家」に参加する」ボタン
5. `family_members` レコード作成 + `family_invites.accepted_at` 更新

#### 5.2.4 制約
- 1 ユーザーは 1 グループのみ → 既に他グループ所属なら受諾不可
- 招待は 7 日間有効
- 同一 Email への重複招待は最後の 1 件のみ有効
- オーナーは同一グループに招待を 100 件まで作成可

#### 5.2.5 受諾完了通知
- 招待者 (オーナー / 管理者) に push 通知 + Email
- グループ全員に「○○さんが家族に加わりました」アクティビティ表示

### 5.3 F-FAM-003: メンバー管理

#### 5.3.1 メンバー属性
- **基本情報**: 名前、続柄、生年月日、性別、身長、体重
- **食事制約**: アレルギー、嫌いな食べ物、好きな食べ物、辛さ耐性
- **健康状態**: 健康疾患、服用薬、栄養目標 (減量/維持/増量)
- **栄養目標**: 1 日のカロリー / タンパク質 / 脂質 / 炭水化物
- **表示**: 表示順、アクティブ/非アクティブ
- **アカウント**: `user_id` (null 可)

#### 5.3.2 操作
- 追加 (アカウント有 / 子供アカウント無)
- 編集 (オーナー or 管理者 or 本人)
- 除名 (オーナー or 管理者)
- 脱退 (本人)
- ロール変更 (オーナーのみ)

#### 5.3.3 アカウントなし → アカウントあり 紐付け
- 子供メンバーが成長してアカウント作成 → 既存 `family_members` レコードに `user_id` を紐付ける
- API: `POST /api/family/members/{id}/link-account`
- 認証: 本人がログイン中 + メンバー追加した家族のオーナーが承認

### 5.4 F-FAM-004: ロール・権限

| ロール | 説明 |
|--------|------|
| **オーナー (owner)** | グループ作成者、全権限 |
| **管理者 (admin)** | メンバー管理 + 献立編集権限 |
| **メンバー (member)** | 閲覧 + 自分のデータ更新 |
| **子供 (child)** | アカウントなし、データ管理対象のみ |

#### 5.4.1 権限マトリクス

| 操作 | オーナー | 管理者 | メンバー | 子供 |
|------|---------|--------|---------|------|
| グループ編集 | ✅ | ❌ | ❌ | ❌ |
| グループ解散 | ✅ | ❌ | ❌ | ❌ |
| メンバー追加 | ✅ | ✅ | ❌ | ❌ |
| メンバー除名 (他人) | ✅ | △ (子供のみ) | ❌ | ❌ |
| 招待送信 | ✅ | ✅ | ❌ | ❌ |
| ロール変更 | ✅ | ❌ | ❌ | ❌ |
| オーナー譲渡 | ✅ | ❌ | ❌ | ❌ |
| 共有献立編集 | ✅ | ✅ | ❌ | ❌ |
| 共有献立閲覧 | ✅ | ✅ | ✅ | ❌ |
| 自分の食事記録 | ✅ | ✅ | ✅ | △ (代理) |
| 他人の食事記録閲覧 | ✅ | ✅ | △ (公開設定次第) | ❌ |
| 共有買い物リスト編集 | ✅ | ✅ | ✅ | ❌ |
| プライバシー設定 | ✅ | ✅ | ✅ | ❌ |

### 5.5 F-FAM-005: 共有献立

#### 5.5.1 共有献立とは
グループ全員の食事として「今週月曜の夕食はカレー」のような **共通の献立** を管理する。

#### 5.5.2 個別献立との違い
- **共有献立**: グループの全メンバーで共通 (カレーを食べる日)
- **個別献立**: 特定メンバー専用 (アレルギー対応、ダイエット中の代替食 等)

メンバーは両方を組み合わせて週間献立を構成する。

#### 5.5.3 制約の和集合
共有献立 AI 生成時は、全メンバーの制約の **和集合** を適用:
- 例: 美咲 (制約なし) + 夫 (減塩) + 長男 (卵アレルギー) + 次男 (制約なし)
  → 減塩 AND 卵不使用 で生成

#### 5.5.4 食材按分
1 つのレシピを家族 4 人で分けるとき、メンバーごとの量を可視化:
- 例: ハンバーグ 4 個 → 美咲 1 個、夫 1 個、長男 1.5 個、次男 0.5 個
- メンバーの体重・年齢・栄養目標から自動配分
- 手動上書きも可

### 5.6 F-FAM-006: 共有買い物リスト

#### 5.6.1 概要
家族の誰でも編集可能な共通買い物リスト。チェック状態がリアルタイム同期。

#### 5.6.2 機能
- 買い物リストの自動生成 (共有献立から)
- 手動追加 (誰でも)
- チェック / アンチェック
- 担当者割り当て (任意、「○○が買う」)
- リアルタイム同期 (Supabase Realtime)

### 5.7 F-FAM-007: 通知

#### 5.7.1 通知種別

| 種別 | 配信先 | 経路 |
|------|--------|------|
| 招待を受け取った | 受信者 | Email + Push |
| 招待が受諾された | 招待者 | Push |
| メンバーが参加した | グループ全員 | Push (in-app) |
| メンバーが脱退した | グループ全員 | Push (in-app) |
| メンバーが除名された | 除名対象 | Push + Email |
| グループ解散 | 元メンバー全員 | Push + Email |
| 共有献立が生成された | グループ全員 | Push (任意設定) |
| 買い物リストに追加された | グループ全員 | Push (任意設定) |
| 緊急通知 (アレルギー誤食警告) | グループ全員 | Push + 強制表示 |

#### 5.7.2 通知設定
- ユーザー個別に ON/OFF 可能
- 種別ごとに Email / Push を選択可
- 「家族関連」「献立」「買い物リスト」「緊急」のカテゴリ単位

---

## 6. 非機能要件

### 6.1 パフォーマンス

| 指標 | 目標 |
|------|------|
| 家族メンバー一覧の表示 | < 500ms (10 人以下) |
| 招待メール送信 | < 3s (バックグラウンド) |
| 共有献立生成 | < 30s (4 人家族) |
| メンバー追加 | < 1s |

### 6.2 拡張性

- 1 グループあたり最大メンバー数: 20 人 (将来 50 人へ拡張可)
- 1 ユーザーが将来複数グループ所属可能 (Phase 3)

### 6.3 セキュリティ

- 招待トークン: 32 byte (256 bit) ランダム + HMAC 署名
- メンバー間データ閲覧は RLS で制御
- 子供メンバーの個人情報 (生年月日・体重) は親のみアクセス可
- パスワード再認証: グループ解散・オーナー譲渡時必須

### 6.4 プライバシー

- 食事記録の家族公開は **オプトイン** (デフォルト非公開)
- 健康状態・服薬情報は本人のみ閲覧可 (家族管理者にも非公開デフォルト)
- アカウント削除時、家族グループ所属情報も自動削除

### 6.5 アクセシビリティ

- スクリーンリーダー対応 (ARIA ラベル)
- 高齢者向け大文字モード (Accessibility Settings)
- カラーブラインド対応 (色だけで情報を区別しない)

### 6.6 国際化

- 日本語 (デフォルト)
- 英語 (Phase 2)
- 単位系: メートル法 (kg, cm, ml) のみ (英語版でも統一)

---

## 7. データモデル

### 7.1 テーブル定義

#### 7.1.1 `family_groups`

```sql
CREATE TABLE family_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  description   TEXT,
  icon_url      TEXT,
  owner_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan          VARCHAR(50) NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'family_basic', 'family_pro')),
  member_limit  INT NOT NULL DEFAULT 4,
  settings      JSONB NOT NULL DEFAULT '{}',
  archived_at   TIMESTAMP WITH TIME ZONE,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id)  -- 1 ユーザー 1 オーナーグループ
);

CREATE INDEX idx_family_groups_owner ON family_groups(owner_id);
```

**RLS ポリシー**:
- SELECT: メンバー全員 (`family_members.user_id = auth.uid()`)
- UPDATE: オーナー (`owner_id = auth.uid()`)
- DELETE: オーナー (`owner_id = auth.uid()`)
- INSERT: 認証済ユーザー (グループ未所属チェック)

#### 7.1.2 `family_members`

```sql
CREATE TABLE family_members (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id     UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- 基本情報
  name                VARCHAR(50) NOT NULL,
  relation            VARCHAR(50) NOT NULL,  -- 'self', 'spouse', 'child', 'parent', 'sibling', 'other'
  birth_date          DATE,
  gender              VARCHAR(20) CHECK (gender IN ('male', 'female', 'other', 'prefer_not_to_say')),
  -- 身体情報
  height_cm           NUMERIC(5,2),
  weight_kg           NUMERIC(5,2),
  -- 食事関連
  allergies           TEXT[] DEFAULT '{}',
  dislikes            TEXT[] DEFAULT '{}',
  favorite_foods      TEXT[] DEFAULT '{}',
  diet_style          VARCHAR(50) DEFAULT 'omnivore',  -- 'omnivore', 'pescatarian', 'vegetarian', 'vegan', 'keto', 'halal', 'kosher'
  spice_tolerance     VARCHAR(20) DEFAULT 'medium',  -- 'mild', 'medium', 'spicy'
  -- 健康
  health_conditions   TEXT[] DEFAULT '{}',
  medications         TEXT[] DEFAULT '{}',
  daily_calories      INT,
  protein_ratio       NUMERIC(4,2),  -- 0.10〜0.40
  -- ロール
  role                VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'child')),
  -- 表示・状態
  display_order       INT NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  privacy_settings    JSONB NOT NULL DEFAULT '{"share_meals": false, "share_health": false}',
  -- メタ
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- user_id がある場合は 1 グループ 1 メンバー
  UNIQUE (family_group_id, user_id) WHERE (user_id IS NOT NULL)
);

CREATE INDEX idx_family_members_group ON family_members(family_group_id);
CREATE INDEX idx_family_members_user ON family_members(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_family_members_active ON family_members(family_group_id, is_active) WHERE is_active = TRUE;
```

**RLS ポリシー**:
- SELECT: 同グループメンバー全員
- UPDATE: 本人 (`user_id = auth.uid()`) or オーナー or 管理者
- DELETE: オーナー or 管理者
- INSERT: オーナー or 管理者

#### 7.1.3 `family_invites`

```sql
CREATE TABLE family_invites (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id   UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  email             VARCHAR(255) NOT NULL,
  role              VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  nickname          VARCHAR(50),
  token             VARCHAR(64) NOT NULL UNIQUE,
  expires_at        TIMESTAMP WITH TIME ZONE NOT NULL,
  accepted_at       TIMESTAMP WITH TIME ZONE,
  accepted_by       UUID REFERENCES auth.users(id),
  cancelled_at      TIMESTAMP WITH TIME ZONE,
  created_by        UUID NOT NULL REFERENCES auth.users(id),
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_family_invites_token ON family_invites(token);
CREATE INDEX idx_family_invites_email ON family_invites(email);
CREATE INDEX idx_family_invites_pending ON family_invites(family_group_id) WHERE accepted_at IS NULL AND cancelled_at IS NULL;
```

**RLS ポリシー**:
- SELECT (オーナー/管理者): family_group オーナー or 管理者
- SELECT (受諾用): 認証なし許可、token で個別アクセス (Server Action 経由)
- UPDATE: 受諾時のみ (Server Action 内)
- DELETE: オーナー or 作成者

#### 7.1.4 `family_activity_log`

```sql
CREATE TABLE family_activity_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id   UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  actor_id          UUID REFERENCES auth.users(id),
  action_type       VARCHAR(50) NOT NULL,  -- 'group_created', 'member_added', 'member_left', 'member_removed', 'role_changed', 'shared_menu_generated', etc.
  target_id         UUID,
  details           JSONB DEFAULT '{}',
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_family_activity_group ON family_activity_log(family_group_id, created_at DESC);
```

#### 7.1.5 `family_shared_menus`

```sql
CREATE TABLE family_shared_menus (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id   UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  date              DATE NOT NULL,
  meal_type         VARCHAR(20) NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  dish_name         VARCHAR(200) NOT NULL,
  recipe_id         UUID,
  servings_total    NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  notes             TEXT,
  created_by        UUID NOT NULL REFERENCES auth.users(id),
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (family_group_id, date, meal_type, dish_name)
);
```

#### 7.1.6 `family_member_servings`

```sql
CREATE TABLE family_member_servings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_shared_menu_id    UUID NOT NULL REFERENCES family_shared_menus(id) ON DELETE CASCADE,
  family_member_id         UUID NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  servings                 NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  notes                    TEXT,
  UNIQUE (family_shared_menu_id, family_member_id)
);
```

#### 7.1.7 `family_shopping_lists` / `family_shopping_items`

```sql
CREATE TABLE family_shopping_lists (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id   UUID NOT NULL UNIQUE REFERENCES family_groups(id) ON DELETE CASCADE,
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE family_shopping_items (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_shopping_list_id  UUID NOT NULL REFERENCES family_shopping_lists(id) ON DELETE CASCADE,
  ingredient_name          VARCHAR(200) NOT NULL,
  quantity                 NUMERIC(8,2),
  unit                     VARCHAR(20),
  category                 VARCHAR(50),  -- '野菜', '肉', '魚介', '乳製品', etc.
  is_checked               BOOLEAN NOT NULL DEFAULT FALSE,
  assignee_id              UUID REFERENCES auth.users(id),  -- 誰が買うか
  added_by                 UUID NOT NULL REFERENCES auth.users(id),
  checked_by               UUID REFERENCES auth.users(id),
  checked_at               TIMESTAMP WITH TIME ZONE,
  created_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_family_shopping_items_list ON family_shopping_items(family_shopping_list_id);
CREATE INDEX idx_family_shopping_items_unchecked ON family_shopping_items(family_shopping_list_id) WHERE is_checked = FALSE;
```

### 7.2 マイグレーション

```sql
-- migration: 2026MMDDHHMMSS_create_family_management.sql
-- 上記テーブル定義をすべて含む
-- 既存 family_groups / family_members は ALTER TABLE で拡張
```

---

## 8. API 仕様

### 8.1 グループ操作

#### 8.1.1 `POST /api/family/groups`
**説明**: 家族グループを作成する。
**認証**: 必須 (Bearer token)
**リクエスト**:
```json
{
  "name": "田中家",
  "description": "我が家の食事管理",
  "icon_url": null,
  "plan": "free"
}
```
**レスポンス 201**:
```json
{
  "id": "uuid",
  "name": "田中家",
  "owner_id": "uuid",
  "plan": "free",
  "member_limit": 4,
  "created_at": "2026-05-06T20:30:00Z"
}
```
**エラー**:
- 400: バリデーション失敗
- 409: 既に他グループ所属

#### 8.1.2 `GET /api/family/groups/me`
**説明**: 自分が所属する家族グループを取得。
**認証**: 必須
**レスポンス 200**:
```json
{
  "group": { /* family_group */ },
  "my_role": "owner",
  "members_count": 4,
  "pending_invites_count": 1
}
```
**レスポンス 404**: 所属グループなし

#### 8.1.3 `PATCH /api/family/groups/{id}`
**説明**: グループ情報更新 (オーナーのみ)
**リクエスト**:
```json
{
  "name": "新しい家族名",
  "description": "...",
  "settings": { ... }
}
```

#### 8.1.4 `DELETE /api/family/groups/{id}`
**説明**: グループ解散 (オーナーのみ、再認証必須)
**リクエスト**:
```json
{
  "password": "..."
}
```

#### 8.1.5 `POST /api/family/groups/{id}/transfer-owner`
**説明**: オーナー譲渡
**リクエスト**:
```json
{
  "new_owner_member_id": "uuid",
  "password": "..."
}
```

### 8.2 メンバー操作

#### 8.2.1 `GET /api/family/members`
**クエリ**: `?group_id={uuid}`
**レスポンス**: メンバー一覧 (`is_active = true` のみ)

#### 8.2.2 `POST /api/family/members`
**説明**: メンバー追加 (子供メンバー or 直接追加)
```json
{
  "name": "長男",
  "relation": "child",
  "birth_date": "2016-04-15",
  "gender": "male",
  "allergies": ["卵"],
  "role": "child",
  "user_id": null
}
```

#### 8.2.3 `PATCH /api/family/members/{id}`
**説明**: メンバー情報更新

#### 8.2.4 `DELETE /api/family/members/{id}`
**説明**: メンバー除名

#### 8.2.5 `POST /api/family/members/leave`
**説明**: 自分が脱退

#### 8.2.6 `POST /api/family/members/{id}/link-account`
**説明**: 子供メンバーにアカウントを紐付ける

### 8.3 招待

#### 8.3.1 `POST /api/family/invites`
**リクエスト**:
```json
{
  "email": "spouse@example.com",
  "role": "admin",
  "nickname": "ダーリン"
}
```
**レスポンス 201**:
```json
{
  "id": "uuid",
  "token": "abc123...",
  "invite_url": "https://homegohan-app.vercel.app/invite/family/abc123...",
  "expires_at": "..."
}
```

#### 8.3.2 `GET /api/family/invites/{token}`
**説明**: 招待トークン情報取得 (受諾画面用)
**認証**: 不要 (token で identification)

#### 8.3.3 `POST /api/family/invites/{token}/accept`
**説明**: 招待受諾
**認証**: 必須

#### 8.3.4 `DELETE /api/family/invites/{id}`
**説明**: 招待取消 (オーナー or 作成者)

### 8.4 共有献立

#### 8.4.1 `POST /api/family/shared-menus`
**説明**: 共有献立を AI 生成
```json
{
  "start_date": "2026-05-12",
  "end_date": "2026-05-18",
  "constraints": {
    "use_fridge_first": true,
    "respect_all_allergies": true,
    "max_cooking_time_min": 30
  }
}
```

#### 8.4.2 `GET /api/family/shared-menus`
**クエリ**: `?date_from=...&date_to=...`

#### 8.4.3 `PATCH /api/family/shared-menus/{id}`

#### 8.4.4 `DELETE /api/family/shared-menus/{id}`

### 8.5 共有買い物リスト

#### 8.5.1 `GET /api/family/shopping-list`

#### 8.5.2 `POST /api/family/shopping-list/items`
**説明**: 手動で買い物アイテム追加

#### 8.5.3 `PATCH /api/family/shopping-list/items/{id}`
**説明**: チェック / 担当者変更

#### 8.5.4 `POST /api/family/shopping-list/regenerate`
**説明**: 共有献立から再生成

### 8.6 通知設定

#### 8.6.1 `GET /api/family/notification-preferences`

#### 8.6.2 `PUT /api/family/notification-preferences`

### 8.7 アクティビティログ

#### 8.7.1 `GET /api/family/activity`
**クエリ**: `?limit=20&before={timestamp}`

---

## 9. UI 画面仕様

### 9.1 Web 画面

#### 9.1.1 `/family` (家族トップ)
- ログイン中ユーザーの家族グループ一覧 (現状 1 グループのみ)
- 未所属の場合は「家族グループを作成」or 「招待を確認」ボタン
- 所属中の場合: グループ名、メンバーアバター一覧、ロール、最近のアクティビティ

#### 9.1.2 `/family/create`
- グループ名・説明・アイコン入力フォーム
- プラン選択 (無料 / 有料)
- 「作成」ボタン → 完了後 `/family/{id}` にリダイレクト

#### 9.1.3 `/family/{id}` (グループ詳細)
- グループ情報 (オーナーのみ編集ボタン表示)
- メンバー一覧 (アバター + 名前 + ロール)
- 「招待」「メンバー追加」「設定」ボタン (権限による表示制御)
- タブ: メンバー / 共有献立 / 買い物リスト / アクティビティ / 設定

#### 9.1.4 `/family/{id}/members/{memberId}` (メンバー詳細)
- メンバーの基本情報
- 食事制約・健康状態
- 今週の食事記録 (公開設定 ON の場合)
- 栄養トレンド (グラフ)
- 編集ボタン (権限あり)

#### 9.1.5 `/family/{id}/invites`
- 保留中の招待一覧
- 招待作成フォーム
- リンクコピー機能
- 取消ボタン

#### 9.1.6 `/invite/family/{token}` (受諾画面、認証不要 → 認証必須)
- グループ名、招待者、ロール表示
- ログイン or 新規登録
- 「参加する」ボタン
- 既に他グループ所属の場合は警告

#### 9.1.7 `/family/{id}/shared-menus`
- 週間共有献立カレンダー
- 「AI 生成」ボタン
- 個別メンバーの servings 編集

#### 9.1.8 `/family/{id}/shopping-list`
- 買い物リスト (カテゴリ別)
- チェックボックス、担当者割当
- 手動追加フォーム

### 9.2 Mobile App 画面

#### 9.2.1 `app/family/index.tsx`
- Web の `/family/{id}` 相当
- ボトムシート式のメンバー追加

#### 9.2.2 `app/family/invite-accept.tsx`
- ディープリンク受諾画面
- URL: `homegohan://invite/family/{token}`

#### 9.2.3 `app/family/shopping-list.tsx`
- リアルタイム同期 (Supabase Realtime)
- スワイプでチェック / アンチェック

---

## 10. エラー / バリデーション

### 10.1 サーバーサイドバリデーション

| 項目 | 制約 |
|------|------|
| グループ名 | 1-100 文字、HTML タグ不可 |
| 説明 | 0-500 文字 |
| メンバー名 | 1-50 文字 |
| Email (招待) | RFC 5322 準拠 |
| 生年月日 | 過去 120 年以内 |
| 身長 | 0 < x ≤ 300 cm |
| 体重 | 0 < x ≤ 500 kg |
| アレルギー | 各 50 文字以内、最大 30 個 |
| 招待トークン | 32 byte hex |
| 招待期限 | 7 日 |

### 10.2 エラーコード一覧

| コード | 意味 |
|--------|------|
| `FAMILY_GROUP_NOT_FOUND` | グループが存在しない |
| `FAMILY_GROUP_FULL` | メンバー数上限到達 |
| `FAMILY_USER_ALREADY_IN_GROUP` | 既に他グループ所属 |
| `FAMILY_INVITE_EXPIRED` | 招待期限切れ |
| `FAMILY_INVITE_USED` | 既に受諾済 |
| `FAMILY_INVITE_CANCELLED` | キャンセル済 |
| `FAMILY_PERMISSION_DENIED` | 権限不足 |
| `FAMILY_OWNER_CANNOT_LEAVE` | オーナーは脱退不可 |
| `FAMILY_NEED_ADMIN_FOR_TRANSFER` | 譲渡先管理者なし |

---

## 11. 段階的実装計画

### Phase 1: MVP (4 週間)

**ゴール**: 基本的な家族グループ作成・メンバー追加・招待が Web + Mobile で動く

- ✅ DB マイグレーション (新テーブル群)
- ✅ API: グループ CRUD、メンバー CRUD、招待
- ✅ Web `/family` ページ群
- ✅ Mobile `/family` 画面群
- ✅ 招待 Email (Resend 経由)
- ✅ 受諾フロー (Web + Mobile ディープリンク)
- ✅ 通知 (招待・参加・脱退)

### Phase 2: 共有機能 (3 週間)

- ✅ 共有献立 API + UI
- ✅ メンバー間食事記録閲覧
- ✅ プライバシー設定 (公開・非公開)
- ✅ 共有買い物リスト + Realtime 同期

### Phase 3: 高度機能 (4 週間)

- ✅ 食材按分 (servings allocation)
- ✅ 子供メンバーアカウント発行 → 紐付け
- ✅ 家族プラン課金 (Stripe 連携)
- ✅ オーナー譲渡
- ✅ 監査ログ (`family_activity_log`)

### Phase 4: 拡張機能 (将来)

- 1 ユーザー複数グループ所属
- グループ間連合 (親戚グループ)
- 共同決済 / 家計簿
- グループチャット

---

## 12. テスト計画

### 12.1 単体テスト
- API ルートの input validation
- 権限チェック (各ロール × 各操作)
- トークン生成・検証ロジック

### 12.2 統合テスト
- 招待 → 受諾 → メンバー追加の一連フロー
- グループ解散時の CASCADE 動作
- 共有献立生成 + 個別 servings 反映

### 12.3 E2E テスト (Playwright + Maestro)
- `tests/e2e/family/` 配下に以下追加:
  - `family-01-create-group.spec.ts`
  - `family-02-invite-accept.spec.ts`
  - `family-03-add-child-member.spec.ts`
  - `family-04-leave-group.spec.ts`
  - `family-05-transfer-owner.spec.ts`

### 12.4 セキュリティテスト
- 他グループのデータ参照不可 (RLS)
- 招待トークンの brute force 耐性
- メンバー除名の権限境界

### 12.5 パフォーマンステスト
- 20 人グループでの一覧表示
- 招待 100 件の bulk 操作
- 買い物リスト Realtime 同期の遅延

---

## 13. リリース基準

### 13.1 機能基準
- [ ] Phase 1 全機能が E2E テストでパス
- [ ] 主要 5 ペルソナで手動シナリオテスト完了
- [ ] エラーメッセージ全件が日本語化済

### 13.2 品質基準
- [ ] Vercel Lighthouse スコア 90 以上
- [ ] Mobile App: TestFlight ベータで 5 件以上のクラッシュなし
- [ ] API レスポンス p95 < 500ms

### 13.3 ドキュメント基準
- [ ] ユーザー向けヘルプ記事公開
- [ ] FAQ 10 項目以上
- [ ] 招待メール文面のレビュー完了

### 13.4 法務基準
- [ ] プライバシーポリシー更新 (家族間データ共有について明記)
- [ ] 利用規約更新

---

## 14. 付録

### 14.1 招待メールテンプレート

```
件名: 【ほめゴハン】「{group_name}」から家族グループに招待されました

{inviter_name} さんから、ほめゴハンの家族グループに招待されました。

家族グループ: {group_name}
招待ロール: {role}
有効期限: {expires_at_jst} まで

下記リンクから参加してください:
{invite_url}

すでにほめゴハンをご利用中の方はログイン後に参加できます。
未登録の方はこちらから新規登録してください: {signup_url}

ご質問は support@homegohan.com までお気軽にどうぞ。

---
ほめゴハン運営チーム
```

### 14.2 通知ペイロード仕様

```typescript
type FamilyNotificationPayload =
  | {
      type: 'family.invite.received';
      group_name: string;
      inviter_name: string;
      role: string;
      invite_url: string;
    }
  | {
      type: 'family.invite.accepted';
      group_name: string;
      member_name: string;
    }
  | {
      type: 'family.member.removed';
      group_name: string;
      reason?: string;
    }
  // ... 他全種別
```

### 14.3 関連ドキュメント

- `docs/requirements/02-organization-management.md`: 組織管理 (法人版の家族管理に相当)
- `docs/requirements/03-operator-admin.md`: 運営者管理 (家族グループの統計・モデレーション)
- `docs/architecture/auth-flow.md`: 認証フロー (Supabase Auth + RLS)
- `docs/api/family.openapi.yaml`: API 仕様 (OpenAPI 形式、本書の正式版)

### 14.4 オープン課題

1. 家族プランの料金体系: Stripe での実装は別 Phase
2. 子供アカウント発行時の親同意取得 (法的検討必要)
3. グループ間の食事記録移管 (脱退時に一部だけ持っていく等)
4. 多言語対応の翻訳費用
5. 共有買い物リストの履歴管理 (削除済アイテムの監査)

### 14.5 用語の使い分け (混乱防止)

- 「家族」 = 一般用語
- 「家族グループ」 = システム用語、`family_groups` テーブル
- 「メンバー」 = `family_members` テーブルレコード
- 「ユーザー」 = `auth.users` テーブルレコード (アカウント保持者)

---

**END OF FAMILY MANAGEMENT REQUIREMENTS DOCUMENT**

次のドキュメント: `02-organization-management.md` (組織管理 / 法人契約)
