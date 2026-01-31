/// <reference lib="dom" />
import { Competition } from "../types.ts";

import type {
  ClientStatusMessage,
  CompetitionStartMessage,
  PerformanceStartMessage,
} from "../protocol.ts";
import { assert } from "std/assert";

export interface sseClientDependencies {
  document?: Document;
  sse?: EventSource; //EventSource;
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
  protected sessionId: number | undefined = undefined;
  private tbody: HTMLTableSectionElement | null;

  constructor(deps: sseClientDependencies = {}) {
    this.doc = deps.document || document;
    this.tbody = this.doc.querySelector(
      "#compTable tbody",
    ) as HTMLTableSectionElement;
    const status = this.doc.getElementById("status");

    const sse = deps.sse || (new EventSource("/events") as EventSource);
    sse.addEventListener(
      "competition_start",
      ({ data }) => {
        const { competition } = JSON.parse(data) as CompetitionStartMessage;
        this.competition = competition;
        this.position = 0;
        this.tbody?.style.setProperty("--hide-count", String(0));
        this.buildCompetitorTable();
      },
    );
    sse.addEventListener(
      "performance_start",
      ({ data }) => {
        const { position } = JSON.parse(data) as PerformanceStartMessage;
        assert(typeof position === "number");
        this.position = position;
        this.updateTimes();
        this.tbody?.style.setProperty("--hide-count", String(position));
      },
    );
    sse.addEventListener("client_status", ({ data }) => {
      const { connected_clients } = JSON.parse(data) as ClientStatusMessage;
      connected_clients.forEach((client) => {
      });
    });
  }

  buildCompetitorTable(): void {
    if (this.tbody) {
      this.tbody.innerHTML =
        this.competition!.competitors.reduce<[html: string, ms: number]>(
          ([html, ms], c) => [
            html + `<tr>
          <td class="time-col">${formatTime(new Date(ms))}</td>
          <td>${c.name}</td></tr>`,
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
