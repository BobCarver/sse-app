// tests/resolveTag.test.ts

import { assertEquals } from "std/assert/equals";
import { assertRejects } from "std/assert/rejects";
import {
  clearAllResolvers,
  getPendingTags,
  hasWaiter,
  resolveTag,
  waitForTag,
} from "../../src/resolveTag.ts";
import type { ScoreSubmission } from "../../src/types.ts";
import { delay } from "../test-utils.ts";

Deno.test("resolveTag - should resolve waiting promise", async () => {
  const promise = waitForTag("required:1");

  // Resolve after a brief delay
  delay(10).then(() => resolveTag("required:1", undefined));

  const result = await promise;
  assertEquals(result, undefined);
});
Deno.test("resolveTag - should resolve with correct payload type", async () => {
  const promise = waitForTag("perf:1:2");

  delay(10).then(() => resolveTag("perf:1:2", true));

  const result = await promise;
  assertEquals(result, true);
});
Deno.test("resolveTag - should resolve score submission", async () => {
  const submission: ScoreSubmission = {
    competition_id: 1,
    competitor_id: 2,
    judge_id: 3,
    scores: [{ criteria_id: 1, score: 8.5 }],
  };

  const promise = waitForTag("score:1:2:3");

  delay(10).then(() => resolveTag("score:1:2:3", submission.scores));

  const result = await promise;
  assertEquals(result, submission.scores);
});
Deno.test("resolveTag - should timeout when not resolved", async () => {
  const promise = waitForTag("required:999", 100);

  await assertRejects(
    () => promise,
    Error,
    "Timeout waiting for tag: required:999",
  );
});
Deno.test("resolveTag - should track pending tags", () => {
  clearAllResolvers();

  // deno-lint-ignore no-unused-vars
  const promise1 = waitForTag("required:1");
  // deno-lint-ignore no-unused-vars
  const promise2 = waitForTag("perf:1:2");

  assertEquals(hasWaiter("required:1"), true);
  assertEquals(hasWaiter("perf:1:2"), true);
  assertEquals(hasWaiter("required:999"), false);

  const pending = getPendingTags();
  assertEquals(pending.includes("required:1"), true);
  assertEquals(pending.includes("perf:1:2"), true);

  // Cleanup
  resolveTag("required:1", undefined);
  resolveTag("perf:1:2", true);
});
Deno.test("resolveTag - should clean up after resolution", async () => {
  const promise = waitForTag("required:1");

  delay(10).then(() => resolveTag("required:1", undefined));

  await promise;

  assertEquals(hasWaiter("required:1"), false);
});
Deno.test("resolveTag - should warn when resolving non-existent tag", () => {
  const logs: string[] = [];
  const originalWarn = console.warn;
  // deno-lint-ignore no-explicit-any
  console.warn = (...args: any[]) => logs.push(args.join(" "));

  resolveTag("required:999", undefined);

  assertEquals(logs.some((log) => log.includes("no resolver waiting")), true);

  console.warn = originalWarn;
});
Deno.test("resolveTag - clearAllResolvers should clear pending", () => {
  waitForTag("required:1");
  waitForTag("perf:1:2");

  assertEquals(getPendingTags().length >= 2, true);

  clearAllResolvers();

  assertEquals(getPendingTags().length, 0);
});
