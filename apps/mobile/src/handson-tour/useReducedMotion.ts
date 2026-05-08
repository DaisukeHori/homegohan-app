// Mobile 版 useReducedMotion
// Canonical: docs/design/family/09-onboarding-handson-tour/07-components.md §10 (web/mobile 差分)
// docs/design/family/09-onboarding-handson-tour/02-step0-welcome.md §5.6

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * AccessibilityInfo.isReduceMotionEnabled() を使って
 * システムの「動きを減らす」設定を購読する。
 */
export function useReducedMotion(forceReducedMotion?: boolean): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (forceReducedMotion) {
      setReduceMotion(true);
      return;
    }

    // 初期値を取得
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {
      // エラーの場合は false のまま
    });

    // 変更を購読
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (isEnabled) => {
      setReduceMotion(isEnabled);
    });

    return () => {
      sub.remove();
    };
  }, [forceReducedMotion]);

  return reduceMotion;
}
