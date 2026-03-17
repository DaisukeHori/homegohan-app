import { runV4FastLLMBenchmark } from "../supabase/functions/_shared/v4-fast-llm-benchmark.ts";

const ITERATIONS = Number(Deno.args[0] ?? "2");
const originalConsoleLog = console.log;
const results = await runV4FastLLMBenchmark(ITERATIONS);
originalConsoleLog(JSON.stringify(results, null, 2));
