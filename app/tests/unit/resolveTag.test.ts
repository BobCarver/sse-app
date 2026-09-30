// tests/resolveTag.test.ts

import { assertEquals, assertRejects } from "@std/assert";
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

  waitForTag("required:1");
  waitForTag("perf:1:2");

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

Deno.test("waitForTag rejects a second concurrent waiter instead of replacing the first", async () => {
  clearAllResolvers();
  const first = waitForTag("required:dup");
  await assertRejects(
    () => waitForTag("required:dup"),
    Error,
    "Already waiting",
  );
  resolveTag("required:dup", undefined);
  await first;
});

Deno.test("waitForTag: an aborted signal rejects with its reason and releases the tag", async () => {
  clearAllResolvers();
  const ctl = new AbortController();
  const p = waitForTag("required:sig", 0, ctl.signal);
  assertEquals(hasWaiter("required:sig"), true);
  const why = new Error("stop");
  ctl.abort(why);
  await assertRejects(() => p, Error, "stop");
  assertEquals(hasWaiter("required:sig"), false);
  // free again for the next waiter
  const again = waitForTag("required:sig");
  resolveTag("required:sig", undefined);
  await again;
});

Deno.test("waitForTag: an already-aborted signal rejects immediately and registers nothing", async () => {
  clearAllResolvers();
  const ctl = new AbortController();
  ctl.abort(new Error("already"));
  await assertRejects(
    () => waitForTag("required:pre", 0, ctl.signal),
    Error,
    "already",
  );
  assertEquals(hasWaiter("required:pre"), false);
});

Deno.test("waitForTag: resolving removes the abort listener (no late rejection)", async () => {
  clearAllResolvers();
  const ctl = new AbortController();
  const p = waitForTag("required:ok", 0, ctl.signal);
  resolveTag("required:ok", undefined);
  await p;
  const next = waitForTag("required:ok"); // reuse the tag
  ctl.abort(new Error("late")); // must not disturb the new waiter
  assertEquals(hasWaiter("required:ok"), true);
  resolveTag("required:ok", undefined);
  await next;
});
