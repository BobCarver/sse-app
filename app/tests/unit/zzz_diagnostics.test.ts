import { assertEquals } from "@std/assert";

// Diagnostic test that runs last (zzz prefix) to surface leftover timers/resources
Deno.test("zzz: diagnostics - pending tags & resources", async () => {
  // Give the event loop a moment to settle
  await new Promise((r) => setTimeout(r, 50));

  // Access resolveTag's debug hook if present
  // deno-lint-ignore no-explicit-any
  const getPending = (globalThis as any).__getPendingTags;
  const pending = typeof getPending === "function" ? getPending() : [];
  console.log("--- DIAGNOSTIC: pending tags ->", pending);

  // Show Deno metrics for debugging (safer across Deno versions)
  try {
    // Use any to avoid TS errors across Deno versions
    const metrics = (Deno as any).metrics?.();
    console.log("--- DIAGNOSTIC: Deno.metrics ->", metrics);

    // Also try resources if available
    const resources = (Deno as any).resources?.();
    console.log("--- DIAGNOSTIC: Deno.resources ->", resources);
  } catch (err) {
    console.warn("Deno.metrics not available:", err);
  }

  // Fail the test if there are pending tags to make it obvious
  assertEquals(pending.length, 0);
});
