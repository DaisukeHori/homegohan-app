/**
 * PostHog の既定の送信先ホスト (米国リージョン)。
 *
 * Web の NEXT_PUBLIC_POSTHOG_HOST・モバイルの EXPO_PUBLIC_POSTHOG_HOST が未設定のときに使う。
 *
 * #1197: 以前は src/lib/posthog.ts・apps/mobile/src/lib/posthog.ts・next.config.mjs・.env.example が
 * それぞれ同じ文字列を持っていて、next.config.mjs のコメントが「手動で合わせる」ことを求めていた。
 * TypeScript のコードはこの定数を import する。
 * 素の Node ESM である next.config.mjs と、設定例の .env.example だけはリテラルが残るため、
 * 値が一致していることは src/__tests__/config/posthog-default-host.test.ts が検査する。
 * ホストを変えるときは、この定数・next.config.mjs・.env.example の 3 か所を同時に直すこと
 * (直し忘れるとそのテストが落ちる)。
 *
 * PostHog のプロジェクトキー (NEXT_PUBLIC_POSTHOG_KEY / EXPO_PUBLIC_POSTHOG_KEY) には既定値を持たせない。
 * 未設定なら計測しない (graceful degradation) 設計のため。
 */
export const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com';
