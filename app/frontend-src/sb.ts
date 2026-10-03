/// <reference lib="dom" />
import { CompetitorId, Rubric } from "../src/types.ts";
import type { SseLike } from "./connect.ts";
import { escapeHtml } from "./html.ts";
import { formatWhen, sseClient } from "./sseClient.ts";
import type {
  CompetitionReadyMessage,
  CompetitionStartMessage,
  ScoreUpdateMessage,
  SessionFinishedMessage,
} from "../src/protocol.ts";

export interface ScoreboardDependencies {
  document?: Document;
  sse?: SseLike;
}

export class ScoreboardClient extends sseClient {
  private readonly cId2Row = new Map<number, number>();
  private readonly jId2Col = new Map<number, number>();

  private scoreboard: HTMLTableElement;
  /**
   * Whose scores are on the board. They stay until the next competitor's first
   * score arrives (not when their performance starts), so the audience can still
   * read the last result while the next act is on.
   */
  private shown: { id: CompetitorId; name: string } | undefined = undefined;
  /** The next competition's layout, applied when its first score arrives. */
  private pendingRubric: Rubric | undefined = undefined;
  protected override doc: Document;

  constructor(deps: ScoreboardDependencies = {}) {
    super(deps);
    this.doc = deps.document || document;
    this.scoreboard = this.doc.querySelector("#scoreboard") as HTMLTableElement;
    this.sse.addEventListener(
      "competition_start",
      ({ data }) => {
        const msg = JSON.parse(data) as CompetitionStartMessage;
        this.hideBanner();
        // With scores on display, keep that board until the new competition's
        // first score arrives; otherwise build the (empty) layout right away.
        if (this.shown) this.pendingRubric = msg.competition.rubric;
        else this.makeScoreboard(msg.competition.rubric);
        this.showLabel();
      },
    );

    // The break between competitions: say what is about to begin (or, after
    // the last one, that the session is over and when the next one starts). The
    // last scores stay on the board, dimmed.
    this.sse.addEventListener("competition_ready", ({ data }) => {
      const { name } = JSON.parse(data) as CompetitionReadyMessage;
      this.showBanner(`Competition “${name}” is about to begin`);
    });
    this.sse.addEventListener("session_finished", ({ data }) => {
      const msg = JSON.parse(data) as SessionFinishedMessage;
      this.showBanner(
        msg.next_session_start
          ? `Session ended. The next session${
            msg.next_session_name ? ` (${msg.next_session_name})` : ""
          } begins at ${formatWhen(msg.next_session_start)}`
          : "Session ended. No further sessions are scheduled on this track.",
      );
    });

    // A new performance does NOT clear the board: the last scores stay up until
    // the new competitor has at least one score (see score_update below). This
    // also makes a replay after a reconnect harmless.
    this.sse.addEventListener("performance_start", () => this.showLabel());

    this.sse.addEventListener("score_update", ({ data }) => {
      const msg = JSON.parse(data) as ScoreUpdateMessage;
      const competitor = this.currentCompetitor();
      // Scores for anyone but the competitor on now are ignored and change nothing.
      if (
        !this.competition || !competitor ||
        msg.competition_id !== this.competition.id ||
        msg.competitor_id !== competitor.id
      ) return;

      if (msg.competitor_id !== this.shown?.id) {
        // First score of a new competitor: only now does the old board give way.
        if (this.pendingRubric) {
          this.makeScoreboard(this.pendingRubric);
          this.pendingRubric = undefined;
        } else this.clearTable();
        this.shown = { id: competitor.id, name: competitor.name };
      }
      this.updateScores(msg);
      this.showLabel();
    });
  }

  private showBanner(text: string): void {
    this.setText("banner", text);
    this.doc.getElementById("banner")?.removeAttribute("hidden");
    this.doc.body?.classList.add("waiting");
  }

  private hideBanner(): void {
    this.setText("banner", "");
    this.doc.getElementById("banner")?.setAttribute("hidden", "");
    this.doc.body?.classList.remove("waiting");
  }

  private currentCompetitor() {
    return this.position === undefined
      ? undefined
      : this.competition?.competitors[this.position];
  }

  /** Say whose scores are on the board, since the heading already shows the next act. */
  private showLabel(): void {
    const current = this.currentCompetitor();
    this.setText(
      "scoresFor",
      !this.shown
        ? ""
        : current && current.id !== this.shown.id
        ? `Last scores: ${this.shown.name}`
        : `Scores: ${this.shown.name}`,
    );
  }

  makeScoreboard({ judges, criteria }: Rubric): void {
    const cells = `<td></td>\n`.repeat(judges.length);
    this.scoreboard.innerHTML = `<thead><tr><th>Criteria</th>${
      judges.reduce((s: string, j) => s + `<th>${escapeHtml(j.name)}</th>`, "")
    }
      </tr></thead>
      <tbody>${
      criteria.reduce((s: string, c) =>
        s + `<tr><th>${escapeHtml(c.name)}</th>${cells}</tr>`, "")
    }
      </tbody>`;

    this.jId2Col.clear();
    this.cId2Row.clear();
    judges.forEach((j, i) => this.jId2Col.set(j.id, i));
    criteria.forEach((c, i) => this.cId2Row.set(c.id, i));
  }

  clearTable(): void {
    (this.scoreboard.querySelectorAll("td"))
      .forEach((cell) => cell.textContent = "");
  }

  updateScores(
    { competition_id, competitor_id, judge_id, scores }: ScoreUpdateMessage,
  ): void {
    if (!this.competition || this.position === undefined) return;
    if (
      competition_id !== this.competition!.id ||
      competitor_id !== this.competition!.competitors[this.position!].id
    ) return;

    scores.forEach(({ criteria_id, score }) => {
      const row = this.cId2Row.get(criteria_id);
      const col = this.jId2Col.get(judge_id);

      if (row !== undefined && col !== undefined) {
        const cell = this.scoreboard.rows[1 + row].cells[1 + col];
        cell.textContent = score.toString();
      }
    });
  }
}
