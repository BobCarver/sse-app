/// <reference lib="dom" />
import { CompetitionStartMessage } from "../src/protocol.ts";
import { Rubric } from "../src/types.ts";
import { scoreTag } from "../src/contract.ts";
import { postResponse, type SseLike } from "./connect.ts";
import { escapeHtml } from "./html.ts";
import { sseClient } from "./sseClient.ts";
export interface JudgeDependencies {
  sse?: SseLike;
  document?: Document;
  navigator?: Navigator;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export class JudgeClient extends sseClient {
  private alert: ReturnType<typeof setTimeout> | undefined = undefined;
  /** Which competition the sliders were built for (replays must not rebuild them). */
  private renderedCompetitionId: number | undefined = undefined;
  /** "competitionId:position" of the scoring window currently open, if any. */
  private scoringKey: string | undefined = undefined;
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
    // Bind to globalThis: browsers throw "Illegal invocation" when these are
    // called as methods of another object (this.timerFn(...)).
    this.timerFn = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimerFn = deps.clearTimeout ??
      globalThis.clearTimeout.bind(globalThis);
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
    this.sse.addEventListener(
      "competition_start",
      ({ data }) => {
        const { competition } = JSON.parse(data) as CompetitionStartMessage;
        this.competition = competition;
        // Replayed on reconnect: keep sliders (and anything the judge already
        // set) if they are for this same competition.
        if (this.renderedCompetitionId === competition.id) return;
        this.renderedCompetitionId = competition.id;
        this.updateCriteria(competition.rubric);
      },
    );

    this.sse.addEventListener("enable_scoring", ({ data }) => {
      // Replayed on reconnect while a window is already open: don't reset the
      // judge's sliders or restart the alarm.
      const msg = JSON.parse(data || "{}");
      const key = `${msg.competition_id}:${msg.position}`;
      if (this.scoringKey === key && !this.submit.disabled) return;
      this.scoringKey = key;
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
                <label>${escapeHtml(c.name)}</label>
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

    this.setStatus("Submitting...");
    postResponse({
      tag: scoreTag(competitionId, competitorId, this.judge_id),
      payload: scores,
    }).then(({ ok, status }) => {
      if (ok) {
        this.setStatus("Scores submitted");
      } else if (status === 401 || status === 403) {
        this.setStatus("Access denied - ask an administrator for a new link");
      } else if (status === 404) {
        // Scoring window closed (timed out) or already recorded.
        this.setStatus("Too late - scoring for this competitor has closed");
      } else {
        // Network/server failure after retries: let the judge try again.
        this.setStatus("Submit failed - tap Submit to retry");
        this.submit.disabled = false;
      }
    });
  }

  destroy(): void {
    if (this.alert !== undefined) {
      this.clearTimerFn(this.alert);
      this.alert = undefined;
    }
  }
}
