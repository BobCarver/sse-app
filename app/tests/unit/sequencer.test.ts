// The sequencer keeps each track's open session armed.
import { assertEquals } from "@std/assert";
import { Sequencer, type SequencerDeps } from "../../src/sequencer.ts";
import { delay } from "../test-utils.ts";

/** Track 1 runs sessions 10, 11, 12 in order; `done` and `open` are the database. */
function setup(over: Partial<SequencerDeps> = {}) {
  const done = new Set<number>();
  let open: number | undefined;
  const started: [number, boolean][] = [];
  const running = new Set<number>();
  const seq = new Sequencer({
    tracks: () => [1],
    nextFor: (trackId) => {
      const id = open ?? [10, 11, 12].find((s) => !done.has(s));
      return Promise.resolve(
        trackId === 1 && id !== undefined
          ? { sessionId: id, started: id === open }
          : undefined,
      );
    },
    busy: (trackId) => trackId === 1 && running.size > 0,
    start: (sessionId, resumed) => {
      started.push([sessionId, resumed]);
      running.add(sessionId);
      return Promise.resolve({ status: 200, body: {} });
    },
    ...over,
  });
  return {
    seq,
    started,
    done,
    running,
    setOpen: (id?: number) => (open = id),
  };
}

Deno.test("sequencer: off by default; when on it arms the first session not done", async () => {
  const { seq, started, done } = setup();
  await seq.armAll();
  assertEquals(started, []); // not enabled
  seq.enabled = true;
  done.add(10);
  await seq.armAll();
  assertEquals(started, [[11, false]]);
});

Deno.test("sequencer: after a crash the open session is armed first, resumed", async () => {
  const { seq, started, setOpen } = setup();
  seq.enabled = true;
  setOpen(12); // holds the track (cut off mid-way)
  await seq.armAll();
  assertEquals(started, [[12, true]]);
});

Deno.test("sequencer: a track already running a session is left alone", async () => {
  const { seq, started, running } = setup();
  seq.enabled = true;
  running.add(10);
  assertEquals(await seq.armTrack(1), undefined);
  assertEquals(started, []);
});

Deno.test("sequencer: after End session (or a cancel) the track moves on to its next session", async () => {
  const { seq, started, done, running } = setup();
  seq.enabled = true;
  await seq.armAll();
  assertEquals(started, [[10, false]]);
  // Session 10 completes.
  done.add(10);
  running.clear();
  seq.sessionEnded(1, "completed");
  await delay(10);
  assertEquals(started, [[10, false], [11, false]]);
  // Session 11 is cancelled.
  done.add(11);
  running.clear();
  seq.sessionEnded(1, "cancelled");
  await delay(10);
  assertEquals(started.at(-1), [12, false]);
});

Deno.test("sequencer: an error or a shutdown is not re-armed (no restart loop)", async () => {
  const { seq, started, running } = setup();
  seq.enabled = true;
  running.clear();
  seq.sessionEnded(1, "error");
  seq.sessionEnded(1, "aborted");
  await delay(10);
  assertEquals(started, []);
});

Deno.test("sequencer: a track with nothing left is quiet; a failed start is reported, not thrown", async () => {
  const { seq, done } = setup({
    start: () => Promise.resolve({ status: 409, body: { error: "x" } }),
  });
  seq.enabled = true;
  assertEquals(await seq.armTrack(1), undefined); // refused: no session armed
  done.add(10).add(11).add(12);
  assertEquals(await seq.armTrack(1), undefined);
});
