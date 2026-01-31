// test/frontend/fetch-mock.ts
// Utilities to stub and capture global fetch calls during tests.

export type FetchCapture = {
  // deno-lint-ignore no-explicit-any
  getLastFetch(): { url: string; method: string; body?: any } | null;
  restore(): void;
};

export function interceptFetch(): FetchCapture {
  // deno-lint-ignore no-explicit-any
  let lastFetch: { url: string; method: string; body?: any } | null = null;
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let req: Request;
    if (input instanceof Request) {
      req = input;
    } else if (input instanceof URL) {
      // URL isn't always accepted by Request in all environments, convert to string
      req = new Request(input.toString(), init);
    } else {
      // input is a string
      try {
        req = new Request(input as string, init);
      } catch {
        req = new Request(
          new URL(input as string, "http://localhost").toString(),
          init,
        );
      }
    }

    // deno-lint-ignore no-explicit-any
    let body: any = undefined;
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : undefined;
    } catch (_e) {
      body = undefined;
    }

    lastFetch = { url: req.url, method: req.method, body };
    return new Response(null, { status: 200 });
  };

  return {
    getLastFetch: () => lastFetch,
    restore: () => {
      globalThis.fetch = origFetch;
    },
  };
}

export function stubFetchNoop(): { restore(): void } {
  const origFetch = globalThis.fetch;
  // deno-lint-ignore require-await
  globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(null, { status: 200 });
  return {
    restore: () => {
      globalThis.fetch = origFetch;
    },
  };
}
