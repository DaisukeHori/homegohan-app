// @vitest-environment node
/**
 * #1114 公開リポジトリに、本番の認証情報を残さないための回帰テスト
 *
 * 背景:
 *   公開リポジトリの HEAD に、本番のデバッグ用アカウントの認証情報が残っていた。
 *     - ブラウザの通信記録 (HAR)。ログイン要求の平文パスワード、アクセストークン、リフレッシュトークンが入っていた
 *     - e2e の spec や README に、環境変数が無いときに使う既定のメールアドレスとパスワードが書かれていた
 *   .gitignore には HAR も Google Play のサービスアカウント鍵 (apps/mobile/eas.json が参照、#1139) も無く、
 *   同じことがまた起きうる状態だった。
 *
 * このテストは git で管理しているファイル (git ls-files / git grep) について、次を確かめる。
 *   1. デバッグ用アカウントのメールアドレス (claude-debug-<数字>@...) が書かれていない
 *   2. 以前に既定値として書いていたパスワードが書かれていない
 *   3. HAR ファイル (*.har) が無い
 *   4. サービスアカウント鍵 (*service-account*.json) と secrets/ の中身が無い
 *   5. .gitignore が HAR・サービスアカウント鍵・secrets/ を除外している
 *
 * 落ちたとき:
 *   該当ファイルを git rm し、認証情報は環境変数 (ローカルは .env.local、CI は Secrets) から取るようにする。
 *   一度でも公開した値は、消しても git の履歴に残る。パスワードの変更やアカウントの削除は別途必要 (#1114)。
 *
 * 禁止するパスワードは、このファイル自身に一致しないよう、分割して書いて実行時に連結する
 * (値そのものを新しくコミットしないため)。ここに足すときも同じ書き方にすること。
 * 失敗時の出力にはファイル名だけを出し、見つかった内容は出さない。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

// git を何度も呼ぶので、CPU の少ない CI でも間に合うよう余裕を持たせる
const GIT_TIMEOUT_MS = 60_000;

/**
 * 以前、既定値としてコードに書いていたパスワード。公開されているので、二度と書かない。
 */
const FORBIDDEN_PASSWORDS: ReadonlyArray<{ label: string; value: string }> = [
  {
    label: "デバッグ用アカウントのパスワード (e2e の spec の既定値だった)",
    value: ["Claude", "Debug", "2026!"].join(""),
  },
  {
    label: "e2e 用アカウント e2e-user-01〜10 の共通パスワード (#1272 で削除)",
    value: ["Test", "E2E", "2026!", "secure"].join(""),
  },
  {
    label: "診断スクリプトが作るテストユーザーの固定パスワード",
    value: ["test-password", "-12345"].join(""),
  },
];

/**
 * .gitignore で除外されているべきパス (実在しなくてよい)。
 * HAR (通信記録) とサービスアカウント鍵を、うっかり git add しないための確認。
 */
const SHOULD_BE_IGNORED: ReadonlyArray<{ label: string; file: string }> = [
  { label: "HAR (リポジトリ直下)", file: "session.har" },
  { label: "HAR (以前コミットされていた場所)", file: "tests/e2e/.exploration/checkup-graphs/session.har" },
  {
    label: "Google Play のサービスアカウント鍵 (apps/mobile/eas.json の serviceAccountKeyPath)",
    file: "secrets/google-play-service-account.json",
  },
  { label: "サービスアカウント鍵 (secrets/ の外に置いた場合)", file: "google-play-service-account.json" },
  { label: "サービスアカウント鍵 (別名)", file: "apps/mobile/play-service-account-key.json" },
];

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGit(args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `git を実行できません: ${result.error.message}。このテストは git で管理しているファイルを調べるため、git が必要です (#1114)。`,
    );
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** git で管理しているファイルの一覧 (リポジトリ直下からの相対パス) */
function listTrackedFiles(): string[] {
  const { status, stdout, stderr } = runGit(["ls-files", "-z"]);
  if (status !== 0) {
    throw new Error(
      `git ls-files に失敗しました (終了コード ${status})。git のリポジトリの中で実行してください: ${stderr.trim()}`,
    );
  }
  return stdout.split("\0").filter(Boolean);
}

/**
 * git で管理しているファイルのうち、内容が条件に一致するファイルの一覧。一致が無ければ空配列。
 * -a はバイナリ扱いのファイルも調べる。-l は一致したファイル名だけを返す (一致した内容は出力しない)。
 *
 * @param matcher - git grep に渡す一致の指定。例: ["-F", "-e", "固定の文字列"] / ["-E", "-i", "-e", "正規表現"]
 */
function grepTracked(matcher: string[]): string[] {
  const { status, stdout, stderr } = runGit(["grep", "-a", "-l", "-z", ...matcher, "--", "."]);
  // 終了コード 1 は「一致なし」
  if (status === 1) return [];
  if (status !== 0) {
    throw new Error(`git grep に失敗しました (終了コード ${status}): ${stderr.trim()}`);
  }
  return stdout.split("\0").filter(Boolean);
}

describe("#1114 リポジトリに認証情報を残さない", () => {
  it(
    "git でファイルの一覧と内容を調べられる (このテストが空振りしていない)",
    () => {
      expect(listTrackedFiles()).toContain("package.json");
      expect(grepTracked(["-F", "-e", '"scripts"'])).toContain("package.json");
      // 一致しない文字列では空になる (何でも一致する検索になっていない)。文字列は実行時に作るので、自分自身には一致しない
      expect(grepTracked(["-F", "-e", ["no-such", "string", String(Date.now())].join("-")])).toEqual([]);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "デバッグ用アカウントのメールアドレス (claude-debug-<数字>@...) が、git 管理下のどのファイルにも書かれていない",
    () => {
      // @ の URL エンコード (%40) も対象。HAR の中のように、URL に入った形で残ることがある
      expect(grepTracked(["-E", "-i", "-e", "claude-debug-[0-9]+(@|%40)"])).toEqual([]);
    },
    GIT_TIMEOUT_MS,
  );

  it.each(FORBIDDEN_PASSWORDS)(
    "以前の既定パスワードが、git 管理下のどのファイルにも書かれていない: $label",
    ({ value }) => {
      expect(grepTracked(["-F", "-e", value])).toEqual([]);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "HAR ファイル (*.har) が git 管理下に無い (通信記録にはパスワードやトークンが平文で入る)",
    () => {
      expect(listTrackedFiles().filter((file) => /\.har$/i.test(file))).toEqual([]);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "サービスアカウント鍵 (*service-account*.json) と secrets/ の中身が git 管理下に無い",
    () => {
      const offending = listTrackedFiles().filter(
        (file) => /(^|\/)[^/]*service-account[^/]*\.json$/i.test(file) || file.startsWith("secrets/"),
      );
      expect(offending).toEqual([]);
    },
    GIT_TIMEOUT_MS,
  );
});

describe("#1114 .gitignore が認証情報の置き場を除外している", () => {
  it.each(SHOULD_BE_IGNORED)(
    "除外される: $label",
    ({ file }) => {
      // --no-index: すでに git 管理下のファイルでも、除外の規則だけで判定する。終了コード 0 が「除外される」
      const { status } = runGit(["check-ignore", "--no-index", "-q", "--", file]);
      expect(status, `${file} が .gitignore で除外されていません`).toBe(0);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "普通のファイルは除外されない (除外の判定が何でも真になっていない)",
    () => {
      const { status } = runGit(["check-ignore", "--no-index", "-q", "--", "package.json"]);
      expect(status).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );
});
