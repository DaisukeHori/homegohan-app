# membership ドメイン 設計概要

このディレクトリは、**既存ユーザーを組織 (organization) または家族 (family) の一員として組み込む / 外す / 役割を変える** 一連のメンバシップ管理フローの canonical 設計書です。

org/ や family/ 既存設計書と本ディレクトリの記述が矛盾した場合、**本ディレクトリの内容が優先** (canonical) します。

---

## 1. 設計原則 (絶対遵守)

### 1.1 コードファースト ("ルールはコードで書く")
自然言語による API 仕様記述は曖昧なため使用しない。**型と Zod スキーマで定義する**。

- **DB 型**: `supabase gen types typescript` で生成された `src/types/database.types.ts` を全コードで使う
- **API I/O**: `src/schemas/membership/*.ts` の Zod スキーマで定義
- **AI が `as any` を書いたら不合格**。型が合わなければコンパイル不可
- 本設計書のサンプルコードはそのまま実装に転写可能な程度の精度で書く

### 1.2 データ ownership 原則 (Option E)
- `meals` / `health_records` / `menu_drafts` 等のレコードは **常に単一の `user_id` に帰属**
- 家族メンバ間でレコードを「共有」するのではなく、**閲覧権限の grant + 物理コピー (paste)** で実現
- 離婚/家族解散時にデータ整合性が破綻しない

### 1.3 単一所属原則
- 1 user は 1 organization までに所属 (UNIQUE 制約)
- 1 user は 1 family までに所属 (UNIQUE 制約)
- 切替は「現所属を脱退 → 新所属に加入」の連続操作

### 1.4 役割モデル
| ドメイン | 役割 |
|---|---|
| organization | `owner` (1 名) / `admin` (N 名) / `member` (N 名) |
| family | `representative` (代表 1 名) / `adult` (N 名) / `child` (N 名) |

階層は機能的には 2 段 (org: owner+admin / member、family: 代表+大人 / 子)。代表/owner は契約上の名義で、大人/admin は対等な運営権を持つ。

### 1.5 不変条件 (DB 制約として表現)
- `organizations.owner_id` は常に NOT NULL かつその user は `org_role='owner'` を持つ
- `family_groups.representative_id` は常に NOT NULL かつ対応する `family_members.role='representative'` 行が存在
- `family_members.user_id` は (NOT NULL のとき) UNIQUE
- `meals.user_id` は NOT NULL

---

## 2. ドキュメント構成

| ファイル | 内容 |
|---|---|
| `00-overview.md` | 本ファイル。原則 + 全体像 |
| `01-data-model.md` | **DDL + RLS + Zod スキーマ + 型生成手順** (canonical schema) |
| `02-flow-spec.md` | 招待 / 受諾 / 拒否 / 解除 / 譲渡 / 緊急介入 の全フロー (state machine) |
| `03-ui-spec.md` | ビュー切替 / ペースト / 閲覧権限設定 / メンバ管理画面 の wireframe + コンポーネント |
| `04-email-templates.md` | Resend 招待メール 3 種テンプレート + 件名/本文 + 変数定義 |
| `05-operator-emergency-ui.md` | 運営管理者 緊急介入 UI (代表不在時の譲渡/解散) |
| `06-implementation-phases.md` | P0-P7 タスク分解 + 並列起動可否 + 依存関係 |

---

## 3. 用語定義 (glossary)

| 日本語 | 英語/識別子 | 意味 |
|---|---|---|
| 代表 | `representative` | family の契約名義人。1 family につき 1 名 |
| 大人 | `adult` | family の運営権を持つメンバ (代表含む) |
| 子 | `child` | family の被保護メンバ。auth account 有/無 両対応 |
| オーナー | `owner` | organization の契約名義人。1 org につき 1 名 |
| 管理者 | `admin` | organization の運営権を持つメンバ (owner 含まず) |
| メンバー | `member` | organization の通常メンバ |
| 招待 | `invite` | email + token を発行して既存/新規ユーザを呼び込む行為 |
| 承諾 | `accept` | 招待 token を消化して membership を確立する操作 |
| 拒否 | `reject` | 招待 token を放棄する操作 |
| 脱退 | `leave` | メンバ自身が membership を解消する操作 |
| 除名 | `remove` | 代表/owner/admin が他メンバの membership を解消する操作 |
| 譲渡 | `transfer` | 代表/owner を別の adult/admin に移す操作 |
| 強制譲渡 | `operator_force_transfer` | 運営管理者が代表/owner 不在時に譲渡を強制する操作 |
| ペースト | `paste` | 自分の食事レコードを家族メンバの user_id にコピーする操作 |
| ペーストグループ | `paste_group_id` | 同時ペーストされた複数 meals を関連づける UUID |
| 閲覧権限 | `share_*` | 家族メンバごとの「自分のデータをどこまで家族に見せるか」設定 |

---

## 4. バージョン

- 初版: 2026-05-10
- 著者: Claude Opus 4.7 (1M context) / 監修: 堀大輔
- 関連設計書: `docs/design/family/`, `docs/design/org/`, `docs/design/operator/`
