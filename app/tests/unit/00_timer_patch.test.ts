// This test patches global timer APIs to track outstanding timers so tests can detect leaks.
// Must run first (00 prefix) to install wrappers before any other tests schedule timers.

// deno-lint-ignore no-explicit-any
const g: any = globalThis as any;

if (!g.__timersPatched) {
  g.__timerHandles = new Set<number | string>();
  const origSetTimeout = setTimeout;
  const origClearTimeout = clearTimeout;
  const origSetInterval = setInterval;
  const origClearInterval = clearInterval;

  // Wrapper for setTimeout
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = function (
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) {
    const id = origSetTimeout(() => {
      try {
        fn(...args);
      } finally {
        g.__timerHandles.delete(id);
      }
    }, ms);
    g.__timerHandles.add(id);
    return id;
  } as any;

  // Wrapper for clearTimeout
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearTimeout = function (id?: number | undefined) {
    if (id !== undefined) {
      g.__timerHandles.delete(id as number);
    }
    return origClearTimeout(id);
  } as any;

  // Wrapper for setInterval
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setInterval = function (
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) {
    const id = origSetInterval(fn, ms, ...args);
    g.__timerHandles.add(id);
    return id as unknown as number;
  } as any;

  // Wrapper for clearInterval
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearInterval = function (id?: number | undefined) {
    if (id !== undefined) {
      g.__timerHandles.delete(id as number);
    }
    return origClearInterval(id);
  } as any;

  g.__timersPatched = true;
}

Deno.test("00: timer wrappers installed", () => {
  // just ensure patch is active
  // deno-lint-ignore no-explicit-any
  const pending = (globalThis as any).__timerHandles;
  if (!pending) throw new Error("timer handles not present");
});
