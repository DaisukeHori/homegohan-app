// Tour ルートマップ
// Canonical: docs/design/family/09-onboarding-handson-tour/16-files-structure.md §5.1

export const HANDSON_TOUR_ROUTES = {
  root: '/handson-tour',
  step0: '/handson-tour',
  step1: '/handson-tour/photo',
  step2: '/handson-tour/menu',
  step3: '/handson-tour/badges',
  step4: '/handson-tour/graduate',
  forceQuery: '?force=1',
} as const;

export type HandsonTourRoute = (typeof HANDSON_TOUR_ROUTES)[keyof typeof HANDSON_TOUR_ROUTES];
