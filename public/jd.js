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

// src/frontend/jd.ts
var JudgeClient = class extends sseClient {
  judge_id;
  alert;
  sliders;
  submit;
  doc;
  nav;
  timerFn;
  clearTimerFn;
  constructor(judge_id, deps = {}) {
    super(deps), this.judge_id = judge_id, this.alert = void 0;
    this.doc = deps.document || document;
    this.nav = deps.navigator || navigator;
    this.timerFn = deps.setTimeout ?? globalThis.setTimeout;
    this.clearTimerFn = deps.clearTimeout ?? globalThis.clearTimeout;
    this.judge_id = judge_id;
    this.sliders = this.doc.querySelector("#sliders");
    this.submit = this.doc.querySelector("#submit");
    this.sliders.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      const scoreDisplay = target.nextElementSibling;
      if (!scoreDisplay) return;
      const val = target.value === "" ? "0" : target.value;
      scoreDisplay.textContent = parseFloat(val).toFixed(1);
    });
    this.submit.onclick = this.submitScores.bind(this);
    this.submit.disabled = true;
    const sse = deps.sse || new EventSource("/events");
    sse.addEventListener("competition_start", ({ data }) => {
      const { competition } = JSON.parse(data);
      this.competition = competition;
      this.updateCriteria(competition.rubric);
    });
    sse.addEventListener("enable_scoring", () => {
      this.enableSubmit();
    });
  }
  updateCriteria(rubric) {
    const judge = rubric.judges.find(({ id }) => id === this.judge_id);
    if (!judge) {
      this.sliders.innerHTML = "";
      return;
    }
    const criteria = rubric.criteria.filter(({ id }) => judge.criteria.includes(id));
    this.sliders.innerHTML = criteria.reduce((acc, c) => acc + `<div class="slider-group">
                <label>${c.name}</label>
                <input type="range" class="slider"
                    data-criterion-id="${c.id}"
                    min="1" max="10" step="0.1">
                <span class="score">5.0</span>
            </div>`, "");
  }
  alarm() {
    this.nav.vibrate?.(1e3);
    this.doc.body.style.backgroundColor = "#ff0000";
    this.timerFn(() => {
      this.doc.body.style.backgroundColor = "";
    }, 500);
  }
  enableSubmit() {
    this.sliders.querySelectorAll("input").forEach((s) => {
      s.value = "5";
      s.nextElementSibling.textContent = "5.0";
    });
    this.submit.disabled = false;
    this.alert = this.timerFn(this.alarm.bind(this), 3e4);
  }
  submitScores() {
    if (!this.competition || this.position === void 0) return;
    this.submit.disabled = true;
    if (this.alert !== void 0) {
      this.clearTimerFn(this.alert);
      this.alert = void 0;
    }
    const scores = [];
    this.sliders.querySelectorAll("input").forEach((slider) => {
      scores.push({
        criteria_id: Number(slider.dataset.criterionId),
        score: Number(slider.value)
      });
    });
    const competitionId = this.competition.id;
    const competitorId = this.competition.competitors[this.position].id;
    const base = globalThis.location?.origin ?? "http://localhost";
    if (!this.sessionId) {
      console.warn("JudgeClient: sessionId not specified; submit aborted");
      return;
    }
    fetch(`${base}/response`, {
      method: "POST",
I will finish creating the file...