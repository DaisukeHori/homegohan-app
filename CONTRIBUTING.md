# Contributing Guide

homegohan monorepo への貢献ガイドです。

---

## 目次

- [環境変数セットアップ](#環境変数セットアップ)
- [ローカルテスト実走手順](#ローカルテスト実走手順)
- [PR 開発ワークフロー](#pr-開発ワークフロー)
- [テストブロッカー方針](#テストブロッカー方針)

---

## 環境変数セットアップ

プロジェクトルートに `.env.local` を作成します (`git` にはコミットしないこと)。

詳細な取得手順は [ENV_SETUP.md](./ENV_SETUP.md) を参照してください。

### 必須キー一覧

```env
# Supabase (Web / API Routes)
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# E2E テストユーザー (Playwright / Maestro)
E2E_USER_EMAIL=<test-user@example.com>
E2E_USER_PASSWORD=<password>

# AI
XAI_API_KEY=<xai-key>
GOOGLE_AI_STUDIO_API_KEY=<google-ai-key>
OPENAI_API_KEY=<openai-key>

# Cron 認証
CRON_SECRET=<random-32-chars>
```

### インテグレーションテスト追加キー

インテグレーションテスト (`tests/integration/`) の接続先は **ローカルの Supabase スタック** です。本番や共有の Supabase には向けないでください。

必要な変数 (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_INTEGRATION_TEST=1` など) は、
`bash scripts/supabase-local.sh env .env.local` がローカルスタックの値で `.env.local` に書き出します。
手順は下の「Vitest — インテグレーションテスト」を参照してください。

### モバイル (Expo)

`apps/mobile/.env.local` または `apps/mobile/env.example` を参考に設定します。  
`EXPO_PUBLIC_` プレフィクスはクライアントバンドルに含まれるため、秘密情報を入れないでください。

```env
EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000
```

---

## ローカルテスト実走手順

### ローカル CI — PR の検査をまとめて回す (`scripts/local-ci.sh`)

GitHub Actions の PR 検査のうち、本番に触れない 4 本と security.yml の gitleaks (シークレットの検査) を、CI と同じ条件でローカルで回し、件数で緑 / 赤を判定します。

| 段 | CI 上の正本 | 中身 |
|---|---|---|
| `secrets` | `.github/workflows/security.yml` の `gitleaks` ジョブ | 同じ版・同じ SHA-256 の gitleaks で、`--base` から HEAD までのコミット (PR で増えるコミット) を `.gitleaks.toml` で検査する (`--redact`。値はログに出さない)。配布物は初回だけ GitHub から取得し、`LOCAL_CI_TOOLS` に置いて毎回 SHA-256 を確かめる |
| `unit` | `.github/workflows/ci.yml` | `npm run typecheck` → `npm run lint` → `npm test` (vitest) |
| `mobile` | `.github/workflows/mobile-test.yml` | `apps/mobile` の jest (`--ci --coverage`) → `packages/core` の vitest |
| `integration` | `.github/workflows/security-regression.yml` | ローカル Supabase + `next dev` に対する結合テスト 2 本 (2 本目の運営コンソールは 1 本目が落ちても回す) |
| `e2e` | `.github/workflows/e2e-local.yml` | ローカル Supabase + 本番ビルド (`next build` / `next start`) に対する Playwright。規約の同意ゲート (#1174) は、同じビルドを既定 (3000)・`LEGAL_CONSENT_ENFORCE=on` (3001)・`LEGAL_CONSENT_NOTICE=on` (3002) の 3 つのサーバーで確かめる |

```bash
bash scripts/local-ci.sh                          # 5 段すべて (origin/main を取り込んだ状態で検査)
bash scripts/local-ci.sh --only secrets,unit,mobile  # Docker を使わない 3 段だけ
bash scripts/local-ci.sh --base origin/main       # 取り込む基準を指定 (既定 origin/main)
bash scripts/local-ci.sh --no-merge               # マージせず HEAD そのもの (main の上で回すとき)
bash scripts/local-ci.sh --keep                   # 作業用の worktree を残す (調べるとき)
```

**前提**

- Node は `.nvmrc` の major (22)。違う版だと赤で止まり、入れ方を表示します (`nvm install 22 && nvm use 22` など)。
- `integration` / `e2e` は Docker が要ります。ローカル Supabase は段ごとに `scripts/supabase-local.sh` で起動・停止します。
- `integration` / `e2e` の前に、ポート 3000 (`e2e` は 3001・3002 も) とローカル Supabase のポート (54320〜54329) が空いているかを確かめます (他のプロセスやコンテナは止めません)。ポートは枠 0 の値で、枠 1 以上では下の「同時に複数回す (枠)」のとおりずれます。枠を取ったときにそのポートを `local-ci.sh` 以外 (開発用の `npm run dev`・手で起動したローカル Supabase・macOS の常駐など) が使っていれば、その枠を外して次の候補の枠を使います。候補の枠のどれもポートを使われていて、ほかの `local-ci.sh` が持っている枠も無い (待っても空く見込みが無い) ときは、待たずに表に `slot:ports` の行 (使用中のポート) を出して赤 (終了コード 1) で止まります。使っているものを止めるか、`LOCAL_CI_SLOTS` に別の枠を足して回し直してください。

**同時に複数回す (枠)**

`integration` / `e2e` はローカル Supabase と Next を立てるため、そのままでは同じ機械で 1 本ずつしか回せません。**枠 (slot)** ごとにコンテナ名 (`project_id`) と全ポートをずらし、空いている枠を取った `local-ci.sh` から順に回します。

```bash
LOCAL_CI_SLOTS='0 1' bash scripts/local-ci.sh     # 枠 0 と 1 を使ってよい (2 本まで同時に回る。3 本目は空くまで待つ)
LOCAL_CI_SLOT=1 bash scripts/local-ci.sh          # 枠 1 だけを使う (空くまで待つ)
```

| 枠 | `project_id` (コンテナ・ボリューム名の元) | ローカル Supabase のポート | Next のポート (既定 / 同意の強制あり / お知らせあり) |
|---|---|---|---|
| 0 (既定。CI と同じ) | `homegohan-local` | 54320〜54329 (CLI の既定: API 54321・DB 54322 など) | 3000 / 3001 / 3002 |
| n (1〜9) | `homegohan-local-s<n>` | 0 の値 + n × 100 (例: 枠 1 は API 54421・DB 54422) | 3100 + n × 10 からの 3 つ (例: 枠 1 は 3110 / 3111 / 3112、枠 3 は 3130 / 3131 / 3132) |

- 値の表の正本は `scripts/lib/local-ci-slot.sh` です (`bash scripts/lib/local-ci-slot.sh 1` で枠 1 の値を表示)。`tests/local-ci-slot.test.ts` が、枠 0 が今までの値のままであることと、枠どうしで重ならないこと、macOS が既定で使うポート (Apple の [TCP and UDP ports used by Apple software products](https://support.apple.com/en-us/103229) の表) と重ならないことを確かめます。
- 枠 1 以上の Next のポートを枠 0 (3000 台の頭) と別の帯 (3100 台) に置くのは、macOS の既定のポートを避けるためです。以前の「0 の値 + n × 10」では枠 3 の 2 つ目が 3031 になり、Remote Apple Events (eppc) の待ち受け (launchd が持つ) と重なって、枠 3 の `e2e` が毎回「使用中のポート 3031」で赤になっていました。
- CI の yml は `scripts/supabase-local.sh` を枠を指定せずに呼ぶので、枠 0 (今までと同じ `config.toml`) で動きます。
- 手で `LOCAL_CI_SLOT=1 bash scripts/supabase-local.sh start` のようにも使えます。作業ディレクトリは枠ごとに分かれます (枠 0 は今までどおり `.supabase-local/`、枠 n は `.supabase-local-s<n>/`)。`stop` / `status` / `env` は組み立て直さずにその枠の作業ディレクトリを使うので、**起動したときと同じ `LOCAL_CI_SLOT` を付けて**打ちます (作業ディレクトリの `config.toml` が別の枠のものなら、何もせずに止まります)。手で使うときは枠のロックを取らないので、同時に回る `local-ci.sh` の `LOCAL_CI_SLOTS` に入っていない枠を使ってください。
- 枠は `integration` / `e2e` の直前に取り、終わったら (Ctrl-C や途中の失敗でも) 外します。`secrets` / `unit` / `mobile` だけなら取りません。ロックは `LOCAL_CI_LOCK_DIR` (既定 `${TMPDIR:-/tmp}/homegohan-local-ci-locks`) の下の `slot-<n>/` で、持ち主の pid と開始時刻を `owner` に書きます。持ち主が生きているか確かめられないとき (`ps` が動かないなど) は生きているとみなします。持ち主のプロセスが死んでいれば次の実行が回収し、**回収したときに限り**、その枠に残ったコンテナ・ボリュームも片付けます (枠 1 以上だけ。枠 0 は枠を使わない作業と共有しているので止めません)。回収していない (空いていた) 枠に、その枠の `project_id` のコンテナやボリュームがあれば (ロックを取らずに手で起動したスタックなど)、消さずに `integration:setup` / `e2e:setup` を赤にして止まります。
- 持ち主の死んだロックの回収と、自分のロックを外すことは、見張り (`slot-<n>.reclaim`。持ち主の pid と開始時刻を書いたファイル) を取った 1 本だけが行います (同時に始めた 2 本が同じ死んだロックを回収しても、枠を持つのは 1 本だけ)。見張りは一瞬 (数十ミリ秒) しか持ちません。シグナル (Ctrl-C の INT・TERM・端末を閉じたときの HUP) で止めたときは、どの時点で止めても見張りを外してから終わります (見張りを作ってから記録するまで・消してから記録を消すまでのあいだに届いたシグナルは、その区間を出てから終了に使います)。外す機会の無い終わり方 (`kill -9`・電源断など) で回収かロックを外す途中に終わったときだけ、持ち主の死んだ見張りが残ります。それは 2 本が同時に回収に入らないよう自動では消さず、表示で知らせます (そのあいだ、その枠に持ち主の死んだロックがあっても回収できないので、ほかの枠を使うか、待ちの時間切れになります)。ほかに `local-ci.sh` が動いていないことを確かめてから、表示されたパスを `rm -rf` で消してください。
- 空いている枠が無ければ `LOCAL_CI_SLOT_WAIT_SECONDS` (既定 5400 秒 = 90 分) まで 10 秒おきに待ちます。過ぎたら表に `slot:wait` の行 (「待ちの時間切れ」) を出し、**終了コード 3** で終わります (検査の失敗の 1 とは別。ほかの段が赤なら 1)。
- 片付けは自分の枠のものだけです (`supabase-local.sh stop` はその枠の作業ディレクトリの `project_id` のコンテナ・ボリュームだけを消し、Next は自分が起動したプロセスだけを止める)。
- テストやヘルパーでアプリ・ローカル Supabase の URL を決めるときは、`local-ci.sh` が枠の値を入れる環境変数 (integration はアプリの `INTEGRATION_BASE_URL`、e2e は `PLAYWRIGHT_BASE_URL` か Playwright の `baseURL`、Supabase は `scripts/supabase-local.sh env` が書く `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL`) を最初に読み、ポート付きの `http://localhost:3000` などは `??` / `||` の右 (変数が無いときの既定値) にだけ書きます。決め打ちすると、枠 1 以上で回したときに枠 0 のサーバー (別の実行のもの) に繋がります。`tests/local-ci-slot-consumers.test.ts` が、e2e・integration のテストとヘルパー (Playwright の設定・Maestro のスクリプトを含む) と `scripts/` のシェルを検査します。
- `scripts/baseline/drift_report.sh` も `LOCAL_CI_SLOT` の枠の DB に繋ぎ、結果の既定の置き場もその枠の作業ディレクトリ (`.supabase-local-s<n>/drift`) にします。スタックを起動したときと同じ `LOCAL_CI_SLOT` を付けて打ちます。
- 同じ HEAD を同時に回すと結果の置き場 (既定は HEAD の sha ごと) が重なるので、既定のときは `<sha>.<pid>` に替えます。`LOCAL_CI_ARTIFACTS` を指定したときは、使用中なら止まります (実行ごとに別の場所を指定してください)。

**資源の目安**: 1 枠でローカル Supabase 一式 (studio などを除く 8 コンテナ) が Docker のメモリを約 1 GiB 使います (2026-10-10 の実測。`LOCAL_CI_SLOT_MEMORY_MIB` の既定 1536 MiB は余裕を足した値)。Next のサーバーと Playwright は Docker の外 (ホスト) で動き、`e2e` の `next build` はホストの CPU とメモリを多く使います。枠を取る前に Docker の空きメモリがこの目安より少なければ警告します (止めません)。Docker Desktop の VM のメモリが 8 GiB 程度なら 2〜3 枠が目安です。

**外側のロックとの関係 (移行期間)**: 枠を使わずに既定のポート (枠 0 と同じ) で動く作業が、別のロック (例: Workflow の `mkdir` のロック) で 1 本ずつに並んでいる場合は、`LOCAL_CI_LEGACY_LOCK` にそのパスを渡します。枠 0 を使う前に、そのパスが無いことも確かめます (あれば枠 0 は使用中として扱い、ほかの枠か空くのを待ちます)。既定は空 (確かめない) です。すべての作業が枠で回るようになれば要りません。

**CI と揃えている条件** (ずれると「ローカルは緑・CI は赤」になる)

- 検査するのは **コミット済みの HEAD に `--base` をマージした状態** (CI の `pull_request` が PR と main のマージコミットを検査するのと同じ)。未コミットの変更は検査に入りません (警告を出して続けます)。衝突したら赤で止まります。
- 毎回 **まっさらな git worktree** を作り、`npm ci` をやり直します (使い回すと `.next/types` など CI に無い生成物まで型検査してしまうため)。終わったら worktree は消します。
- `TZ=UTC` (CI のランナーは UTC)・`CI=true`・`LANG=C.UTF-8`・`NODE_OPTIONS` なし (ヒープを盛ると CI のメモリ不足を隠すため)。
- 親シェルの環境変数は持ち込みません (`PATH`・`HOME`・Docker / プロキシの設定など、動かすのに要るものだけを残す)。シェルに入っている本番の接続先などは混ざりません (新しい worktree には `.env.local` もありません)。`SUPABASE_ACCESS_TOKEN` などは最初に外します。
- コマンド・対象パス・環境変数は 4 つの yml と security.yml の gitleaks ジョブから写しています。yml を変えてスクリプトを直し忘れると、`tests/local-ci-workflow-sync.test.ts` が PR の `npm test` で落ちます。照合は yml ごとに対応する段の関数 (`stage_unit` など) の中だけで行い、yml のコマンドがスクリプトの 1 つのコマンドの先頭に同じ引数の並びで現れるか (後ろに足してよいのは結果を JSON で出す引数だけ)、作業ディレクトリ・環境変数 (ステップ / ジョブ / ワークフロー) が同じかまで比べます。テストが知らないアクション・キー・`if` の条件が yml に増えたときも落ちるので、スクリプトに写したうえでテストの対応表に理由を付けて足してください。gitleaks は、版・SHA-256 (linux_x64)・引数・検査する範囲・効きうる環境変数を照合します。
- PR で動くワークフローはすべて、写した段 (`WORKFLOW_STAGES` / `JOB_STAGES`) か、理由つきの除外 (`EXCLUDED_WORKFLOWS`) に入っていなければなりません。ジョブ単位で写した security.yml は、ジョブごとに段か除外 (`EXCLUDED_JOBS`) に入っていなければなりません。PR で動くワークフロー・ジョブを足して、どちらにも入れないと `npm test` が落ちます。

**結果の読み方**

- 判定は終了コードだけでなく、各ツールの JSON (vitest / jest / Playwright / ESLint) の件数で行います。失敗が 1 件でもある、結果の JSON が無い・壊れている、収集されたファイルが 0、のどれかで赤です。
- 収集漏れの偽の緑を防ぐため、各段で「収集されるはずのファイル」をツール自身に数えさせ (`vitest list --filesOnly` / `jest --listTests` / `playwright test --list`)、結果のファイルと突き合わせます。食い違えば赤です。
- `it.fails` (既知の不具合) は、期待どおり失敗すれば passed、直って通ってしまうと failed として数えられます (vitest の JSON の扱いのまま)。
- 最後に段ごとの表 (passed / failed / skipped / 収集ファイル / 秒) と、**PR 本文に貼る Markdown** (検査した HEAD と `--base` の sha・マージ状態・TZ・Node の版・各段の件数) を出します。どれかが赤なら終了コード 1 です。
- JSON とログは worktree の外 (`${TMPDIR:-/tmp}/homegohan-local-ci-artifacts/<HEAD の短い sha>/`) に残ります。赤の段はログの末尾も表示します。

| 環境変数 | 意味 |
|---|---|
| `LOCAL_CI_WORKDIR` | 作業用 worktree の親 (既定 `${TMPDIR:-/tmp}/homegohan-local-ci`) |
| `LOCAL_CI_ARTIFACTS` | JSON とログの置き場 (既定は上記) |
| `LOCAL_CI_FETCH=0` | `--base` (`origin/...`) を fetch しない |
| `LOCAL_CI_SUPABASE_PORTS` | 空きを確かめるローカル Supabase のポート (空白区切り。既定は枠の値) |
| `LOCAL_CI_SLOTS` | 使ってよい枠 (空白区切り。既定 `0`)。例: `'0 1'` |
| `LOCAL_CI_SLOT` | この枠だけを使う (`LOCAL_CI_SLOTS` より優先) |
| `LOCAL_CI_LOCK_DIR` | 枠のロックの置き場 (既定 `${TMPDIR:-/tmp}/homegohan-local-ci-locks`) |
| `LOCAL_CI_SLOT_WAIT_SECONDS` | 枠の空きを待つ上限の秒数 (既定 5400)。過ぎたら終了コード 3 |
| `LOCAL_CI_LEGACY_LOCK` | 枠 0 を使う前に、無いことを確かめるパス (外側のロック。既定は空) |
| `LOCAL_CI_SLOT_MEMORY_MIB` | 1 枠の Docker のメモリの目安 (MiB。既定 1536)。空きが少なければ警告 |
| `LOCAL_CI_PLAYWRIGHT_WITH_DEPS=1` | `playwright install` に `--with-deps` を付ける (Linux で OS の依存も入れる。root 権限が要る) |
| `LOCAL_CI_TOOLS` | gitleaks の配布物の置き場 (既定 `${XDG_CACHE_HOME:-$HOME/.cache}/homegohan-local-ci`) |
| `INTEGRATION_TEST_TIMEOUT_MS` / `INTEGRATION_HOOK_TIMEOUT_MS` | 結合テストの 1 件のテスト / フックの時間切れ (ミリ秒。既定はどちらも 120000。`vitest.integration.config.ts`)。`local-ci.sh` もそのまま結合テストに渡す。個別に時間切れを書いたテストはそちらが優先 |
| `INTEGRATION_AUTH_RETRY_ATTEMPTS` / `INTEGRATION_AUTH_RETRY_BASE_DELAY_MS` | 結合テストがローカル Supabase の認証 (`/auth/v1`) のゲートウェイの一時的な失敗 (502 / 503 / 504・接続の失敗) をやり直すときの、1 回の呼び出しで送る回数 (既定 5) と最初の間隔 (ミリ秒。既定 2000。以後は倍にして 16000 で止める)。`tests/integration/helpers/auth-transient-retry.ts`。`local-ci.sh` もそのまま結合テストに渡す |

**ローカルでは再現できないもの**: migration を含む PR の Deploy Supabase Migrations の PR ジョブ (本番台帳とのドリフト検知) は本番に接続するため、このスクリプトでは回しません。security.yml の dependency review (依存を変える PR で、high 以上の既知の脆弱性がある版を入れていないか) は GitHub の Dependency graph を使うため回しません。依存を変える PR は CI のこのジョブの緑を待ってからマージします。また CI のランナーは Linux なので、OS に依存する違い (ファイル名の大文字小文字など) は残ります。

### 型チェック / Lint

```bash
npm run typecheck
npm run lint
```

### Vitest — ユニットテスト

```bash
npm run test
```

`tests/` 配下の `.test.ts` / `.spec.ts` を実行します (`tests/e2e/` は除外)。

### Vitest — インテグレーションテスト

`tests/integration/` のテストは、**ローカルの Supabase スタック** と **ローカルの Next dev サーバ** に対して実行します。
テストはユーザーや業務データを作成・削除するため、**本番の Supabase には絶対に向けないでください**。

```bash
# 1. ローカル Supabase を起動し (初回はイメージ取得で数分)、接続情報を .env.local に書き出す
bash scripts/supabase-local.sh start
bash scripts/supabase-local.sh env .env.local

# 2. Next dev サーバを起動する (別ターミナル。既定は http://localhost:3000)
npm run dev

# 3. テストを実行する。対象のパスを渡して絞り込める (パスの部分一致)
npm run test:integration -- tests/integration/operator/admin-
npx vitest run --config vitest.integration.config.ts tests/integration/rls tests/integration/security
```

- `bash scripts/supabase-local.sh env .env.local` は `.env.local` を **上書き** します (既存のファイルは `.env.local.bak.<時刻>` に退避されます)。
  開発用に別の接続先を `.env.local` に入れている場合は、テストが終わったら退避したファイルを戻してください。
- 実行前に `.env.local` の `NEXT_PUBLIC_SUPABASE_URL` が `http://127.0.0.1:54321` であることを確認してください。
- dev サーバを別のポートで起動したときは `INTEGRATION_BASE_URL=http://localhost:3001` を付けて実行します。
- `supabase start` / `supabase db reset` をリポジトリの `supabase/` に対して直接実行しないでください。必ず `scripts/supabase-local.sh` を経由します (理由は [CLAUDE.md](./CLAUDE.md) の「ローカル / CI の Supabase」)。
  migration を追加・変更したら `bash scripts/supabase-local.sh reset` で作り直します。
- 結合テストのプロセスは、ローカル Supabase の認証 (`/auth/v1`) への要求がゲートウェイの一時的な失敗 (502 / 503 / 504・接続の失敗) になったときだけ、間を空けてやり直します (`tests/integration/setup.ts` が `tests/integration/helpers/auth-transient-retry.ts` を取り付ける)。負荷が高い機械で、beforeAll のユーザー作成・サインインが `{}` というメッセージのエラーで落ちたためです。アプリ (`next dev`) への要求・認証以外 (REST など)・認証の判定 (400 / 422 / 429 など) はやり直さず、やり尽くしたら最後の失敗をそのまま返します。
- テストは自分で作ったデータを後片付けしますが、途中で中断するとローカル DB にデータが残ることがあります。そのときは `bash scripts/supabase-local.sh reset` で戻します。
- CI では `.github/workflows/security-regression.yml` が同じ手順で `tests/integration/rls`・`tests/integration/security`・`tests/integration/handson-tour`・`tests/integration/operator` (運営コンソール API。`admin-*` / `auth-boundary` / `super-admin-*`) を実行します。
  実行するファイルは vitest に渡すパスの文字列 (部分一致) で選んでいるため、新しい結合テストを足すときは、ファイル名を既存の指定に合わせてください。どの指定にも当たらないファイルは CI で動かないので、`tests/integration-ci-coverage.test.ts` が検出して落ちます。
- 失敗が既知の不具合によるテストは `it.fails` で書いてあります (`[既知の不具合]` と題名に付く)。不具合を直したら、そのテストの `.fails` を外してください。

### Playwright — E2E テスト (Web)

```bash
# 開発サーバーを自動起動してテスト
npm run test:e2e

# MVP spec のみ高速実行 (spec 01-05)
npm run test:e2e:mvp

# 既存サーバー / ステージング環境を対象にする場合
PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e

# インタラクティブ UI モード
npm run test:e2e:ui

# 特定の spec のみ実行
npx playwright test tests/e2e/01-login.spec.ts

# レポートを UI で確認
npm run test:e2e:report
```

初回のみ Playwright ブラウザのインストールが必要です。

```bash
npm run test:e2e:install
```

### フルスイートを CI で手動実行する場合

認証必須テストを含むフルスイートは GitHub Actions の `workflow_dispatch` で実行します。

1. GitHub リポジトリの Actions タブを開く
2. `e2e` ワークフローを選択
3. "Run workflow" から `full_suite=true` を指定して実行

### Mobile — Jest ユニットテスト

```bash
cd apps/mobile && npm test
```

### Mobile — Maestro E2E テスト (iOS / Android)

Maestro CLI のインストール:

```bash
curl -Ls https://get.maestro.mobile.dev | bash
```

シミュレーター (または実機) を起動した状態で実行:

```bash
cd apps/mobile

# 全フロー
maestro test maestro/

# 特定フロー
maestro test maestro/smoke.yaml
maestro test maestro/auth-flow.yaml
```

テストユーザーのデータリセット (テスト前に推奨):

```bash
npm run test:e2e:reset-data
```

---

## PR 開発ワークフロー

### ブランチ命名

```
<type>/<short-desc>
```

`type` は Conventional Commits に準拠します。

| type | 用途 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `test` | テスト追加・修正 |
| `docs` | ドキュメント |
| `refactor` | リファクタリング |
| `chore` | その他の保守作業 |

例:

```
feat/family-09-graduation-badge
test/coverage-recovery-T01-unit
fix/e2e-login-timeout
docs/contributing-readme-refresh
```

### PR タイトル

Conventional Commits prefix + 日本語サマリ の形式にします。

```
feat(family/09): Web Step 4 卒業バッジに disclaimer 追加
fix(e2e): Playwright login spec タイムアウト修正
test(operator): super-admin integration test 拡充
```

### コミットメッセージ

Conventional Commits 形式 + 日本語サマリを使用してください。

```
feat: 新機能の概要
fix: バグ修正の概要
test: テスト追加・修正
chore: 雑務・設定変更
```

### 並列開発時の隔離

複数の実装を並列で進める場合は `git worktree` で作業ツリーを分離してください。  
同一ブランチを共有すると未コミット変更が混入する原因になります。

```bash
# worktree を追加
git worktree add ../<dir-name> -b <branch-name>

# 作業後の削除
git worktree remove ../<dir-name>
```

---

## テストブロッカー方針

PR マージ前の必須・推奨チェックは以下の通りです。

### 必須 (PR マージブロッカー)

- `npm run typecheck` — 型エラーなし
- `npm run lint` — lint エラーなし
- `npm run test` — 変更に関連するユニットテストがすべてパス

### 推奨

- `npm run test:e2e:mvp` — MVP E2E spec (02-05) がパス

> **注意**: CI (GitHub Actions) でも PR トリガーで同じ MVP スイートが自動実行されます。  
> ただし CI コスト削減のため、将来的に PR トリガーの E2E を一時停止する場合は  
> ローカル実行結果を PR 本文に貼り付けて確認を取ってください。

### 任意 (GitHub Secrets 必要)

- E2E spec 01 (login spec) — `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` が必要なため、CI の GitHub Secrets が設定されている場合のみ実行

### CI

`.github/workflows/e2e.yml` が PR で Playwright E2E を自動実行します。  
対象パス: `src/**`, `tests/e2e/**`, `playwright.config.ts`, `package.json`, `package-lock.json`。  
レポートは `playwright-report` artifact として 14 日間保持されます。
