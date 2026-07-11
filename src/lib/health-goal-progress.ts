// #1046 F2-12: Math.abs で符号を潰すと「目標から遠ざかる」変化でも進捗が増えてしまう
// （例: 80→85kgで目標70kgなのに進捗50%）。target - start の符号を方向として掛け、
// 目標方向へ進んだ分だけを進捗としてカウントする。0除算はガードし、逆行時は0%にクランプする。
//
// #1046 round-2 Critical: App Router の route.ts (src/app/api/health/goals/[id]/route.ts)
// から value export すると、Next.js の NextTypesPlugin が route entry の export を
// HTTP メソッド+config 系に限定する型チェックで next build を落とす
// （"Property 'calculateGoalProgressPercentage' is incompatible with index signature"）。
// route.ts からは export せず、この共有ライブラリに切り出して import する。
export function calculateGoalProgressPercentage(
  startValue: number,
  targetValue: number,
  currentValue: number,
  fallback: number,
): number {
  const totalChange = targetValue - startValue;
  if (totalChange === 0) return fallback;

  const direction = Math.sign(totalChange);
  const currentChange = (currentValue - startValue) * direction;
  return Math.min(100, Math.max(0, (currentChange / Math.abs(totalChange)) * 100));
}
