# CI で Supabase の Docker イメージを取得できないとき (#1523)

CI のいくつかのジョブは、Supabase CLI でローカルの Supabase を起動したり (`supabase start`)、`supabase db diff` のシャドウ DB を作ったりするために、Supabase の Docker イメージを取得します。取得元の既定は Amazon ECR Public (`public.ecr.aws`) で、認証なしの取得には上限があります。GitHub のランナーは IP を多くの利用者と共有しているため、日中にこの上限 (`toomanyrequests: Data limit exceeded`) に当たり、検査の中身と関係なくジョブが赤になることがあります (2026-10-14〜15 に、security-regression・Deploy Supabase Migrations の db diff で 3 回以上)。

## 自動でしていること

| どこで | 何を |
|---|---|
| `scripts/supabase-local.sh start` (security-regression・e2e-local・`scripts/local-ci.sh`) | イメージの取得に失敗したら、取得元を `public.ecr.aws` → `ghcr.io` の順に替えてやり直す。どちらでも失敗したら、間を空けて (30 秒 × 周) 次の周に入る (既定 3 周) |
| `scripts/supabase-image-fallback.sh` (Deploy Supabase Migrations の「Verify db diff (post-apply)」・Daily Consistency Check の db diff) | 同じ。周のあとの待ちは 60 秒 × 周 |

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

## まだ備えていないところ

次のものも同じ取得元からイメージを取りますが、この備えは入れていません (手で動かす workflow か、本番に書き込む段のため)。上限に当たったときは、時間をおいて流し直してください。

- `supabase db dump` (Prod Schema Snapshot・Migration Drift Inspect・Migration Repair)、Prod Schema Snapshot の `docker run public.ecr.aws/supabase/postgres`
- Migration Drift Inspect の `supabase db diff` (失敗しても `|| true` で続け、結果を artifact に残すだけ)
- Deploy Supabase Edge Functions の `supabase functions deploy` (既定で Docker の edge-runtime イメージで関数をまとめる)
