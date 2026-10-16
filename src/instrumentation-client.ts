/**
 * #1721: ブラウザで zod の JIT を切る (本番の CSP に unsafe-eval を足さないため。docs/design/cross/18-csp-nonce.md §7.1 c・§7.3)。
 *
 * zod 4 は z.object(...) を作るたびに、JIT (速い経路のコード生成) が使えるかを new Function("") で 1 回だけ試す
 * (zod/v4/core/util.js の allowsEval。結果は覚えておくので試すのはページあたり最初の 1 回)。本番の CSP の script-src には
 * 'unsafe-eval' が無いので、その試しが違反として /api/csp-report に報告され、app_logs に warn が溜まる
 * (zod は例外を握りつぶすので画面は動く)。z.config({ jitless: true }) にすると zod はこの試しを飛ばし、JIT も使わない
 * (検証の結果は同じで、速い経路を使わないだけ)。
 *
 * ここに置く理由: Next はこのファイル (src/instrumentation-client.ts) を、ハイドレーションの前・ページと layout の
 * クライアントのモジュールを読み込む前に評価する (next/dist/client/app-next.js が require-instrumentation-client を
 * app-index より先に require する)。全画面の共通の入口なので、どの画面のスキーマが作られるより先に 1 回だけ呼べる。
 * 試しは z.object(...) を作った時点で走る (zod/v4/core/schemas.js の $ZodObject は作るときに allowsEval.value を読む) ので、
 * ページのモジュールの読み込み (トップレベルのスキーマの定義を含む) より前でないと効かない。
 * zod 自身の import ではスキーマは作られない (試しは走らない) ので、ここで zod を import してから設定してよい。
 * 設定は globalThis の 1 か所 (__zod_globalConfig) なので、"zod" / "zod/v4" / "zod/mini" のどこから作ったスキーマにも効く。
 *
 * サーバー (route・Server Component・Edge の middleware) は対象外: CSP はブラウザだけが守るもので、サーバーでは JIT を使ってよい。
 * このファイルはクライアントのバンドルにだけ入る (Next はサーバーではこのファイルを読まない)。
 */
import { z } from "zod";

// ブラウザで zod の JIT (new Function によるコード生成と、その可否の試し) を使わない
z.config({ jitless: true });
