// Statuses are derived from the cursor (progress.ts), not stored.
import { assertEquals } from "@std/assert";
import {
  type Cursor,
  deriveStatus,
  NOT_STARTED,
  type OrderedCompetition,
  type SessionProgress,
} from "../../src/progress.ts";

const ORDER: OrderedCompetition[] = [
  { id: 10, competitorIds: [100, 101], judges: 2 },
  { id: 11, competitorIds: [110, 111], judges: 2 },
];
const open = (cursor: Cursor | null): SessionProgress => ({
  finished: false,
  cancelled: false,
  open: true,
  cursor,
});
const at = (
  competitionId: number,
  competitorId: number,
  phase: Cursor["phase"],
) => ({ competitionId, competitorId, phase });

const flat = (d: ReturnType<typeof deriveStatus>) => ({
  session: d.session,
  competitions: [...d.competitions.values()],
  competitors: [...d.competitors.values()],
});

Deno.test("deriveStatus: a session that has not started is upcoming throughout", () => {
  assertEquals(flat(deriveStatus(ORDER, NOT_STARTED, new Set())), {
    session: "upcoming",
    competitions: ["upcoming", "upcoming"],
    competitors: ["upcoming", "upcoming", "upcoming", "upcoming"],
  });
});

Deno.test("deriveStatus: before the cursor finished, on it in progress, after it upcoming", () => {
  assertEquals(
    flat(deriveStatus(ORDER, open(at(11, 110, "performing")), new Set())),
    {
      session: "in_progress",
      competitions: ["finished", "in_progress"],
      competitors: ["finished", "finished", "in_progress", "upcoming"],
    },
  );
});

Deno.test("deriveStatus: an armed session that has not begun is upcoming", () => {
  const armed = open(at(10, 100, null));
  assertEquals(flat(deriveStatus(ORDER, armed, new Set())).session, "upcoming");
  assertEquals(
    flat(deriveStatus(ORDER, { ...armed, started: true }, new Set())).session,
    "in_progress",
  );
});

Deno.test("deriveStatus: the next competitor waiting to begin is upcoming", () => {
  const d = flat(deriveStatus(ORDER, open(at(11, 110, null)), new Set()));
  assertEquals(d.competitions, ["finished", "upcoming"]);
  assertEquals(d.competitors, ["finished", "finished", "upcoming", "upcoming"]);
  // Between two competitors of one competition, it is under way.
  assertEquals(
    flat(deriveStatus(ORDER, open(at(10, 101, null)), new Set())).competitions,
    ["in_progress", "upcoming"],
  );
});

Deno.test("deriveStatus: scoring is finished once every judge has scored", () => {
  const scored = new Map([["10:100", 2]]);
  assertEquals(
    flat(deriveStatus(ORDER, open(at(10, 100, "scoring")), new Set(), scored))
      .competitors[0],
    "finished",
  );
  assertEquals(
    flat(
      deriveStatus(
        ORDER,
        open(at(10, 100, "scoring")),
        new Set(),
        new Map([["10:100", 1]]),
      ),
    ).competitors[0],
    "in_progress",
  );
});

Deno.test("deriveStatus: skips are recorded, not derived", () => {
  const skipped = new Set(["10:101"]);
  assertEquals(
    flat(deriveStatus(ORDER, open(at(11, 110, "performing")), skipped))
      .competitors,
    ["finished", "skipped", "in_progress", "upcoming"],
  );
});

Deno.test("deriveStatus: an open session with no cursor has every competitor done", () => {
  assertEquals(
    flat(deriveStatus(ORDER, open(null), new Set(["11:111"]))),
    {
      session: "in_progress", // waits to be ended
      competitions: ["finished", "finished"],
      competitors: ["finished", "finished", "finished", "skipped"],
    },
  );
});

Deno.test("deriveStatus: a finished session is finished throughout", () => {
  const done = { ...NOT_STARTED, finished: true };
  assertEquals(flat(deriveStatus(ORDER, done, new Set(["10:100"]))), {
    session: "finished",
    competitions: ["finished", "finished"],
    competitors: ["skipped", "finished", "finished", "finished"],
  });
});

Deno.test("deriveStatus: a cancelled session keeps what was scored or skipped", () => {
  const cancelled = { ...NOT_STARTED, cancelled: true };
  assertEquals(
    flat(
      deriveStatus(
        ORDER,
        cancelled,
        new Set(["10:101"]),
        new Map([["10:100", 1]]),
      ),
    ),
    {
      session: "finished",
      competitions: ["finished", "upcoming"],
      competitors: ["finished", "skipped", "upcoming", "upcoming"],
    },
  );
});

Deno.test("deriveStatus: a cursor outside the running order shows upcoming, not a guess", () => {
  assertEquals(
    flat(deriveStatus(ORDER, open(at(99, 1, "performing")), new Set()))
      .competitors,
    ["upcoming", "upcoming", "upcoming", "upcoming"],
  );
});
