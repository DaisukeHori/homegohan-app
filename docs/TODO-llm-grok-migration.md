# LLM Grok Migration TODO

Last updated: 2026-03-17

## Goal

- Enumerate all LLM usage in Homegohan.
- Replace all GPT `mini` / `nano` usages with `grok-4-1-fast-non-reasoning`.
- Keep non-target models explicitly documented.
- Verify with unit, integration, E2E, and live invocation tests before pushing `main`.

## Full LLM Inventory

### Target: GPT mini/nano to Grok

- `supabase/functions/normalize-shopping-list/index.ts`
  - `gpt-4o-mini`
- `supabase/functions/regenerate-shopping-list-v2/index.ts`
  - `gpt-4o-mini`
- `supabase/functions/analyze-fridge/index.ts`
  - `gpt-5-mini`
- `supabase/functions/generate-health-insights/index.ts`
  - `gpt-5-mini`
- `supabase/functions/create-derived-recipe/index.ts`
  - `gpt-5-mini`
- `supabase/functions/knowledge-gpt/index.ts`
  - `gpt-5-mini`
- `supabase/functions/_shared/catalog-llm.ts`
  - `gpt-5-mini`
- `supabase/functions/_shared/nutrition-calculator.ts`
  - `gpt-5-nano`
- `src/app/api/ai/nutrition/route.ts`
  - `gpt-5-mini`
- `src/app/api/ai/nutrition-analysis/route.ts`
  - `gpt-5-mini`
- `src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts`
  - `gpt-5-mini`
- `src/app/api/ai/consultation/sessions/[sessionId]/summarize/route.ts`
  - `gpt-5-mini`
- `src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts`
  - `gpt-5-mini`

### Non-target but still LLM usage

- `supabase/functions/_shared/meal-generator.ts`
  - `gpt-5.2` for review path
  - `grok-4-1-fast-non-reasoning` already used for fast V4 sections
- `src/app/api/health/checkups/route.ts`
  - `gpt-5.2`
- `src/app/api/ai/nutrition/feedback/route.ts`
  - `gpt-5.2`
- `supabase/functions/analyze-health-photo/index.ts`
  - Gemini
- `supabase/functions/analyze-meal-photo/index.ts`
  - Gemini
- `supabase/functions/_shared/gemini-json.ts`
  - Gemini
- `supabase/functions/_shared/nutrition-pipeline.ts`
  - Gemini + Perplexity
- `src/app/api/ai/classify-photo/route.ts`
  - Gemini
- `src/app/api/ai/analyze-fridge/route.ts`
  - Gemini
- `src/app/api/ai/analyze-health-checkup/route.ts`
  - Gemini
- `src/app/api/ai/image/generate/route.ts`
  - Gemini
- `src/lib/ai/gemini-json.ts`
  - Gemini
- `supabase/functions/_shared/perplexity-nutrition.ts`
  - Perplexity

### Not an actual LLM call

- `src/app/api/ai/feedback/route.ts`
  - display/mock metadata only
- `supabase/functions/_shared/llm-usage.ts`
  - legacy cost table keeps historical `mini/nano` entries for old log rows

## Implementation Tasks

1. Add shared Grok helpers for Deno and Next.js.
2. Migrate direct fetch call sites to shared helper or xAI-compatible endpoint.
3. Migrate OpenAI SDK call sites to xAI-compatible OpenAI client (`baseURL=https://api.x.ai/v1`).
4. Replace `@openai/agents` usage in `create-derived-recipe` with direct JSON generation because the agent wrapper is OpenAI-specific.
5. Keep `gpt-5.2`, Gemini, and Perplexity paths unchanged in this pass.
6. Update usage logging/cost metadata to recognize `grok-4-1-fast-non-reasoning`.

## Verification Tasks

1. `npm test`
2. `npx eslint` for touched files
3. `npx tsc --noEmit` for Next.js side
4. `deno check` for touched Edge Functions
5. Live xAI direct smoke:
   - text
   - JSON mode
   - vision
6. App-level live smoke:
   - `knowledge-gpt`
   - at least one migrated Next.js API route
   - at least one migrated Supabase function using JSON output
7. Commit only migration files and push `main`
8. Keep a regression test that blocks reintroducing `gpt-5-mini`, `gpt-5-nano`, or `gpt-4o-mini` in migrated targets
