// deno:https://jsr.io/@std/assert/1.0.16/assertion_error.ts
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

// deno:https://jsr.io/@std/assert/1.0.16/equal.ts
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

// deno:https://jsr.io/@std/assert/1.0.16/assert.ts
function assert(expr, msg = "") {
  if (!expr) {
    throw new AssertionError(msg);
  }
}

// src/frontend/sseClient.ts
function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
var sseClient = class {
  competition = null;
  position = void 0;
  doc;
  sessionId = void 0;
  tbody;
  constructor(deps = {}) {
    this.doc = deps.document || document;
    this.tbody = this.doc.querySelector("#compTable tbody");
    const status = this.doc.getElementById("status");
    const sse = deps.sse || new EventSource("/events");
    sse.addEventListener("competition_start", ({ data }) => {
      const { competition } = JSON.parse(data);
      this.competition = competition;
      this.position = 0;
      this.tbody?.style.setProperty("--hide-count", String(0));
      this.buildCompetitorTable();
    });
    sse.addEventListener("performance_start", ({ data }) => {
      const { position } = JSON.parse(data);
      assert(typeof position === "number");
      this.position = position;
      this.updateTimes();
      this.tbody?.style.setProperty("--hide-count", String(position));
    });
    sse.addEventListener("client_status", ({ data }) => {
      const { connected_clients } = JSON.parse(data);
      connected_clients.forEach((client) => {
      });
    });
  }
  buildCompetitorTable() {
    if (this.tbody) {
      this.tbody.innerHTML = this.competition.competitors.reduce(([html, ms], c) => [
        html + `<tr>
          <td class="time-col">${formatTime(new Date(ms))}</td>
          <td>${c.name}</td></tr>`,
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

// src/frontend/sb.ts
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
    const sse = deps.sse || new EventSource("/events");
    sse.addEventListener("competition_start", ({ data }) => {
      const msg = JSON.parse(data);
      this.makeScoreboard(msg.competition.rubric);
    });
    sse.addEventListener("score_update", ({ data }) => {
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
    this.scoreboard.innerHTML = `<thead><tr><th>Criteria</th>${judges.reduce((s, j) => s + `<th>${j.name}</th>`, "")}
      </tr></thead>
      <tbody>${criteria.reduce((s, c) => s + `<tr><th>${c.name}</th>${cells}</tr>`, "")}
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
export {
  ScoreboardClient
};
