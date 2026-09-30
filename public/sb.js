// app/frontend-src/connect.ts
var AuthError = class extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
};
var ResilientEventSource = class {
  listeners = /* @__PURE__ */ new Map();
  es = null;
  attached = /* @__PURE__ */ new Set();
  watchdog;
  retry;
  attempts = 0;
  stopped = false;
  opts;
  constructor(opts) {
    this.opts = {
      url: "/events",
      watchdogMs: 45e3,
      backoffMs: [
        1e3,
        2e3,
        5e3,
        1e4
      ],
      createEventSource: (url) => new EventSource(url),
      ...opts
    };
    this.open();
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    if (this.es) this.attach(this.es, type);
  }
  close() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    this.es?.close();
    this.es = null;
    this.opts.onState?.("closed");
  }
  open() {
    if (this.stopped) return;
    const es = this.opts.createEventSource(this.opts.url);
    this.es = es;
    this.attached.clear();
    this.opts.onState?.(this.attempts === 0 ? "connecting" : "reconnecting");
    es.addEventListener("open", () => {
      this.attempts = 0;
      this.opts.onState?.("open");
      this.arm();
    });
    es.addEventListener("error", () => {
      if (this.stopped || this.es !== es) return;
      this.opts.onState?.("reconnecting");
      if (es.readyState === 2) this.reopenLater();
    });
    for (const type of /* @__PURE__ */ new Set([
      "ping",
      "superseded",
      ...this.listeners.keys()
    ])) {
      this.attach(es, type);
    }
    this.arm();
  }
  attach(es, type) {
    if (this.attached.has(type)) return;
    this.attached.add(type);
    es.addEventListener(type, (e) => {
      if (this.es !== es) return;
      this.arm();
      if (type === "superseded") this.close();
      for (const l of this.listeners.get(type) ?? []) l(e);
    });
  }
  arm() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.opts.onState?.("reconnecting");
      this.reopenLater();
    }, this.opts.watchdogMs);
  }
  reopenLater() {
    if (this.stopped) return;
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    this.es?.close();
    this.es = null;
    const { backoffMs } = this.opts;
    const delay = backoffMs[Math.min(this.attempts++, backoffMs.length - 1)];
    this.retry = setTimeout(async () => {
      try {
        await this.opts.ensureSession();
      } catch (err) {
        if (err instanceof AuthError) {
          this.stopped = true;
          this.opts.onState?.("unauthorized");
          return;
        }
        return this.reopenLater();
      }
      this.open();
    }, delay);
  }
};
async function whoami() {
  const res = await fetch("/session", {
    cache: "no-store"
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`session check failed: ${res.status}`);
  return (await res.json()).client_id;
}
async function connect(kind, onState) {
  const clientId = await whoami();
  const m = /^(dj|judge|sb)(\d+)$/.exec(clientId);
  if (!m || m[1] !== kind) {
    throw new Error(`This link is for "${clientId}", not a ${kind} page`);
  }
  const sse = new ResilientEventSource({
    ensureSession: async () => {
      await whoami();
    },
    onState
  });
  return {
    clientId,
    num: Number(m[2]),
    sse
  };
}
async function bootstrap(kind, build) {
  try {
    const { num, sse } = await connect(kind, showConnection);
    const client = build(num, sse);
    globalThis.addEventListener("pagehide", () => {
      client?.destroy?.();
      sse.close();
    });
  } catch (err) {
    const message = err instanceof AuthError ? "This page needs a valid link. Ask an administrator for a new one." : err.message;
    const el = document.getElementById("status") ?? document.getElementById("connection");
    if (el) el.textContent = message;
    console.error(err);
  }
}
function showConnection(state) {
  const el = document.getElementById("connection");
  if (!el) return;
  el.textContent = {
    connecting: "Connecting...",
    open: "",
    reconnecting: "Connection lost - reconnecting...",
    closed: "Disconnected",
    unauthorized: "Access revoked - ask an administrator for a new link"
  }[state];
}

// app/frontend-src/html.ts
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

// deno:https://jsr.io/@std/assert/1.0.18/assertion_error.ts
var AssertionError = class extends Error {
  /** Constructs a new instance.
   *
   * @param message The error message.
   * @param options Additional options. This argument is still unstable. It may change in the future release.
   */
  constructor(message, options) {
    super(message, options);
    this.name = "AssertionError";
  }
};

// deno:https://jsr.io/@std/assert/1.0.18/equal.ts
var Temporal = globalThis.Temporal ?? /* @__PURE__ */ Object.create(null);
var stringComparablePrototypes = new Set([
  Intl.Locale,
  RegExp,
  Temporal.Duration,
  Temporal.Instant,
  Temporal.PlainDate,
  Temporal.PlainDateTime,
  Temporal.PlainTime,
  Temporal.PlainYearMonth,
  Temporal.PlainMonthDay,
  Temporal.ZonedDateTime,
  URL,
  URLSearchParams
].filter((x) => x != null).map((x) => x.prototype));
var TypedArray = Object.getPrototypeOf(Uint8Array);

// deno:https://jsr.io/@std/internal/1.0.12/styles.ts
var { Deno } = globalThis;
var noColor = typeof Deno?.noColor === "boolean" ? Deno.noColor : false;
var ANSI_PATTERN = new RegExp([
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
  "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TXZcf-nq-uy=><~]))"
].join("|"), "g");

// deno:https://jsr.io/@std/assert/1.0.18/assert.ts
function assert(expr, msg = "") {
  if (!expr) {
    throw new AssertionError(msg);
  }
}

// app/frontend-src/sseClient.ts
function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
var sseClient = class {
  competition = null;
  position = void 0;
  doc;
  /** The single SSE connection for this page; subclasses add listeners to it. */
  sse;
  tbody;
  constructor(deps = {}) {
    this.doc = deps.document || document;
    this.tbody = this.doc.querySelector("#compTable tbody");
    const sse = this.sse = deps.sse || new EventSource("/events");
    sse.addEventListener("competition_start", ({ data }) => {
      const { competition } = JSON.parse(data);
      this.competition = competition;
      this.position = 0;
      this.tbody?.style.setProperty("--hide-count", String(0));
      this.buildCompetitorTable();
      this.setText("currentCompetition", competition.name);
    });
    sse.addEventListener("performance_start", ({ data }) => {
      const { position } = JSON.parse(data);
      assert(typeof position === "number");
      this.position = position;
      this.setText("currentCompetitor", this.competition?.competitors[position]?.name ?? "");
      this.updateTimes();
      this.tbody?.style.setProperty("--hide-count", String(position));
    });
    sse.addEventListener("superseded", () => {
      this.setStatus("This page was opened in another window and is now inactive");
      sse.close();
    });
    sse.addEventListener("client_status", ({ data }) => {
      JSON.parse(data);
    });
  }
  /** Set textContent of #id if the page has it. */
  setText(id, text) {
    const el = this.doc.getElementById(id);
    if (el) el.textContent = text;
  }
  /** Show a message in #status (empty string clears it). */
  setStatus(message) {
    this.setText("status", message);
  }
  buildCompetitorTable() {
    if (this.tbody) {
      this.tbody.innerHTML = this.competition.competitors.reduce(([html, ms], c) => [
        html + `<tr>
          <td class="time-col">${formatTime(new Date(ms))}</td>
          <td>${escapeHtml(c.name)}</td></tr>`,
        ms + c.duration
      ], [
        "",
        Date.now()
      ])[0];
    }
  }
  updateTimes() {
    if (this.tbody?.rows.length) {
      let t = new Date(Date.now());
      for (let i = this.position; i < this.tbody.rows.length; i++) {
        const duration = this.competition.competitors[i].duration;
        const cell = this.tbody.rows[i].cells[0];
        cell.textContent = formatTime(t);
        t = new Date(t.getTime() + duration);
      }
    }
  }
};

// app/frontend-src/sb.ts
var ScoreboardClient = class extends sseClient {
  cId2Row = /* @__PURE__ */ new Map();
  jId2Col = /* @__PURE__ */ new Map();
  scoreboard;
  scoreForCompetitor = void 0;
  doc;
  constructor(deps = {}) {
    super(deps);
    this.doc = deps.document || document;
    this.scoreboard = this.doc.querySelector("#scoreboard");
    this.sse.addEventListener("competition_start", ({ data }) => {
      const msg = JSON.parse(data);
      this.makeScoreboard(msg.competition.rubric);
    });
    this.sse.addEventListener("performance_start", () => {
      this.scoreForCompetitor = void 0;
      this.clearTable();
    });
    this.sse.addEventListener("score_update", ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.competitor_id != this.scoreForCompetitor) {
        this.scoreForCompetitor = msg.competitor_id;
        this.clearTable();
      }
      this.updateScores(msg);
    });
  }
  makeScoreboard({ judges, criteria }) {
    const cells = `<td></td>
`.repeat(judges.length);
    this.scoreboard.innerHTML = `<thead><tr><th>Criteria</th>${judges.reduce((s, j) => s + `<th>${escapeHtml(j.name)}</th>`, "")}
      </tr></thead>
      <tbody>${criteria.reduce((s, c) => s + `<tr><th>${escapeHtml(c.name)}</th>${cells}</tr>`, "")}
      </tbody>`;
    this.jId2Col.clear();
    this.cId2Row.clear();
    judges.forEach((j, i) => this.jId2Col.set(j.id, i));
    criteria.forEach((c, i) => this.cId2Row.set(c.id, i));
  }
  clearTable() {
    this.scoreboard.querySelectorAll("td").forEach((cell) => cell.textContent = "");
  }
  updateScores({ competition_id, competitor_id, judge_id, scores }) {
    if (!this.competition || this.position === void 0) return;
    if (competition_id !== this.competition.id || competitor_id !== this.competition.competitors[this.position].id) return;
    scores.forEach(({ criteria_id, score }) => {
      const row = this.cId2Row.get(criteria_id);
      const col = this.jId2Col.get(judge_id);
      if (row !== void 0 && col !== void 0) {
        const cell = this.scoreboard.rows[1 + row].cells[1 + col];
        cell.textContent = score.toString();
      }
    });
  }
};

// app/frontend-src/main-sb.ts
await bootstrap("sb", (_num, sse) => {
  new ScoreboardClient({
    sse
  });
});
