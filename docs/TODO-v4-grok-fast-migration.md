# TODO: V4 Grok Fast Migration

## Goal
- Audit every LLM call used by `generate-menu-v4`.
- Replace every `gpt-5-nano` call that is actually used in the V4 path with `grok-4-1-fast-non-reasoning`.
- Keep the review pass on its current model unless explicitly changed later.
- Produce before/after timing numbers per V4 section.
- Verify the full V4 function still completes end-to-end.

## Audit Result

### V4 path LLM sections
- [x] `generateDayMealsWithLLM`
- [x] `generateMealWithLLM`
- [x] `regenerateMealForIssue`
- [x] `ingredient-matcher` ambiguous candidate selection
- [x] `reviewWeeklyMenus` is present in V4, but it is `gpt-5.2`, not `gpt-5-nano`

### Non-target
- [x] `nutrition-calculator.ts` has `gpt-5-nano`, but V4 currently uses the split nutrition path instead

## Tasks

### A. Instrumentation
- [x] A01. Extend `llm-usage.ts` to capture both OpenAI and xAI calls.
- [x] A02. Add section metadata so timing can be grouped by V4 section instead of only by step.

### B. Implementation
- [x] B01. Add a shared fast-LLM client for V4 with provider/model switching.
- [x] B02. Switch `generateMealWithLLM` to the shared client.
- [x] B03. Switch `generateDayMealsWithLLM` to the shared client.
- [x] B04. Switch `regenerateMealForIssue` to the shared client.
- [x] B05. Switch ingredient matcher LLM selection to the shared client.
- [x] B06. Keep `reviewWeeklyMenus` unchanged for this pass.

### C. Benchmarking
- [x] C01. Add a reproducible section benchmark script.
- [x] C02. Run `before` with `openai + gpt-5-nano`.
- [x] C03. Run `after` with `xai + grok-4-1-fast-non-reasoning`.
- [x] C04. Report seconds by section and average.

### D. Validation
- [x] D01. Run `deno check` for touched Edge Function modules.
- [x] D02. Run full V4 smoke test against the linked Supabase project.
- [x] D03. Confirm xAI model/provider appears in `llm_usage_logs` for changed sections.

### E. Git
- [ ] E01. Commit only the Grok migration files.
- [ ] E02. Push `main`.

## Definition of Done
- Every V4-path `gpt-5-nano` call is replaced by `grok-4-1-fast-non-reasoning`.
- `llm_usage_logs` can distinguish OpenAI vs xAI and the V4 section name.
- Before/after benchmark numbers exist for every replaced section.
- A smoke run of `generate-menu-v4` completes successfully after the switch.

## Benchmark Notes
- Local OpenAI benchmarking was blocked by `unsupported_country_region_territory`.
- Final before/after numbers were collected via a temporary remote Edge Function benchmark on the linked Supabase project.
