# CI で Supabase の Docker イメージを取得できないとき (#1523)

CI のいくつかのジョブは、Supabase CLI でローカルの Supabase を起動したり (`supabase start`)、`supabase db diff` のシャドウ DB を作ったりするために、Supabase の Docker イメージを取得します。取得元の既定は Amazon ECR Public (`public.ecr.aws`) で、認証なしの取得には上限があります。GitHub のランナーは IP を多くの利用者と共有しているため、日中にこの上限 (`toomanyrequests: Data limit exceeded`) に当たり、検査の中身と関係なくジョブが赤になることがあります (2026-10-14〜15 に、security-regression・Deploy Supabase Migrations の db diff で 3 回以上)。

## 自動でしていること

| どこで | 何を |
|---|---|
| `scripts/supabase-local.sh start` (security-regression・e2e-local・`scripts/local-ci.sh`) | イメージの取得に失敗したら、取得元を `public.ecr.aws` → `ghcr.io` の順に替えてやり直す。どちらでも失敗したら、間を空けて (30 秒 × 周) 次の周に入る (既定 3 周) |
| `scripts/supabase-image-fallback.sh` (Deploy Supabase Migrations の「Verify db diff (post-apply)」・Daily Consistency Check の db diff) | 同じ。周のあとの待ちは 60 秒 × 周 |
| Deploy Supabase Functions の「Deploy all functions」(#1686) | イメージを取らない。`supabase functions deploy --use-api --import-map supabase/functions/deno.json` で、関数のまとめ (バンドル) を Supabase のサーバーにさせ、ランナーの Docker を使わない (下の「関数のデプロイ」) |
| `scripts/backup-db.mjs` (DB Backup の `backup` ジョブ。#1129) | `supabase db dump` の 3 回と stats の `docker run` を `scripts/supabase-image-fallback.sh` で包む。復元の検査 (月曜と 1 月 1 日の restore_check) と `roundtrip-check` ジョブは `scripts/supabase-local.sh start` を使うので、上の取得元の切り替えが効く |

- 取得元の切り替えには、Supabase CLI の環境変数 `SUPABASE_INTERNAL_IMAGE_REGISTRY` を使います (CLI 2.62.10 の `internal/utils/docker.go` の `GetRegistry`。`docker.io` 以外を指定すると `<取得元>/supabase/<イメージ名>:<版>` を取ります)。Supabase は同じイメージを `ghcr.io/supabase/` にも置いています (2026-10-15 に、CLI 2.62.10 と `supabase/.temp` の版で使うイメージがすべて `ghcr.io` にあることを確かめました)。
- CLI 自身も、1 回の取得の中で 2 回やり直します (4 秒・8 秒待つ)。
- やり直すのは、取得の失敗 (`toomanyrequests`・`failed to pull docker image`・接続の時間切れ) と、`supabase start` での Docker の準備待ち (`is not ready`。同じ取得元で) だけです。migration が流せない・差分の計算に失敗した、などの本物の失敗はやり直しません。
- Actions のキャッシュ (`docker save` / `docker load`) でイメージを持ち回ることはしていません。`supabase start` で取るイメージは圧縮した状態で約 1.5 GB (うち postgres が約 1 GB) あり、リポジトリのキャッシュの枠 (既定 10 GB) を npm・Playwright のキャッシュと分け合うため、追い出しが増えます。また PR のジョブが作ったキャッシュは、その PR からしか読めません。

## それでも取得できなかったとき

最後まで取得できなかったときは、次の形で出します (検査の赤と区別するため)。

- ログに `[image-pull-unavailable] <段の名前>: Supabase の Docker イメージを取得できませんでした ...` の 1 行と、`[image-pull-unavailable] 最後のエラー: ...` の 1 行。
- GitHub Actions の注記 (実行の Summary の上の Annotations) に `<段の名前>: イメージを取得できない (検査の赤ではない)` という題の error。
- Step Summary に同じ内容。
- 終了コードは 75 (`SIP_EXIT_PULL_UNAVAILABLE`。sysexits.h の EX_TEMPFAIL)。

ジョブごとの扱い:

| ジョブ | 取得できなかったとき | すること |
|---|---|---|
| security-regression | 「Start local Supabase」で赤。後ろの結合テスト (2 本目の operator を含む) は動かない | 失敗したジョブだけを流し直す (Re-run failed jobs)。検査の赤ではないので、コードは直さない。マージは緑になってから |
| e2e-local | 「Start local Supabase」で赤。後ろの手順は動かない | 同じ |
| Deploy Supabase Migrations (PR) | 「Verify db diff (post-apply)」で赤。Step Summary に「db diff を確かめられませんでした (Docker イメージの取得の失敗。検査の赤ではない)」 | 失敗したジョブだけを流し直す。migration を含む PR のマージは、この確かめが緑になってから |
| Deploy Supabase Migrations (main への push) | 同じ。赤のまま (下を参照) | 前の「Apply migrations」「Verify migration list」が success なら、本番への適用は終わっている。時間をおいて、**その時点の最新の main の run** の失敗したジョブを流し直し、db diff が緑になることを確かめる |
| Daily Consistency Check (db-drift) | Issue に「本番のスキーマとの比較 (db diff) を、Docker イメージを取得できずに確かめられませんでした」と書く | 時間をおいて、この workflow を手で実行し直す (workflow_dispatch) |
| Deploy Supabase Functions (main への push) | `--use-api` ではイメージを取らないので、ふつうは起きない。起きたら「Deploy all functions」で赤になり、`[image-pull-unavailable] Deploy all functions: ...` と終了コード 75 で出す (CLI が Docker でのまとめに戻ったということ)。後ろの削除・確認の手順は動かない | ワークフローの CLI の版と `--use-api` を確かめる。直したら、その時点の最新の main の run の失敗したジョブを流し直す (下の「関数のデプロイ」) |
| DB Backup (schedule / `workflow_dispatch` の `backup` ジョブ。#1129) | 取得の段 (stats・dump・復元の検査の `supabase-local.sh start`) で取れなかったときは、reason `image_pull_unavailable` で監査行 (`backup.<層>.failed`) と Issue「【自動】DB バックアップの失敗」が残る。`roundtrip-check` ジョブ (PR / `workflow_dispatch`) は「Roundtrip (local)」で赤になる | 時間をおいて `workflow_dispatch` で取り直す (`roundtrip-check` は失敗したジョブだけを流し直す)。検査の赤ではないので、コードは直さない。手順は `docs/operations/backup-restore.md` の 10 章 |

### main の「Verify db diff (post-apply)」を赤のままにする理由

この段は、本番に migration を当てた後に、本番と migration が一致することを確かめる最後の段です。取得できなかったときに警告で緑にすると、確かめていないのに緑の run が残り、ずれ (本番への直接の変更など) に気づく機会を失います。そのため赤のままにして、注記と Step Summary で「検査の赤ではない」ことを区別できるようにしています。

### 古い run を流し直さない

後から別の migration が main に入ったあとに、古い run (古いコミット) の失敗したジョブを流し直すと、古いコミットには新しい migration のファイルが無いため「Detect migration drift」が `REMOTE_ONLY` で赤になります (本番の不整合ではありません。2026-10-14 に run 38440247647 で起きました)。流し直すのは、その時点の最新の main の run だけにしてください。

## 手で取得元を替えるとき

| 環境変数 | 意味 | 既定 |
|---|---|---|
| `SUPABASE_IMAGE_REGISTRIES` | 試す取得元の順 (空白区切り) | `public.ecr.aws ghcr.io` |
| `SUPABASE_IMAGE_PULL_ROUNDS` | 取得元を一巡する回数の上限 | 3 |
| `SUPABASE_IMAGE_PULL_WAIT_UNIT` | `scripts/supabase-image-fallback.sh` の周のあとの待ちの単位秒 | 60 |
| `SUPABASE_LOCAL_RETRY_WAIT_UNIT` | `scripts/supabase-local.sh start` の待ちの単位秒 | 30 |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY` | CLI の取得元。指定すれば、その取得元だけを使う (切り替えない) | (CLI の既定 `public.ecr.aws`) |

- `scripts/supabase-local.sh` の `reset` と `verify` は取得元を切り替えません。ローカルで ECR の上限に当たったときは、`SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io bash scripts/supabase-local.sh reset` のように指定して打ってください。
- 取得元を替えると、同じイメージが別の名前 (`ghcr.io/supabase/...`) でもう 1 つ取得されます。ローカルの機械では、既定の順 (`public.ecr.aws` が先) のままにしておけば、取得済みのイメージをそのまま使います。

## 関数のデプロイ (#1686)

`supabase functions deploy` は、`--use-api` を付けないと、Docker の edge-runtime のイメージ (`public.ecr.aws/supabase/edge-runtime`) を取ってランナーの上で関数をまとめます。2026-10-15 に、このイメージの取得が ECR の上限で落ち、`calculate-segment-stats` の新しい版がデプロイされませんでした。上の取得元の切り替え (#1523) は `supabase start` と db diff の経路にしか効いていませんでした。

いまの「Deploy all functions」は次の形です。

```bash
npx --yes supabase@2.62.10 functions deploy --use-api --import-map supabase/functions/deno.json --project-ref <ref>
```

- `--use-api`: 関数のまとめを Supabase のサーバーにさせます。CLI 2.62.10 では、このフラグのとき Docker を使いません (`cmd/functions.go`・`internal/functions/deploy/deploy.go` の `Run`)。イメージの取得が無くなるので、ECR の上限に当たりません。
- `--import-map supabase/functions/deno.json`: `--use-api` のとき CLI が関数ごとに送るのは、入口のファイル・そこから相対パスの import でたどれるファイル・import map だけです (`pkg/function/deploy.go` の `writeForm`)。共通の `supabase/functions/deno.json` は関数のディレクトリの外にあるので、指定しないと送られず、`zod` などの deno.json の名前が解決できません。Docker でまとめていたときは、Deno が上のディレクトリの `deno.json` を見つけていました。
- 関数ごとの `verify_jwt` (`supabase/config.toml`) の読み方は変わりません (`GetFunctionConfig` は同じ)。
- CLI のたどり方は正規表現で import の行を探すだけなので、書き方によっては相対パスの import を拾えず、そのファイルが送られません (例: `import type {` で改行する複数行の import)。`tests/edge-function-deploy-use-api.test.ts` が、CLI と同じたどり方で送るファイルを数え、TypeScript の構文解析で拾った import と突き合わせます (PR の `npm test` で赤になる)。

失敗したときの出し方:

| 失敗 | ログ・注記 | 終了コード | すること |
|---|---|---|---|
| Docker のイメージの取得の失敗 (`failed to pull docker image`・`toomanyrequests`) | `[image-pull-unavailable] Deploy all functions: ...`、注記の題「Deploy all functions: イメージを取得できない (関数のデプロイの赤ではない)」、Step Summary | 75 | `--use-api` では起きないはず。CLI の版やフラグが変わっていないかを確かめ、直してから流し直す |
| デプロイそのものの失敗 (API の 4xx / 5xx・時間切れ・まとめの失敗など) | 注記の題「Deploy all functions: 関数のデプロイが失敗した」、Step Summary。CLI のエラーはその上のログ | CLI の終了コード | ログの CLI のエラーを確かめる。一過性 (API の時間切れ・5xx) なら流し直す。まとめの失敗 (import が解決できないなど) は関数のコードを直す |

- 流し直すのは、**その時点の最新の main の run** の失敗したジョブ (Re-run failed jobs) か、main を指定した手での実行 (workflow_dispatch) です。デプロイは関数ごとの上書きなので、2 回打っても同じ結果になります。古い run を流し直すと、古い版の関数で本番を上書きします。
- デプロイが赤なら、後ろの「Delete functions not in the repository」「Verify deployment」は動きません (本番の関数は消しません)。
- 本番への確かめは、デプロイの後の「Verify deployment」(`supabase functions list`) と、本番の関数の版 (ダッシュボードの Functions) で行います。PR の CI ではデプロイしません。

## まだ備えていないところ

次のものも同じ取得元 (`public.ecr.aws`) からイメージを取りますが、この備えは入れていません (手で動かす workflow・本番に書き込む段・手元の道具のため)。上限に当たったときは、時間をおいて流し直すか、`SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io` を付けて打ってください (`docker run` で名前を直書きしたものには効きません)。

- `supabase db dump` (Prod Schema Snapshot・Migration Drift Inspect・Migration Repair)、Prod Schema Snapshot の `docker run public.ecr.aws/supabase/postgres`
- Migration Drift Inspect の `supabase db diff` (失敗しても `|| true` で続け、結果を artifact に残すだけ)
- 手元の道具: `bash scripts/supabase-local.sh verify` と `scripts/baseline/drift_report.sh` の `docker run public.ecr.aws/supabase/postgres` (スタックを `ghcr.io` から起動していると、`public.ecr.aws` の名前のイメージを別に取りに行く)、`npm run types:supabase` (`supabase gen types --local` は postgres-meta のイメージを取る)
