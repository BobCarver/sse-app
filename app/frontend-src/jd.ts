/// <reference lib="dom" />
import { CompetitionStartMessage } from "../src/protocol.ts";
import { Rubric } from "../src/types.ts";
import { sseClient } from "./sseClient.ts";
export interface JudgeDependencies {
  sse?: EventSource;
  document?: Document;
  navigator?: Navigator;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export class JudgeClient extends sseClient {
  private alert: number | undefined = undefined;
  private sliders: HTMLElement;
  private submit: HTMLButtonElement;
  protected override doc: Document;
  private nav: Navigator;
  private timerFn: typeof setTimeout;
  private clearTimerFn: typeof clearTimeout;

  constructor(
    private judge_id: number,
    deps: JudgeDependencies = {},
  ) {
    super(deps);
    this.doc = deps.document || document;
    this.nav = deps.navigator || navigator;
    this.timerFn = deps.setTimeout ?? globalThis.setTimeout;
    this.clearTimerFn = deps.clearTimeout ?? globalThis.clearTimeout;
    this.judge_id = judge_id;

    this.sliders = this.doc.querySelector("#sliders")! as HTMLElement;
    this.submit = this.doc.querySelector("#submit")! as HTMLButtonElement;

    this.sliders.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      const scoreDisplay = target.nextElementSibling as HTMLElement | null;
      if (!scoreDisplay) return;
      const val = target.value === "" ? "0" : target.value;
      scoreDisplay.textContent = parseFloat(val).toFixed(1);
    });
    this.submit.onclick = this.submitScores.bind(this);
    this.submit.disabled = true;
    const sse = deps.sse || new EventSource("/events");
    sse.addEventListener(
      "competition_start",
      ({ data }) => {
        const { competition } = JSON.parse(data) as CompetitionStartMessage;
        this.competition = competition;
        // set up rubric criteria sliders
        this.updateCriteria(competition.rubric);
      },
    );

    sse.addEventListener("enable_scoring", () => {
      // nothing to do except enable the submit button
      this.enableSubmit();
    });
  }

  updateCriteria(rubric: Rubric): void {
    const judge = rubric.judges.find(({ id }) => id === this.judge_id);
    if (!judge) {
      this.sliders.innerHTML = "";
      return;
    }
    const criteria = rubric.criteria.filter(
      ({ id }) => judge!.criteria.includes(id),
    );

    this.sliders.innerHTML = criteria.reduce((acc: string, c) =>
      acc +
      `<div class="slider-group">
                <label>${c.name}</label>
                <input type="range" class="slider"
                    data-criterion-id="${c.id}"
                    min="1" max="10" step="0.1">
                <span class="score">5.0</span>
            </div>`, "");
  }

  alarm() {
    this.nav.vibrate?.(1000);
    this.doc.body.style.backgroundColor = "#ff0000";
    this.timerFn(() => {
      this.doc.body.style.backgroundColor = "";
    }, 500);
  }

  enableSubmit(): void {
    this.sliders.querySelectorAll("input").forEach((s) => {
      s.value = "5";
      s.nextElementSibling!.textContent = "5.0";
    });
    this.submit.disabled = false;
    this.alert = this.timerFn(this.alarm.bind(this), 30000);
  }

  submitScores() {
    if (!this.competition || this.position === undefined) return;
    this.submit.disabled = true;
    if (this.alert !== undefined) {
      this.clearTimerFn(this.alert);
      this.alert = undefined;
    }
    const scores: { criteria_id: number; score: number }[] = [];
    (this.sliders.querySelectorAll("input") as NodeListOf<HTMLInputElement>)
      .forEach((slider) => {
        scores.push({
          criteria_id: Number(slider.dataset.criterionId),
          score: Number(slider.value),
        });
      });
    const competitionId = this.competition!.id;
    const competitorId = this.competition!.competitors[this.position!].id;
    // derive base URL from location or default to localhost for testing
    const base = globalThis.location?.origin ?? "http://localhost";

    if (!this.sessionId) {
      // If sessionId is missing, try to derive from document body dataset, else warn
      console.warn("JudgeClient: sessionId not specified; submit aborted");
      return;
    }

    fetch(
      `${base}/response`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag: `score:${competitionId}:${competitorId}:${this.judge_id}`,
          scores: scores,
        }),
      },
    );
    this.submit.disabled = true;
  }

  destroy(): void {
    if (this.alert !== undefined) {
      this.clearTimerFn(this.alert);
      this.alert = undefined;
    }
  }
}
