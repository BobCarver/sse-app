/// <reference lib="dom" />
import { CompetitorId, Rubric } from "../types.ts";
import { sseClient } from "./sseClient.ts";
import type {
  CompetitionStartMessage,
  ScoreUpdateMessage,
} from "../protocol.ts";

export interface ScoreboardDependencies {
  document?: Document;
  sse?: EventSource;
}

export class ScoreboardClient extends sseClient {
  private readonly cId2Row = new Map<number, number>();
  private readonly jId2Col = new Map<number, number>();

  private scoreboard: HTMLTableElement;
  private scoreForCompetitor: CompetitorId | undefined = undefined;
  protected override doc: Document;

  constructor(deps: ScoreboardDependencies = {}) {
    super(deps);
    this.doc = deps.document || document;
    this.scoreboard = this.doc.querySelector("#scoreboard") as HTMLTableElement;
    const sse = deps.sse || new EventSource("/events");
    sse.addEventListener(
      "competition_start",
      ({ data }) => {
        const msg = JSON.parse(data) as CompetitionStartMessage;
        this.makeScoreboard(msg.competition.rubric);
      },
    );

    //.on("performance_start", ({ position }) => {})
    // .on("enable_scoring", (msg) => {
    //       msg.
    //       const currentCompetition = document.querySelector(
    //         "#current-competition",
    //       );
    //       this.clearTable(); // update competitor info
    //     });
    sse.addEventListener("score_update", ({ data }) => {
      const msg = JSON.parse(data) as ScoreUpdateMessage;
      if (msg.competitor_id != this.scoreForCompetitor) {
        this.scoreForCompetitor = msg.competitor_id;
        this.clearTable();
      }
      this.updateScores(msg);
    });
  }

  makeScoreboard({ judges, criteria }: Rubric): void {
    const cells = `<td></td>\n`.repeat(judges.length);
    this.scoreboard.innerHTML = `<thead><tr><th>Criteria</th>${
      judges.reduce((s: string, j) => s + `<th>${j.name}</th>`, "")
    }
      </tr></thead>
      <tbody>${
      criteria.reduce((s: string, c) =>
        s + `<tr><th>${c.name}</th>${cells}</tr>`, "")
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
