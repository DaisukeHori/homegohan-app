# family/ UI 仕様詳細設計

## 1. 目的・スコープ

家族管理ドメインの全画面構成・コンポーネント・ナビゲーション・状態表示を確定する。
Web (Next.js App Router) と Mobile (Expo WebView) の両対応。

スコープ外: デザインシステム (カラーパレット・タイポグラフィ) は `cross/03-design-system.md` に委ねる。

## 2. 関連要件

- 要件 01 §9 UI 画面仕様
- 要件 01 §5.5.5 共有献立離脱モーダル UI 例
- 100-scenarios.md B1-B20 / C1-C10 / H1-H5

## 3. 画面一覧

| 画面 ID | パス (Web) | 説明 |
|---------|-----------|------|
| FAM-001 | `/family` | 家族トップ (未所属ならオンボーディング) |
| FAM-002 | `/family/create` | グループ作成フォーム |
| FAM-003 | `/family/[id]` | グループ詳細 (タブ構造) |
| FAM-004 | `/family/[id]/members/[memberId]` | メンバー詳細 |
| FAM-005 | `/family/[id]/members/[memberId]/edit` | メンバー編集 |
| FAM-006 | `/family/[id]/invites` | 招待管理 |
| FAM-007 | `/invite/family/[token]` | 招待受諾 (認証不要 → 認証後) |
| FAM-008 | `/family/[id]/shared-menus` | 共有献立カレンダー |
| FAM-009 | `/family/[id]/shopping-list` | 共有買い物リスト |
| FAM-010 | `/family/[id]/requests` | 個別献立リクエスト一覧 |
| FAM-011 | `/family/[id]/settings` | グループ設定 |
| FAM-012 | `/family/[id]/settings/lifecycle` | 凍結・解散・分割 |

Mobile 専用:
| 画面 ID | パス (Mobile) | 説明 |
|---------|-------------|------|
| FAM-M01 | `app/family/index.tsx` | FAM-003 の Mobile 版 |
| FAM-M02 | `app/family/invite-accept.tsx` | ディープリンク受諾画面 |
| FAM-M03 | `app/family/shopping-list.tsx` | Realtime 同期買い物リスト |

---

## 4. 詳細仕様

### 4.1 FAM-001: 家族トップ

#### 4.1.1 未所属状態

```
┌─────────────────────────────────────────────┐
│  🏠 家族で一緒に食事管理                      │
│                                              │
│  家族と献立を共有して、                        │
│  買い物をスムーズに。                          │
│                                              │
│  [ 家族グループを作成する ]                    │
│  [ 招待リンクをお持ちの方はこちら ]            │
│                                              │
│  ▶ よくある質問                              │
└─────────────────────────────────────────────┘
```

**状態**:
- Loading: スケルトン表示 (グループ取得中)
- Empty (未所属): 上記 UI
- Error: 「グループ情報を取得できませんでした [再試行]」

#### 4.1.2 所属中状態

```
┌────────────────────────────────────────────────────┐
│  田中家                                    [設定 ⚙]  │
│  owner: 田中美咲                                    │
│                                                    │
│  ── メンバー ──────────────────────────────────     │
│  [美咲] [太郎] [長男] [次男]                         │
│  アバター × 4 (クリックでメンバー詳細)               │
│  + 招待する                                         │
│                                                    │
│  ── 最近のアクティビティ ──────────────────────      │
│  5/6 長男がグループに追加されました                  │
│  5/5 共有献立が生成されました                        │
│                                                    │
│  ── タブ ─────────────────────────────────────      │
│  [メンバー] [共有献立] [買い物] [リクエスト] [設定]  │
└────────────────────────────────────────────────────┘
```

---

### 4.2 FAM-002: グループ作成

**Header**: 「家族グループを作る」+ 閉じるボタン (モーダル or 専用ページ)

**Body**:
```
グループ名 *
[田中家                                ]

説明 (任意)
[我が家の食事管理                       ]

アイコン
[デフォルト家族アイコン]  [画像を変更]

プラン選択
○ 無料 (最大 4 名まで)
● 家族 Basic (最大 4 名 / 月 1,480 円)
○ 家族 Pro   (最大 8 名 / 月 2,480 円)

[ Stripe Checkout で支払い手続きへ ]
```

**Actions**: 「キャンセル」 「作成する」

**バリデーション表示**:
- グループ名未入力: 赤枠 + 「グループ名は必須です」
- 101 文字以上: 「100 文字以内で入力してください」

**作成完了後**: 成功トースト + `/family/{id}` にリダイレクト

---

### 4.3 FAM-003: グループ詳細 (タブ構造)

**Header**:
```
← 戻る   田中家    [設定 ⚙]
```

**Tabs**:
1. **メンバー** (default)
2. **共有献立**
3. **買い物リスト**  バッジ: 未チェック件数
4. **リクエスト**    バッジ: 未対応件数
5. **設定**

#### Tab 1: メンバー

```
メンバー (4 名) | [+ メンバーを招待] [+ 子供を追加]

┌──────────────────────────────────────────┐
│ [avatar] 田中美咲    owner     [詳細 →]  │
│ [avatar] 田中太郎    admin     [詳細 →]  │
│ [avatar] 長男 (10歳) child     [詳細 →]  │
│ [avatar] 次男 (6歳)  child     [詳細 →]  │
└──────────────────────────────────────────┘

保留中の招待 (1 件)
┌────────────────────────────────────────┐
│ grandma@example.com  member  [取消]   │
│ 期限: 5/13 まで                        │
└────────────────────────────────────────┘
```

---

### 4.4 FAM-004: メンバー詳細

**Header**: 「← 田中家   田中美咲」

**Body**:
```
[アバター]  田中美咲  owner
続柄: 本人  年齢: 40歳  性別: 女性

── 身体情報 ────────────────────────────
身長: 162 cm  体重: 55 kg

── 食事制約 ────────────────────────────
アレルギー: (なし)
嫌いな食べ物: セロリ
食スタイル: 普通食
辛さ: 普通

── 今週の食事 ──────────────────────────
[共有: ON の場合のみ表示]
月/朝: オートミール
月/昼: 親子丼
...

── 栄養トレンド (週次グラフ) ────────────
[BarChart: カロリー / タンパク質 / 塩分]
```

**Actions** (権限あり): 「編集」「除名」(admin: 子供のみ)

---

### 4.5 FAM-005: メンバー編集

フォーム入力 (基本情報 / 食事制約 / 健康状態 / プライバシー設定)。

**プライバシー設定セクション**:
```
─ プライバシー ──────────────────────────
食事記録を家族に公開  [ON  / OFF]
健康状態を家族に公開  [ON  / OFF]  ← デフォルト OFF
```

**代理操作設定** (owner / admin のみ、P1):
```
─ 代理操作 ───────────────────────────────
代理操作が必要   [ON / OFF]
理由:  [認知症 ▼]
```

---

### 4.6 FAM-006: 招待管理

**Header**: 「← 田中家   招待管理」

**Body**:
```
新しいメンバーを招待

Email アドレス *  [grandma@example.com        ]
ロール           [メンバー ▼]
ニックネーム     [おばあちゃん (任意)           ]

[ 招待メールを送る ]

── 保留中の招待 ─────────────────────────────────
grandma@example.com   member   期限: 5/13   [取消]
uncle@example.com     member   期限: 5/10   [取消] ⚠期限切れ

── 受諾済み ─────────────────────────────────────
spouse@example.com    admin    受諾: 5/1
```

---

### 4.7 FAM-007: 招待受諾 (認証不要ページ)

**URL**: `/invite/family/{token}`

#### 4.7.1 有効なトークン + ログイン済み

```
┌──────────────────────────────────────────┐
│  👨‍👩‍👧 家族グループへの招待               │
│                                          │
│  田中美咲 さんから招待されています         │
│                                          │
│  グループ名: 田中家                       │
│  ロール:     管理者                       │
│  有効期限:   2026-05-13 まで             │
│                                          │
│  [ この家族に参加する ]                  │
│  [ 断る ]                                │
└──────────────────────────────────────────┘
```

#### 4.7.2 未ログイン状態

ログインフォーム表示 → 認証後に受諾画面へリダイレクト

#### 4.7.3 既に他グループ所属

```
⚠ 既に「山田家」に所属しています
この招待を受諾するには現在のグループを脱退してください。
[ 現在のグループを確認する ]
```

#### 4.7.4 期限切れ・無効トークン

```
❌ この招待は無効です
招待リンクの期限が切れているか、既に使用済みです。
[招待者に再送依頼してください]
```

#### 4.7.5 Mobile ディープリンク受諾 (FAM-M02)

URL: `homegohan://invite/family/{token}`
`Linking.getInitialURL()` でアプリ起動時に token 取得 → Web 版と同じ受諾 UI を表示
(WebView or ネイティブ画面)

---

### 4.8 FAM-008: 共有献立カレンダー

**Header**: 「← 田中家   共有献立」

```
[< 先週]  2026/05/12 (月) 〜 05/18 (日)  [次週 >]

[ AI で今週の献立を生成する ]

      月    火    水    木    金    土    日
朝  ---   オート  ---   ---   ---   ---   ---
昼  弁当  ---    ---   ---   ---   ---   ---
夜  カレー 炒め物 ---   ---   ---   ---   ---
おや---   ---    ---   ---   ---   ---   ---

★ カレーライス (5/13 夕食)
  全員: ○ 美咲 ○ 太郎 × 長男(離脱中) ○ 次男

  [按分編集]  [削除]
```

**離脱中メンバー**: 薄いグレー + 「別メニュー」バッジ + 個別リクエストへのリンク

**「AI で献立生成」モーダル**:
```
対象メンバー: [全員] ○ / 個別選択 ○
期間: 2026/05/12 〜 05/18
調理時間: [30 分以内 ▼]
冷蔵庫優先: [ON]

[ 生成する (約 30 秒) ]
```

---

### 4.9 FAM-009: 共有買い物リスト (FAM-M03: Mobile Realtime 版)

**Header**: 「← 田中家   買い物リスト  [印刷 🖨]」

```
5/12 〜 5/18 の買い物リスト
未チェック: 8 件 / 全 12 件

─ 肉類 ────────────────────────────────────────
☐ 鶏胸肉    600g    [太郎が担当]  [削除]
☑ 豚バラ    300g    ✓ 美咲チェック済

─ 野菜 ────────────────────────────────────────
☐ にんじん  2本     [担当未設定] [担当設定 ▼]
☐ 玉ねぎ    3個

─ その他 ──────────────────────────────────────
☐ 牛乳      1L

[+ アイテムを手動追加]
[共有献立から再生成]

[完了にする]  [アーカイブ]
```

**リアルタイム同期**: Supabase Realtime チャンネル `shopping_list_{list_id}` を購読。
他メンバーがチェックすると即時 UI 更新 (楽観的更新 + サーバー確認)。

**印刷対応** (`@media print`):
- ヘッダー・ナビゲーション非表示
- チェック済みアイテムはグレーアウト
- カテゴリ別に改ページ考慮

---

### 4.10 FAM-010: 個別献立リクエスト一覧

**Header**: 「← 田中家   リクエスト」

**タブ**:
- 「自分が担当」 バッジ: pending 件数
- 「自分が依頼」 バッジ: proposed 件数
- 「すべて」

```
[自分が担当 (2)] [自分が依頼 (1)] [すべて]

─ 担当中 (要返答) ─────────────────────────────
┌────────────────────────────────────────────┐
│ 📬 美咲からリクエスト                       │
│ 5/13 (月) 夕食                             │
│ 理由: ダイエット中 / 600kcal 以下           │
│ 期限: 5/12 (日) 06:00 まで                 │
│                                            │
│ [ AI に提案させる ]  [ 自分で考える ]       │
└────────────────────────────────────────────┘

─ 提案待ち ────────────────────────────────────
┌────────────────────────────────────────────┐
│ 📨 次男の 5/14 (火) 昼食                   │
│ 状態: 提案あり                             │
│ 提案: 鶏胸肉のサラダ / 500kcal            │
│                                            │
│ [ 承認する ]  [ 別の案を依頼する ]          │
└────────────────────────────────────────────┘
```

---

### 4.11 FAM-011: グループ設定

```
─ グループ情報 ──────────────────────────────
グループ名   田中家               [変更]
説明         (未設定)
アイコン     [変更]

─ メンバー設定 ──────────────────────────────
公開設定
  食事記録の家族間共有: [ON]
  健康データ共有:       [OFF]

週間メニュー開始曜日: [月曜日 ▼]

─ 通知設定 → (別画面 /settings/notifications)

─ 危険な操作 ─────────────────────────────────
[オーナーを変更する]    (adminがいる場合のみ)
[グループを分割する]    (P0)
[グループを解散する]    (赤ボタン)
```

---

### 4.12 FAM-012: ライフサイクル管理 (凍結・解散・分割)

凍結状態のバナー:
```
⚠ このグループは凍結されています
組織ライセンスが失効しました。2026-06-06 までに以下を選択してください。

[ 個人プランに移行する ]
[ オーナー権限を譲渡する ]
[ グループを解散する ]

残り 30 日
```

グループ分割フォーム (詳細は `07-lifecycle.md §3.3` 参照):
```
─ グループを分割 ──────────────────────────────
新グループのメンバーを選択:
☐ 田中太郎 (admin)
☐ 長男
☑ 次男

新グループ名: [田中家B           ]
新グループのオーナー: [田中太郎 ▼]

食事履歴の扱い:
○ 両グループで共有 (読み取り専用)
○ 完全分割

[ 分割実行 (全メンバーの同意が必要です) ]
```

---

## 5. 主要コンポーネント

### 5.1 `FamilyMemberCard`

**Props**:
```typescript
interface FamilyMemberCardProps {
  member: FamilyMember;
  showRole?: boolean;
  showActions?: boolean;
  onPress?: () => void;
  isCurrentUser?: boolean;
}
```

**表示**: アバター + 名前 + ロールバッジ + 続柄
**状態**: `is_active = false` → グレーアウト + 「非アクティブ」表示
**child**: 鍵アイコン + 「アカウントなし」バッジ

---

### 5.2 `MealRequestModal` (離脱モーダル)

**Props**:
```typescript
interface MealRequestModalProps {
  sharedMenu: FamilySharedMenu;
  targetMemberId: string;
  familyMembers: FamilyMember[];
  onSubmit: (data: MealRequestFormData) => void;
  onClose: () => void;
}
```

**表示**:
```
月曜の夕食: カレーライス
食べないで別のにする?

代替メニューはどうしますか?
◉ 自分で決める
○ AI に提案してもらう
○ 太郎 (admin) に頼む

料理名: [鶏胸肉のサラダ       ]  ← 自分で決める時のみ
理由 (任意): [ダイエット中    ]
制約 (任意): [600 kcal 以下   ]

[ キャンセル ]    [ 確定 ]
```

子供メンバーが対象の場合: ヘッダーに「次男の代わりに選択中」表示

---

### 5.3 `SharedMenuCard`

**Props**:
```typescript
interface SharedMenuCardProps {
  sharedMenu: FamilySharedMenu;
  memberServings: MemberServing[];
  departedMemberIds: string[];
  onEditServings?: () => void;
  onDelete?: () => void;
}
```

**表示**: 料理名 + メンバー参加状況 (○/×) + 按分情報
**離脱中**: 該当メンバーを薄いグレーで表示 + 「個別リクエストを見る」リンク

---

### 5.4 `ShoppingListItem`

**Props**:
```typescript
interface ShoppingListItemProps {
  item: FamilyShoppingItem;
  currentUserId: string;
  familyMembers: FamilyMember[];
  onCheck: (itemId: string, isChecked: boolean) => void;
  onAssign: (itemId: string, assigneeId: string | null) => void;
  onDelete: (itemId: string) => void;
}
```

**Mobile**: スワイプ左でチェック、スワイプ右で削除
**楽観的更新**: チェックを即時 UI 反映後、API 確認

---

### 5.5 `FamilyBadge`

未対応件数を数字でバッジ表示。ボトムタブ「家族」タブのアイコンに重なる。

```typescript
// バッジカウント計算
const badge = pendingForMe + proposedToMe;
// pendingForMe: assignee_id = me AND status = 'pending'
// proposedToMe: requester_id = me AND status = 'proposed'
```

---

### 5.6 `FrozenGroupBanner`

グループ状態 `frozen` 時に全家族画面の上部に固定表示。

```
⚠ 凍結中 | 残り {days} 日 | [対応する →]
```

---

## 6. ナビゲーション

### 6.1 Mobile ボトムタブ

```
[ホーム] [食事記録] [健康] [家族★] [設定]
                              ↑ バッジ
```

「家族」タブのバッジ = `FamilyBadge` の値 (0 の場合は非表示)

### 6.2 Desktop サイドバー

```
▼ 家族管理
  - 田中家 (グループ詳細)
    - メンバー
    - 共有献立
    - 買い物リスト
    - リクエスト 🔴2
    - 設定
```

### 6.3 ディープリンク

| URL | 遷移先 |
|-----|--------|
| `homegohan://invite/family/{token}` | FAM-M02 招待受諾 |
| `homegohan://family/requests/{id}` | FAM-010 リクエスト詳細 |
| `homegohan://family/shopping-list` | FAM-M03 買い物リスト |

Push 通知のタップ時も上記ディープリンクに準拠。

---

## 7. 状態管理

### 7.1 Loading 状態

全リスト系画面でスケルトン UI を表示 (`Skeleton` コンポーネント)。
API 呼び出し中はボタンを disabled にして 2 重送信防止。

### 7.2 Empty 状態

| 画面 | Empty 表示 |
|------|-----------|
| FAM-001 (未所属) | グループ作成 CTA |
| FAM-008 (共有献立なし) | 「AI で献立を生成しよう」CTA |
| FAM-009 (アイテムなし) | 「共有献立から生成」 or 「手動追加」CTA |
| FAM-010 (リクエストなし) | 「リクエストはありません」 |

### 7.3 Error 状態

ネットワークエラー: `ErrorBoundary` でキャッチ + 「再試行」ボタン
権限エラー (403): 「このページを閲覧する権限がありません」
グループ凍結 (INSERT 失敗): `FAM_GROUP_NOT_ACTIVE` → FrozenGroupBanner 表示

### 7.4 Realtime 切断

買い物リストの Realtime が切断された場合: バナー表示「リアルタイム同期が切れています。再接続中...」

---

## 8. アクセシビリティ

- 全インタラクティブ要素に `aria-label` 設定
- ロールバッジは色だけでなくテキストでも識別 (`aria-label="オーナー"`)
- チェックボックスは `role="checkbox"` + `aria-checked`
- 高齢者向けモード: フォントサイズ 1.5x / 2x 対応 (`Accessibility Settings` 連携)
- カラーブラインド対応: ステータスを色だけでなくアイコン + テキストで表示

---

## 9. テスト方針

### 9.1 コンポーネントテスト (Vitest + React Testing Library)

- `FamilyMemberCard`: child / proxy_required / inactive の各状態
- `MealRequestModal`: 4 パターン全フォームの表示・バリデーション
- `ShoppingListItem`: チェック / 未チェック / 担当者表示

### 9.2 a11y テスト (@axe-core/playwright)

CI で全家族画面の a11y スキャン。
特に FAM-007 (招待受諾) は認証状態の分岐が多いため重点確認。

### 9.3 E2E (Playwright)

- `tests/e2e/family/family-01-create-group.spec.ts`
- `tests/e2e/family/family-02-invite-accept.spec.ts`
- `tests/e2e/family/family-06-shopping-realtime.spec.ts` (2 タブ同時操作)

## 10. 既存実装との関連

- 既存 `apps/mobile/app/family/` は部分実装済 → clean-build で再構築
- `WebViewScreen.tsx` は保持 (ブリッジ共通)
- `apps/mobile/src/lib/pushNotifications.ts` に `setBadgeCountAsync` 追加が必要 (`mobile/03-push-notification.md` と連携)

## 11. ハンズオンチュートリアル画面群 (family/09 連携)

family/09 初回オンボーディングハンズオンチュートリアルが追加する UI 群の canonical 概要。各 Step の詳細仕様(吹き出し位置、アニメーション、文言確定)は family/09 配下を参照、本セクションは family ドメイン側の画面登録と既存画面への影響範囲を確定する。

### 11.1 ルート構造

| ルート | 用途 | 詳細 |
|---|---|---|
| `/handson-tour` | Tour 全体 layout (TourProvider でラップ) | family/09 §16 |
| `/handson-tour/step-0` | ウェルカム | family/09 §02 |
| `/handson-tour/step-1` | 写真追加 sandbox | family/09 §03 |
| `/handson-tour/step-2` | AI 献立 sandbox | family/09 §04 |
| `/handson-tour/step-3` | バッジ確認 | family/09 §05 |
| `/handson-tour/step-4` | 卒業 (`tutorial_complete` 付与) | family/09 §06 |
| `/home` (welcome toast) | Step 5 = 通常 home + welcome toast 4 秒 | family/09 §06 |

Web は Next.js App Router(`src/app/(main)/handson-tour/`)、Mobile は Expo Router(`apps/mobile/app/handson-tour/`)で同名ルートを並走させる。

### 11.2 共通コンポーネント (family/09 §07 → cross/03 canonical)

| コンポーネント | 役割 | canonical 参照先 |
|---|---|---|
| `TourBubble` | 吹き出し UI(矢印・本文・ボタン) | cross/03-design-system §<Coachmark> |
| `TourProgress` | 進捗ドット (Step 0〜4 の 5 個、§99 §1.2 Q1 で 5 個固定) | cross/03-design-system §<Coachmark> |
| `TourOverlay` | 背景 dim + マスク窓抜き | cross/03-design-system §<Coachmark> |
| `TourSandboxWrapper` | sandbox prop を子に注入する Provider | family/09 §07 |

`packages/handson-tour-shared/`(workspace package)で型・mock・i18n を Web/Mobile 共通化。設計書 §99 §1.1 で確定済。

### 11.3 既存画面への sandbox 対応

ハンズオン Step 1/2 が既存画面・コンポーネントを sandbox モードで再利用する。改修対象:

| 画面 / コンポーネント | プラットフォーム | 改修内容 | 参照 |
|---|---|---|---|
| `V4GenerateModal` | Web (`src/components/ai-assistant/V4GenerateModal.tsx` 556 行) + Mobile (`apps/mobile/src/components/menu/V4GenerateModal.tsx` 642 行) | `mode='sandbox'` prop 追加 (両方独立実装、§99 §1.2 Q9 確定) | family/09 §04, §13 |
| `BadgesPage` | Web (`src/app/(main)/badges/page.tsx` 294 行) + Mobile (`apps/mobile/app/badges/index.tsx` 109 行) | `tutorialMode` prop 追加 + `badge-card-{code}` 動的 testID。Mobile は機能差(フィルタ/ハイライト/アニメ簡素)があるため Mobile 側にハイライト演出も追加 (§99 §1.2 Q10 確定) | family/09 §05 |
| meals/new ルート | Web + Mobile | `?source=handson_tour&sandbox=true` クエリ受信時に Tour overlay 表示、保存時に `body.sandbox=true` で family/02 §15.5.1 を呼ぶ | family/09 §03 |
| menus/weekly | Web + Mobile | 同上、family/02 §15.5.2 連携 | family/09 §04 |

既存画面 `data-testid="badge-card"` を `badge-card-{code}` に動的化する互換戦略は §99 Q25(open)で議論中、Phase 1 着手は block しない。

### 11.4 Step 0 ウェルカム文言 (確定)

§99 §1.2 Q2 で確定:

> 3 つの便利機能を一緒に試してみましょう (約 90 秒)

`packages/handson-tour-shared/src/i18n/ja/tour.json` の `step0.title` に格納。i18n 詳細は cross/05 §<tour>。

### 11.5 進捗ドット数 (Phase 4 で確定 → §99 Q4 open)

現状 5 個 (Step 0〜4)。§99 Q4 で「3 個案」が open だが、Phase 1 では 5 個で実装し、Phase 4 (a11y + Analytics) で確定値に切り替える(影響: TourProgress コンポーネントの prop のみ)。

### 11.6 スキップ後の再開 UI (確定)

§99 §1.2 Q3 で確定:

`/settings` 画面に「使い方ガイドをもう一度見る」項目を追加。タップで `/handson-tour?force=1` へ遷移。

| 配置 | コンポーネント | testID |
|---|---|---|
| `/settings` ページ内、help セクション | `SettingsRowLink` | `settings-restart-handson-tour` |

### 11.7 a11y / 文言 / Analytics 連携

- a11y(focus trap, Dynamic Type AX5, スクリーンリーダー読み上げ)は cross/05-i18n-a11y §<tour>
- 10 イベント種類の定義は operator/07-audit-monitoring §<events>
- 文言の i18n key 設計は cross/05-i18n-a11y §<tour>

### 11.8 既存実装との関連

- 既存 V4GenerateModal / BadgesPage / meals-new / weekly-menu は保持リスト(`docs/design/00-existing-cleanup.md`)に該当、改修のみ
- `/settings` は既存実装(`src/app/(main)/settings/`)に行追加
- `/handson-tour/*` は完全新規

## 12. 未解決事項

| 項目 | 状態 |
|------|------|
| B19 高齢者向け UI の具体的フォントサイズ規定 | `cross/05-i18n-a11y.md` で確定待ち |
| 買い物リスト印刷レイアウトの詳細 | `06-shopping-list.md §5` で設計 |
| グループ分割の同意取得 UI (step-by-step) | `07-lifecycle.md §3.3` で設計 |
| 共有献立カレンダーの Mobile 向けスクロール挙動 | Mobile 実装フェーズで確定 |
| 進捗ドット数 5 vs 3 (family/09 §99 Q4) | Phase 4 で確定、v1 は 5 個実装 |
| 既存 `data-testid="badge-card"` を `badge-card-{code}` に動的化 (family/09 §99 Q25) | Phase 3A 着手前に確定 |
