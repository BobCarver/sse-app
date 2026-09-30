/// <reference lib="dom" />
import { Competition } from "../src/types.ts";

import type {
  ClientStatusMessage,
  CompetitionStartMessage,
  PerformanceStartMessage,
} from "../src/protocol.ts";
import { assert } from "@std/assert";
import { escapeHtml } from "./html.ts";
import type { SseLike } from "./connect.ts";

export interface sseClientDependencies {
  document?: Document;
  sse?: SseLike;
}

/**
 * Format time in 24-hour format HH:MM
 */
function formatTime(date: Date): string {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Collapse top visible row
 */

export class sseClient {
  competition: Competition | null = null;
  position: number | undefined = undefined;
  protected doc: Document;
  /** The single SSE connection for this page; subclasses add listeners to it. */
  protected sse: SseLike;
  private tbody: HTMLTableSectionElement | null;

  constructor(deps: sseClientDependencies = {}) {
    this.doc = deps.document || document;
    this.tbody = this.doc.querySelector(
      "#compTable tbody",
    ) as HTMLTableSectionElement;

    const sse = this.sse = deps.sse || new EventSource("/events");
    sse.addEventListener(
      "competition_start",
      ({ data }) => {
        const { competition } = JSON.parse(data) as CompetitionStartMessage;
        this.competition = competition;
        this.position = 0;
        this.tbody?.style.setProperty("--hide-count", String(0));
        this.buildCompetitorTable();
        this.setText("currentCompetition", competition.name);
      },
    );
    sse.addEventListener(
      "performance_start",
      ({ data }) => {
        const { position } = JSON.parse(data) as PerformanceStartMessage;
        assert(typeof position === "number");
        this.position = position;
        this.setText(
          "currentCompetitor",
          this.competition?.competitors[position]?.name ?? "",
        );
        this.updateTimes();
        this.tbody?.style.setProperty("--hide-count", String(position));
      },
    );
    sse.addEventListener("superseded", () => {
      // Another window took over this client id. Stop; do not fight for it.
      this.setStatus(
        "This page was opened in another window and is now inactive",
      );
      sse.close();
    });
    sse.addEventListener("client_status", ({ data }) => {
      // TODO: render connected clients (roster) in the UI
      JSON.parse(data) as ClientStatusMessage;
    });
  }

  /** Set textContent of #id if the page has it. */
  protected setText(id: string, text: string): void {
    const el = this.doc.getElementById(id);
    if (el) el.textContent = text;
  }

  /** Show a message in #status (empty string clears it). */
  protected setStatus(message: string): void {
    this.setText("status", message);
  }

  buildCompetitorTable(): void {
    if (this.tbody) {
      this.tbody.innerHTML =
        this.competition!.competitors.reduce<[html: string, ms: number]>(
          ([html, ms], c) => [
            html + `<tr>
          <td class="time-col">${formatTime(new Date(ms))}</td>
          <td>${escapeHtml(c.name)}</td></tr>`,
            ms + c.duration,
          ],
          ["", Date.now()],
        )[0];
    }
  }
  updateTimes() {
    if (this.tbody?.rows.length) {
      let t = new Date(Date.now());
      for (let i = this.position!; i < this.tbody.rows.length; i++) {
        const duration = this.competition!.competitors[i].duration;
        const cell = this.tbody.rows[i].cells[0];
        cell.textContent = formatTime(t);
        t = new Date(t.getTime() + duration); // Add duration to total time
      }
    }
  }
}
