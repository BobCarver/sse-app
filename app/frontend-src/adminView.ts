import { escapeHtml as esc } from "./html.ts";
import type {
  AdminOverview,
  OverviewCompetition,
  OverviewCompetitor,
  OverviewDevice,
  OverviewJudge,
  OverviewSession,
  OverviewTrack,
  Status,
} from "../src/adminTypes.ts";

/** What the renderers need to know about the page (kept out of the data). */
export interface ViewState {
  /** Is the section with this key expanded? `dflt` applies until the user toggles it. */
  isOpen(key: string, dflt: boolean): boolean;
  /** Current time in ms (for "uploads closed"). */
  now: number;
}

export const STATUS_LABEL: Record<Status, string> = {
  upcoming: "Upcoming",
  in_progress: "In progress",
  finished: "Finished",
  skipped: "Skipped",
};

const badge = (s: Status) =>
  `<span class="badge ${s}">${STATUS_LABEL[s]}</span>`;

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** A native <details>: the browser draws the hide/reveal triangle. */
function section(
  key: string,
  dflt: boolean,
  state: ViewState,
  cls: string,
  summary: string,
  body: string,
): string {
  const open = state.isOpen(key, dflt) ? " open" : "";
  return `<details data-key="${
    esc(key)
  }" class="${cls}"${open}><summary>${summary}</summary>${body}</details>`;
}

export function renderDevice(
  d: OverviewDevice,
  opts: { label?: string; email?: string | null } = {},
): string {
  const name = opts.label ?? d.name;
  const links = d.links.map((l) =>
    `<span class="link-chip">link #${l.id}${
      l.label ? ` <small>${esc(l.label)}</small>` : ""
    } <button type="button" class="small danger" data-action="revoke" data-id="${l.id}" title="Lock this device out">Revoke</button></span>`
  ).join("");
  return `<div class="device" data-client="${esc(d.client_id)}">
    <span class="dot ${d.connected ? "on" : "off"}" title="${
    d.connected ? "connected" : "not connected"
  }"></span>
    <b>${esc(name)}</b> <code>${esc(d.client_id)}</code>
    <button type="button" class="small" data-action="new-link" data-client="${
    esc(d.client_id)
  }" data-name="${esc(name)}" data-email="${
    esc(opts.email ?? "")
  }">New link</button>
    ${links || `<span class="muted">no active links</span>`}
  </div>`;
}

function liveText(s: OverviewSession): string {
  if (!s.live) return "";
  const where = s.live.competition_name
    ? ` · ${esc(s.live.competition_name)}${
      s.live.position >= 0 ? ` #${s.live.position + 1}` : ""
    }`
    : "";
  const wait = s.live.waiting_for.length
    ? ` · waiting for ${s.live.waiting_for.map(esc).join(", ")}`
    : "";
  return `<span class="live">${esc(s.live.phase)}${where}${wait}</span>`;
}

function audioButton(
  comp: OverviewCompetition,
  c: OverviewCompetitor,
  kind: "announce" | "music",
): string {
  const has = c.audio[kind];
  return `<label class="audio ${has ? "have" : "missing"}" title="${
    has ? "Replace" : "Upload"
  } ${kind} audio">${kind} ${
    has ? "✓" : "✗"
  }<input type="file" accept="audio/*" hidden data-action="upload" data-competition="${comp.id}" data-competitor="${c.id}" data-kind="${kind}"></label>`;
}

function renderCompetitor(
  comp: OverviewCompetition,
  c: OverviewCompetitor,
): string {
  return `<li class="competitor ${c.status}">
    <span class="order">${c.order}</span>
    <span class="cname">${esc(c.name)}</span>
    <span class="muted">${esc(c.type)}${
    c.duration ? ` · ${c.duration}s` : ""
  }</span>
    ${badge(c.status)}
    ${
    c.status === "skipped"
      ? `<span class="muted">not performed</span>`
      : `<span class="muted" title="judges who have scored this competitor">scored ${c.scored_by}/${comp.judges.length}</span>`
  }
    <span class="audios">${audioButton(comp, c, "announce")} ${
    audioButton(comp, c, "music")
  }</span>
  </li>`;
}

function renderCompetition(
  c: OverviewCompetition,
  state: ViewState,
): string {
  const judges = c.judges.length
    ? `<span class="muted">judges: ${
      c.judges.map((j) => esc(j.name)).join(", ")
    }</span>`
    : `<span class="muted">no judges assigned</span>`;
  const skipped = c.competitors.filter((x) => x.status === "skipped").length;
  const summary = `<span class="name">${esc(c.name)}</span> ${
    badge(c.status)
  } <span class="muted">${c.competitors.length} competitor${
    c.competitors.length === 1 ? "" : "s"
  }</span> ${
    skipped ? `<span class="badge skipped">${skipped} skipped</span>` : ""
  } ${judges}`;
  const body = c.competitors.length
    ? `<ul class="competitors">${
      c.competitors.map((x) => renderCompetitor(c, x)).join("")
    }</ul>`
    : `<p class="muted">No competitors registered.</p>`;
  return section(
    `c${c.id}`,
    c.status === "in_progress",
    state,
    `competition ${c.status}`,
    summary,
    body,
  );
}

function renderSession(s: OverviewSession, state: ViewState): string {
  const closed = state.now >= new Date(s.audio_cutoff).getTime() || s.running;
  const controls = `<span class="controls">
    <button type="button" class="small primary" data-action="start" data-id="${s.id}" ${
    s.running ? "disabled" : ""
  }>${s.status === "finished" ? "Run again" : "Start"}</button>
    <button type="button" class="small" data-action="skip" data-id="${s.id}" ${
    s.running ? "" : "disabled"
  } title="Stop waiting for whatever the session is stuck on">Skip</button>
    <button type="button" class="small danger" data-action="abort" data-id="${s.id}" ${
    s.running ? "" : "disabled"
  }>Abort</button>
  </span>`;
  const summary = `<span class="name">${esc(s.name)}</span> ${
    badge(s.status)
  } <span class="muted">starts ${esc(fmtTime(s.start_time))}</span> ${
    liveText(s)
  } ${controls}`;
  const note = `<p class="muted audio-note">Audio uploads ${
    closed ? "are closed" : "close"
  } ${closed ? "" : esc(fmtTime(s.audio_cutoff))}${
    closed ? " (uploading replaces the file after a confirmation)" : ""
  }.</p>`;
  const body = note +
    (s.competitions.length
      ? s.competitions.map((c) => renderCompetition(c, state)).join("")
      : `<p class="muted">No competitions in this session.</p>`);
  return section(
    `s${s.id}`,
    s.status !== "finished",
    state,
    `session ${s.status}`,
    summary,
    body,
  );
}

function renderTrack(t: OverviewTrack, state: ViewState): string {
  const devices = `<div class="devices">${
    t.devices.map((d) => renderDevice(d, { label: `${t.name} ${d.name}` }))
      .join("")
  }</div>`;
  const sessions = t.sessions.length
    ? t.sessions.map((s) => renderSession(s, state)).join("")
    : `<p class="muted">No sessions on this track.</p>`;
  const summary = `<span class="name">${
    esc(t.name)
  }</span> <span class="muted">${esc(t.location)}</span>`;
  return section(`t${t.id}`, true, state, "track", summary, devices + sessions);
}

/** The festival tree: festival > track > session > competition > competitors. */
export function renderOverview(o: AdminOverview, state: ViewState): string {
  if (o.festivals.length === 0) {
    return `<p class="empty">No festivals yet. Load the demo data with <code>deno task demo:seed</code>, or add data to the database.</p>`;
  }
  return o.festivals.map((f) =>
    section(
      `f${f.id}`,
      true,
      state,
      "festival",
      `<span class="name">${
        esc(f.name)
      }</span> <span class="muted">${f.tracks.length} track${
        f.tracks.length === 1 ? "" : "s"
      }</span>`,
      f.tracks.length
        ? f.tracks.map((t) => renderTrack(t, state)).join("")
        : `<p class="muted">No tracks.</p>`,
    )
  ).join("");
}

function renderJudge(j: OverviewJudge): string {
  const judges = j.competitions.length
    ? j.competitions.map((c) => esc(c.name)).join(", ")
    : `<span class="muted">none</span>`;
  return `<li class="judge">
    ${renderDevice(j.device, { email: j.email })}
    <div class="muted">${
    j.email ? esc(j.email) : "no email on file"
  } · judges: ${judges}</div>
  </li>`;
}

/** Everyone who judges, with their links (a judge moves between tracks on one link). */
export function renderJudges(o: AdminOverview): string {
  return o.judges.length
    ? `<ul class="judges">${o.judges.map(renderJudge).join("")}</ul>`
    : `<p class="empty">No judges yet.</p>`;
}
