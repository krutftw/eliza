/**
 * Validates the deterministic statistics and proof checks used by the live
 * Cerebras chat-flow harness; provider execution remains in the live lane.
 */
import { describe, expect, it } from "vitest";
import {
  captureModelInput,
  distribution,
  modelUsageEvidence,
  percentile,
  promptCacheTelemetry,
  verifyExactResponseParity,
  verifyProofResponse,
} from "../scripts/cerebras-chat-flow-latency";

describe("Cerebras chat-flow latency helpers", () => {
  it("captures exact model input with phase context without leaking unrelated fields", () => {
    expect(
      captureModelInput(
        "RESPONSE_HANDLER",
        {
          messages: [{ role: "user", content: "hello" }],
          promptSegments: [{ content: "hello", stable: false }],
          providerOptions: { cerebras: { prompt_cache_key: "cache-key" } },
          maxTokens: 128,
          stream: true,
          apiKey: "must-not-be-captured",
        },
        { phase: "sample", index: 7, proof: "SPEED-S-7" },
      ),
    ).toEqual({
      context: { phase: "sample", index: 7, proof: "SPEED-S-7" },
      modelType: "RESPONSE_HANDLER",
      messages: [{ role: "user", content: "hello" }],
      promptSegments: [{ content: "hello", stable: false }],
      providerOptions: { cerebras: { prompt_cache_key: "cache-key" } },
      maxTokens: 128,
      stream: true,
    });
  });

  it("uses nearest-rank percentiles and reports the full distribution", () => {
    const samples = [9, 1, 5, 3, 7];
    expect(
      percentile(
        [...samples].sort((a, b) => a - b),
        95,
      ),
    ).toBe(9);
    expect(distribution(samples)).toEqual({
      count: 5,
      min: 1,
      p50: 5,
      p90: 9,
      p95: 9,
      p99: 9,
      max: 9,
      mean: 5,
    });
  });

  it("accepts punctuation around a distinct proof and rejects stale output", () => {
    expect(() =>
      verifyProofResponse('"SPEED-S-4".', "SPEED-S-4"),
    ).not.toThrow();
    expect(() => verifyProofResponse("SPEED-S-3", "SPEED-S-4")).toThrow(
      "did not contain the requested proof",
    );
  });

  it("requires the append-only stream to equal the authoritative final reply", () => {
    expect(() =>
      verifyExactResponseParity("SPEED-S-4", "SPEED-S-4"),
    ).not.toThrow();
    expect(() => verifyExactResponseParity("SPEED-", "SPEED-S-4")).toThrow(
      "did not exactly match",
    );
  });

  it("retains concrete Cerebras model and token attribution", () => {
    expect(
      modelUsageEvidence(
        {
          runtime: {} as never,
          source: "openai",
          provider: "cerebras",
          type: "RESPONSE_HANDLER",
          model: "gemma-4-31b",
          modelName: "gemma-4-31b",
          modelLabel: "RESPONSE_HANDLER",
          tokens: {
            prompt: 120,
            completion: 8,
            total: 128,
            cachedInputTokens: 64,
          },
        },
        "gemma-4-31b",
      ),
    ).toEqual({
      provider: "cerebras",
      model: "gemma-4-31b",
      modelName: "gemma-4-31b",
      modelLabel: "RESPONSE_HANDLER",
      type: "RESPONSE_HANDLER",
      tokens: {
        prompt: 120,
        completion: 8,
        total: 128,
        cachedInputTokens: 64,
      },
    });
  });

  it("reports provider-measured cache reuse without a pass/fail threshold", () => {
    expect(
      promptCacheTelemetry([
        {
          modelUsage: {
            tokens: { prompt: 1_000, cachedInputTokens: 750 },
          },
        },
        {
          modelUsage: {
            tokens: { prompt: 2_000, cacheReadInputTokens: 1_000 },
          },
        },
      ]),
    ).toEqual({
      promptTokens: {
        count: 2,
        min: 1_000,
        p50: 1_000,
        p90: 2_000,
        p95: 2_000,
        p99: 2_000,
        max: 2_000,
        mean: 1_500,
      },
      cachedPromptTokens: {
        count: 2,
        min: 750,
        p50: 750,
        p90: 1_000,
        p95: 1_000,
        p99: 1_000,
        max: 1_000,
        mean: 875,
      },
      uncachedPromptTokens: {
        count: 2,
        min: 250,
        p50: 250,
        p90: 1_000,
        p95: 1_000,
        p99: 1_000,
        max: 1_000,
        mean: 625,
      },
      cacheRatePercent: {
        count: 2,
        min: 50,
        p50: 50,
        p90: 75,
        p95: 75,
        p99: 75,
        max: 75,
        mean: 62.5,
      },
    });
    expect(() =>
      promptCacheTelemetry([{ modelUsage: { tokens: { prompt: 100 } } }]),
    ).toThrow("provider-reported cached prompt tokens");
  });

  it("rejects logical slots and transport labels as concrete attribution", () => {
    expect(() =>
      modelUsageEvidence(
        {
          runtime: {} as never,
          source: "openai",
          provider: "openai",
          type: "RESPONSE_HANDLER",
          model: "RESPONSE_HANDLER",
          modelName: "RESPONSE_HANDLER",
          tokens: { prompt: 1, completion: 1, total: 2 },
        },
        "gemma-4-31b",
      ),
    ).toThrow("Expected MODEL_USED provider cerebras");
  });
});
