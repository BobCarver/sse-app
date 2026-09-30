// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  type ConnectionState,
  ResilientEventSource,
} from "../../frontend-src/connect.ts";

/** Stand-in EventSource we can drive from the test. */
class FakeES {
  static all: FakeES[] = [];
  readyState = 0;
  closed = false;
  private handlers = new Map<string, Array<(e: any) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(t: string, fn: (e: any) => void) {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(t: string, data: unknown = {}) {
    for (const h of this.handlers.get(t) ?? []) {
      h({ data: JSON.stringify(data) });
    }
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  /** Browser gave up (e.g. 401): readyState CLOSED + error. */
  giveUp() {
    this.readyState = 2;
    this.emit("error");
  }
}

function setup(
  over: Partial<ConstructorParameters<typeof ResilientEventSource>[0]> = {},
) {
  FakeES.all = [];
  const states: ConnectionState[] = [];
  let registers = 0;
  const rs = new ResilientEventSource({
    register: () => {
      registers++;
      return Promise.resolve();
    },
    createEventSource: (u) => new FakeES(u) as any,
    onState: (s) => states.push(s),
    ...over,
  });
  return {
    rs,
    states,
    registers: () => registers,
    latest: () => FakeES.all[FakeES.all.length - 1],
  };
}

Deno.test("resilient: forwards events to listeners and reports open", () => {
  const time = new FakeTime();
  try {
    const { rs, states, latest } = setup();
    const got: unknown[] = [];
    rs.addEventListener("score_update", (e) => got.push(JSON.parse(e.data)));
    latest().open();
    latest().emit("score_update", { a: 1 });
    assertEquals(got, [{ a: 1 }]);
    assertEquals(states, ["connecting", "open"]);
    rs.close();
  } finally {
    time.restore();
  }
});

Deno.test("resilient: watchdog reopens after silence; pings keep it alive", async () => {
  const time = new FakeTime();
  try {
    const { rs, latest, registers } = setup({
      watchdogMs: 45_000,
      backoffMs: [1000],
    });
    latest().open();
    await time.tickAsync(40_000);
    latest().emit("ping"); // server keepalive resets the watchdog
    await time.tickAsync(40_000);
    assertEquals(FakeES.all.length, 1); // still the original connection

    await time.tickAsync(10_000); // 50s of silence in total since the ping
    assertEquals(FakeES.all[0].closed, true);
    await time.tickAsync(1_000); // backoff
    assertEquals(FakeES.all.length, 2);
    assertEquals(registers(), 1); // cookie refreshed before reopening
    rs.close();
  } finally {
    time.restore();
  }
});

Deno.test("resilient: browser giving up (401) => refresh token, reopen with backoff; listeners survive", async () => {
  const time = new FakeTime();
  try {
    const { rs, states, latest, registers } = setup({
      backoffMs: [1000, 2000],
    });
    const got: string[] = [];
    rs.addEventListener("enable_scoring", () => got.push("enable"));
    latest().open();

    latest().giveUp();
    assertEquals(states.at(-1), "reconnecting");
    await time.tickAsync(999);
    assertEquals(FakeES.all.length, 1);
    await time.tickAsync(1);
    assertEquals(FakeES.all.length, 2);
    assertEquals(registers(), 1);

    latest().open();
    latest().emit("enable_scoring"); // handler was re-attached to the new connection
    assertEquals(got, ["enable"]);
    assertEquals(states.at(-1), "open");
    rs.close();
  } finally {
    time.restore();
  }
});

Deno.test("resilient: backoff grows while failing and resets after a successful open", async () => {
  const time = new FakeTime();
  try {
    const { rs, latest } = setup({ backoffMs: [1000, 2000, 5000] });
    latest().giveUp();
    await time.tickAsync(1000);
    latest().giveUp();
    await time.tickAsync(1999);
    assertEquals(FakeES.all.length, 2);
    await time.tickAsync(1);
    assertEquals(FakeES.all.length, 3);

    latest().open(); // success resets
    latest().giveUp();
    await time.tickAsync(1000);
    assertEquals(FakeES.all.length, 4);
    rs.close();
  } finally {
    time.restore();
  }
});

Deno.test("resilient: register failure keeps retrying instead of giving up", async () => {
  const time = new FakeTime();
  try {
    let calls = 0;
    const { rs, latest } = setup({
      backoffMs: [1000],
      register: () =>
        ++calls < 3 ? Promise.reject(new Error("offline")) : Promise.resolve(),
    });
    latest().giveUp();
    await time.tickAsync(1000); // register fails
    assertEquals(FakeES.all.length, 1);
    await time.tickAsync(1000); // fails again
    assertEquals(FakeES.all.length, 1);
    await time.tickAsync(1000); // succeeds
    assertEquals(FakeES.all.length, 2);
    rs.close();
  } finally {
    time.restore();
  }
});

Deno.test("resilient: 'superseded' stops for good (no reconnect fight between tabs)", async () => {
  const time = new FakeTime();
  try {
    const { rs, states, latest } = setup({ backoffMs: [1000] });
    latest().open();
    latest().emit("superseded");
    assertEquals(states.at(-1), "closed");
    assertEquals(latest().closed, true);
    await time.tickAsync(120_000);
    assertEquals(FakeES.all.length, 1);
    rs.close();
  } finally {
    time.restore();
  }
});

Deno.test("resilient: close() cancels timers", async () => {
  const time = new FakeTime();
  try {
    const { rs, latest } = setup();
    latest().giveUp();
    rs.close();
    await time.tickAsync(120_000);
    assertEquals(FakeES.all.length, 1);
  } finally {
    time.restore();
  }
});
