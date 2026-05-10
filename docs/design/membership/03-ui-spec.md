# 03. UI Spec — Components and Wireframes

ファイルパスは Next.js App Router 構造で記述。React component は `src/components/membership/` 配下に配置。

---

## 1. 招待発行 UI

### 1.1 organization 招待発行ページ
**file**: `src/app/(org)/org/invites/page.tsx` (既存、要修正)

```
┌──────────────────────────────────────────┐
│ 組織招待管理                              │
├──────────────────────────────────────────┤
│  + 新しいメンバーを招待                  │
│                                          │
│  メールアドレス  [____________________]  │
│  役割            [メンバー  ▼]            │
│  メッセージ (任意) [_________________]    │
│                                          │
│             [招待を送信]                  │
├──────────────────────────────────────────┤
│ ▼ 招待履歴                               │
│  alice@a.com   メンバー  pending  期限5/24│
│              [リンクをコピー] [取消]      │
│  bob@b.com     管理者    accepted 5/9   │
│  charlie@c.com メンバー  rejected 5/8   │
└──────────────────────────────────────────┘
```

操作:
- 招待送信時、server が email を auth.users で検索 → 既存/新規を判定 → 適切な template でメール送信
- 「リンクをコピー」: invite_url をクリップボードへ (mail が届かなかった場合の fallback)
- 「取消」: revoke RPC

### 1.2 family 招待発行ページ
**file (新規)**: `src/app/(main)/family/members/invite/page.tsx`

UI は org とほぼ同じ。違い:
- 役割選択は不要 (常に 'adult')
- 「子供を追加 (アカウント無)」は別ボタンで `/family/members/child/new` へ遷移

---

## 2. 招待受領 (`/invite/[token]`)

### 2.1 ページ構造
**file (新規)**: `src/app/invite/[token]/page.tsx`

server component で token validate → 状態によって 5 パターンに分岐:

#### パターン A: pending + 未ログイン
```
┌────────────────────────────────────┐
│  ほめゴハン 招待                    │
├────────────────────────────────────┤
│  山田家の田中花子 様が             │
│  あなたを「山田家」家族グループに   │
│  招待しています                     │
│                                    │
│  この招待を承諾するには、ログインか │
│  アカウント作成が必要です           │
│                                    │
│  [ログインする] [アカウントを作成] │
│                                    │
│  期限: 2026-05-24 まで             │
└────────────────────────────────────┘
```

ログイン/signup 後 自動 redirect で `/invite/{token}?from=auth` へ戻り、パターン B に遷移。

#### パターン B: pending + ログイン中 + email 一致
```
┌────────────────────────────────────┐
│  山田家への招待                     │
├────────────────────────────────────┤
│  田中花子 様から「山田家」家族      │
│  グループへの招待が届いています     │
│                                    │
│  あなたが家族に共有する情報を選択:  │
│  ☑ 食事記録 (献立・食べたもの)     │
│  ☐ 健康記録 (体重・血圧)           │
│  ☑ 週間献立                        │
│  (後で変更できます)                │
│                                    │
│  [承諾する] [拒否する] [後で]      │
│                                    │
│  期限: 2026-05-24 まで             │
└────────────────────────────────────┘
```

「承諾する」→ POST `/api/family/invites/{token}/accept` → 成功で `/family/dashboard` へ。

#### パターン C: pending + ログイン中 + email 不一致
```
┌────────────────────────────────────┐
│  この招待は他の方宛てです           │
├────────────────────────────────────┤
│  招待先: alice@a.com               │
│  あなた: bob@b.com                 │
│                                    │
│  正しいアカウントでログインし直す: │
│  [ログアウトしてやり直す]           │
└────────────────────────────────────┘
```

#### パターン D: expired / accepted / rejected / revoked
```
┌────────────────────────────────────┐
│  招待は無効です                     │
├────────────────────────────────────┤
│  この招待は {expired/承諾済/拒否済/│
│  取り消し済} です                  │
│                                    │
│  招待者に再発行を依頼してください  │
│  [ホームへ戻る]                    │
└────────────────────────────────────┘
```

#### パターン E: 競合検出 (既に他組織/家族に所属)
```
┌────────────────────────────────────┐
│  既に他の家族グループに所属         │
├────────────────────────────────────┤
│  あなたは現在「○○家」家族グループに │
│  所属しています                     │
│                                    │
│  新しい家族に参加するには、現在の  │
│  家族から脱退する必要があります    │
│                                    │
│  [脱退して新グループに参加]         │
│  [今回は招待を拒否]                 │
└────────────────────────────────────┘
```

### 2.2 共通レイアウト component
**file**: `src/components/membership/InviteLayout.tsx`

```tsx
export function InviteLayout({ scope, children }: { scope: 'organization'|'family'; children: ReactNode }) {
  // ヘッダ: 「ほめゴハン 招待」+ 戻るボタン
  // フッタ: 不正利用報告先 (support@homegohan.app)
}
```

---

## 3. メンバ管理 UI

### 3.1 organization メンバ一覧
**file (新規)**: `src/app/(org)/org/members/page.tsx`

```
┌──────────────────────────────────────────┐
│ 組織メンバー (5/30)                       │
├──────────────────────────────────────────┤
│ 田中花子   オーナー   2026-01-15        │
│           ─                             │
│ 鈴木一郎   管理者     2026-02-20        │
│           [操作 ▼]                       │
│             ・役割を変更                 │
│             ・組織から外す               │
│ 佐藤次郎   メンバー   2026-03-10        │
│           [操作 ▼]                       │
│ ...                                      │
│                                          │
│  + 新しいメンバーを招待                  │
└──────────────────────────────────────────┘
```

### 3.2 family メンバ一覧
**file (新規)**: `src/app/(main)/family/members/page.tsx`

```
┌──────────────────────────────────────────┐
│ 山田家 (4/4 人)                           │
├──────────────────────────────────────────┤
│ 👩 山田花子 (代表)                       │
│    cooks_main, lives_with                │
│    2026-01-15 〜                         │
│                                          │
│ 👨 山田太郎 (大人)                       │
│    lives_with                            │
│    [操作 ▼]                              │
│                                          │
│ 👦 山田一郎 (子供 - アカウント有)        │
│    11歳, アレルギー: なし                │
│    [操作 ▼]                              │
│                                          │
│ 👧 山田次郎 (子供 - アカウント無)        │
│    7歳                                   │
│    [操作 ▼]                              │
│                                          │
│  + 大人メンバーを招待                     │
│  + 子供を追加 (アカウント無)             │
└──────────────────────────────────────────┘
```

「操作」menu items:
- 「役割を変更」(adult/child 切替、representative は譲渡 UI へ)
- 「家族から外す」(代表は除名不可)
- 「アカウントを発行する」(child for child without auth)

---

## 4. ★ ビュー切替 (献立画面)

### 4.1 配置 (堀さん指定の赤枠位置)
**file**: `src/app/(main)/menus/weekly/page.tsx` (既存、修正)

```
┌──────────────────────────────────────────┐
│ 📅 献立表           📊  🧊  🛒          │
│ 5/10 - 5/16                              │
│ 🍳 自炊率 0%  🔥 平均 0kcal/日           │
│                                          │
│ ┌──────────────────────────────────────┐ │ ← 新規追加 view switcher
│ │ 👥 家族全員 ▼  🟥👩 🟩👨 🟨👦 🟪👧 │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ▼ 2026年5月                              │
│ 10 11 12 13 14 15 16                     │
│ 日 月 火 水 木 金 土                     │
└──────────────────────────────────────────┘
```

**条件**: 家族グループに所属していない user は switcher 非表示 (既存単独 UI 維持)。

### 4.2 component
**file (新規)**: `src/components/membership/FamilyViewSwitcher.tsx`

```tsx
type FamilyViewState = {
  preset: 'self' | 'self_partner' | 'self_children' | 'children_only' | 'all' | 'custom';
  visible_member_ids: string[];  // family_member.id の配列
};

export function FamilyViewSwitcher({
  familyMembers,
  value,
  onChange,
}: {
  familyMembers: FamilyMember[];
  value: FamilyViewState;
  onChange: (next: FamilyViewState) => void;
}) {
  // チップ表示 + bottom sheet
}
```

state は localStorage に永続化 (`familyViewState_${familyId}`)。`useFamilyView` hook で管理。

### 4.3 bottom sheet
```
┌──────────────────────────────────────┐
│  表示するメンバー                ✕   │
├──────────────────────────────────────┤
│  プリセット                          │
│  ○ 自分だけ                          │
│  ○ 自分 + 配偶者                     │
│  ○ 自分 + 子供                       │
│  ○ 子供だけ                          │
│  ● 家族全員                          │
│  ○ カスタム…                         │
├──────────────────────────────────────┤
│  メンバー個別選択                    │
│  🟥👩 山田花子 (代表) ☑              │
│  🟩👨 山田太郎       ☑              │
│  🟨👦 山田一郎       ☑              │
│  🟪👧 山田次郎       ☑              │
└──────────────────────────────────────┘
```

プリセット選択時、対応する member_ids が自動で全選択/解除される。「カスタム…」は個別チェックボックスを編集すると自動的にこのプリセットに切替。

---

## 5. 献立スロット mix 表示

### 5.1 既存スロット拡張
**file**: `src/app/(main)/menus/weekly/_components/DayCard.tsx` (既存修正)

```
─── 朝食 ───────────────────────────
🟥👩 山田花子  おにぎり (鮭)   430kcal  6:30  ┐
🟩👨 山田太郎  おにぎり (鮭)   430kcal  6:30  │
🟨👦 山田一郎  おにぎり (鮭)   430kcal  6:30  │ 同じ食事 (4人)
🟪👧 山田次郎  おにぎり (鮭)   430kcal  6:30  ┘
                          🔗 4人で共有  [全員に反映 ▼]

🟥👩 山田花子  コーヒー         5kcal  7:00
🟨👦 山田一郎  バナナ          90kcal  7:15

[+ 朝食を追加]
─────────────────────────────────────
```

### 5.2 component
**file (新規)**: `src/components/membership/MealRow.tsx`

```tsx
export function MealRow({ meal, ownerMember, isPasteGrouped }: { meal: Meal; ownerMember: FamilyMember; isPasteGrouped: boolean }) {
  // owner の avatar (色付き) + 表示名 + meal data
  // 行末に [ペースト先追加] / [編集] / [削除] kebab menu
}

export function PasteGroupedMealRows({ meals, members, group_id }: { meals: Meal[]; members: FamilyMember[]; group_id: string }) {
  // 縦並び罫線 + フッタ「🔗 N人で共有」+ [全員に反映] ボタン
}
```

レンダリング順序:
1. paste_group_id 別にグルーピング
2. 各グループ内は時刻昇順
3. 個別 meal は時刻昇順で混在
4. ビュー切替で visible_member_ids にない owner の meal は非表示 (グループ内全員が非表示なら group ごと非表示)

---

## 6. ペースト UI

### 6.1 既存 meal の操作 sheet
**file (新規)**: `src/components/membership/MealActionSheet.tsx`

長押しまたは meal 行 kebab menu から開く action sheet:
```
┌────────────────────────────┐
│  おにぎり (鮭)              │
│  430kcal · 6:30             │
├────────────────────────────┤
│  📋 家族にもペースト         │
│  ✏️ 編集                    │
│  🗑 削除                    │
└────────────────────────────┘
```

### 6.2 ペースト先選択モーダル
**file (新規)**: `src/components/membership/PasteTargetModal.tsx`

```
┌────────────────────────────────────┐
│  ペースト先を選んでください    ✕    │
├────────────────────────────────────┤
│  ☐ 山田太郎 (大人)                 │
│  ☐ 山田一郎 (子供)                 │
│  ☑ 山田次郎 (子供)                 │
│                                    │
│  [選択してペースト]                │
└────────────────────────────────────┘
```

成功後、献立画面の同スロットに新しい行が即時追加され、🔗 アイコン付きで paste_group が表示される。

### 6.3 「全員に反映」 (paste_group 内 bulk edit)
paste_group_id を持つ複数 meal を bulk update する API:
```
PATCH /api/meals/paste-group/{paste_group_id}
       body: { name?, calories?, ... }
```
全 row を一括更新。ただし「他人の meal を編集する」ので, server で「caller が paste 元の owner であること」を要検証。

---

## 7. 共有設定 UI

### 7.1 個人設定画面に section 追加
**file (新規)**: `src/app/(main)/settings/membership/page.tsx`

```
┌──────────────────────────────────────────┐
│ メンバシップ設定                          │
├──────────────────────────────────────────┤
│ 所属組織                                 │
│   なし   [組織を作成・参加]              │
├──────────────────────────────────────────┤
│ 所属家族                                 │
│   山田家 (大人)                          │
│   [家族を表示] [家族から脱退]            │
├──────────────────────────────────────────┤
│ 家族への共有設定                         │
│   ☑ 食事記録を家族に見せる              │
│   ☐ 健康記録を家族に見せる              │
│   ☑ 週間献立を家族に見せる              │
└──────────────────────────────────────────┘
```

トグル変更で即時 PATCH。

---

## 8. 子供メンバ追加 UI
**file (新規)**: `src/app/(main)/family/members/child/new/page.tsx`

```
┌──────────────────────────────────────────┐
│ 子供を追加                                │
├──────────────────────────────────────────┤
│ 名前 (家族での呼称)  [_______________]   │
│ 年齢                 [__] 歳             │
│ 性別                 [男 ▼]               │
│ アレルギー           [小麦, 卵_______]   │
│ アバター色           [🎨選択]             │
│                                          │
│ ※ 子供本人のアカウントは作成しません    │
│   親が代わりに食事記録を管理します      │
│                                          │
│            [追加する]                     │
└──────────────────────────────────────────┘
```

将来 (子供成長時) → 「アカウントを発行する」で 9 章に遷移。

---

## 9. 子供 → 実 user promote UI
**file (新規)**: `src/app/(main)/family/members/[id]/promote/page.tsx`

```
┌──────────────────────────────────────────┐
│ 山田一郎にアカウントを発行                │
├──────────────────────────────────────────┤
│ 子供メンバーが自分のアカウントで         │
│ ほめゴハンを使えるようになります         │
│                                          │
│ メールアドレス [______________________]  │
│ パスワード     [______________________]  │
│                                          │
│ ※ アカウント作成後、過去の食事記録は    │
│   山田一郎のアカウントに引き継がれます  │
│                                          │
│            [アカウントを発行]             │
└──────────────────────────────────────────┘
```

---

## 10. 譲渡 UI

### 10.1 organization owner 譲渡
**file (新規)**: `src/app/(org)/org/settings/owner-transfer/page.tsx`

```
┌──────────────────────────────────────────┐
│ オーナーを譲渡                            │
├──────────────────────────────────────────┤
│ 新しいオーナー候補を選んでください       │
│                                          │
│ ○ 鈴木一郎 (管理者) — 2026-02-20 加入  │
│ ○ 佐藤次郎 (管理者) — 2026-03-10 加入  │
│                                          │
│ 譲渡後あなたの役割: 管理者               │
│                                          │
│ 候補者には承諾依頼メールが送信されます  │
│                                          │
│            [譲渡を提案]                   │
└──────────────────────────────────────────┘
```

提案後は対象者に通知メール + アプリ内通知。対象者が `/org/transfer-accept/{proposal_id}` で承諾。

### 10.2 family 代表者譲渡
同パターン (`/family/representative-transfer`)。

---

## 11. デザイン要素

### 11.1 アバター色 (family)
固定パレット (登録順に自動割当):
```
#FF6B6B (赤)   - メンバ 1
#51CF66 (緑)   - メンバ 2
#FAB005 (黄)   - メンバ 3
#845EF7 (紫)   - メンバ 4
#22B8CF (青)   - メンバ 5
#FF8787 (桃)   - メンバ 6
#94D82D (黄緑) - メンバ 7
#FFA94D (橙)   - メンバ 8
```

設定画面で個別変更可 (color picker)。`family_members.avatar_color` に保存。

### 11.2 アバターアイコン
- 初期 (P0): 絵文字 (👩👨👦👧👶👴👵🐶🐈) を child_profile or relationship から自動推定
- 将来: ユーザアップロード (Supabase Storage)

### 11.3 メンバの表示名解決優先順位
1. `family_members.display_name` (設定済なら)
2. `user_profiles.nickname` (家族メンバなら)
3. `auth.users.email` の local part
4. 「ゲスト」(fallback)

---

## 12. 既存 UI への影響範囲

### 12.1 修正必要箇所
| file | 修正内容 |
|---|---|
| `src/app/(main)/menus/weekly/page.tsx` | view switcher 配置, mix 表示対応 |
| `src/app/(main)/menus/weekly/_components/DayCard.tsx` | MealRow / PasteGroupedMealRows 採用 |
| `src/app/(org)/org/invites/page.tsx` | revoke / 履歴表示 / 受領状況追加 |
| `src/app/(main)/settings/page.tsx` | 「メンバシップ設定」リンク追加 |
| `src/middleware.ts` | `/invite/[token]` を public route に追加 (signup 前でもアクセス可) |
| `src/lib/auth/helpers.ts` | family_id ベースの認可ヘルパー追加 |

### 12.2 新規追加箇所
| file | 役割 |
|---|---|
| `src/app/invite/[token]/page.tsx` | 招待受領ページ (org/family 共通) |
| `src/app/(main)/family/dashboard/page.tsx` | family ダッシュボード |
| `src/app/(main)/family/members/page.tsx` | family メンバ一覧 |
| `src/app/(main)/family/members/[id]/page.tsx` | family メンバ詳細 |
| `src/app/(main)/family/members/invite/page.tsx` | family 招待発行 |
| `src/app/(main)/family/members/child/new/page.tsx` | 子供追加 |
| `src/app/(main)/family/members/[id]/promote/page.tsx` | 子供 promote |
| `src/app/(main)/family/representative-transfer/page.tsx` | 代表譲渡 |
| `src/app/(main)/family/setup/page.tsx` | family 新規作成 |
| `src/app/(main)/settings/membership/page.tsx` | 共有設定 |
| `src/app/(org)/org/members/page.tsx` | org メンバ一覧 |
| `src/app/(org)/org/settings/owner-transfer/page.tsx` | org owner 譲渡 |
| `src/app/(org)/org/transfer-accept/[proposal_id]/page.tsx` | 譲渡承諾 |
| `src/app/(operator)/operator/membership/...` | 運営 UI (05-operator-emergency-ui.md 参照) |
