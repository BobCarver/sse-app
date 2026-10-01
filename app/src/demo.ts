/**
 * Demo page (development only, enabled by DEMO=1): one browser tab showing a
 * scoreboard, a DJ and two judges side by side, each signed in as its own
 * device, with buttons to start, skip, abort and reset the session.
 *
 * Why the frames live on different hostnames: a device is identified by one
 * cookie, and cookies are shared by everything on the same host. Giving each
 * frame its own subdomain of DEMO_DOMAIN (default lvh.me, which resolves to
 * 127.0.0.1) gives each its own cookie, while keeping them "same-site" with the
 * page so the SameSite=Strict credential cookie still works. No auth rule is
 * relaxed. Offline, map the names in /etc/hosts instead (the page lists them).
 */
import type { Hono } from "@hono/hono";
import type { AudioLibrary } from "./audioLibrary.ts";
import type { Credentials } from "./credentials.ts";
import type { AudioKind } from "./contract.ts";
import type { Competition } from "./types.ts";

export interface DemoDeps {
  adminToken(): string | undefined;
  safeEqual(a: string, b: string): Promise<boolean>;
  credentials: Credentials;
  audio: AudioLibrary;
  getSessionTrackId(sessionId: number): Promise<number | undefined>;
  getSessionCompetitions(sessionId: number): Promise<Competition[]>;
  resetSession(sessionId: number): Promise<void>;
  isRunning(sessionId: number): boolean;
  /** Tell connected DJs about new audio now instead of at the next tick. */
  announceNow(): Promise<void>;
}

export const DEFAULT_DEMO_SESSION = 1000;
const DEMO_LABEL = "demo";

// --- generated audio ---------------------------------------------------------

/** A mono 16-bit WAV of `seconds`, stepping through `notes` (0 = rest). */
export function makeWav(
  seconds: number,
  notes: number[],
  noteSeconds = 0.25,
  rate = 11025,
): Uint8Array<ArrayBuffer> {
  const n = Math.floor(seconds * rate);
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((ch, i) => out[at + i] = ch.charCodeAt(0));
  text(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const freq = notes[Math.floor(t / noteSeconds) % notes.length];
    const local = (t % noteSeconds) / noteSeconds; // 0..1 within the note
    const envelope = Math.min(1, local * 25) * (1 - local * 0.5);
    const sample = freq ? Math.sin(2 * Math.PI * freq * t) * envelope * 0.3 : 0;
    v.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return out;
}

const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
const PATTERN = [0, 2, 4, 2, 1, 3, 5, 3];

/** Audio for the k-th competitor: a short beep-beep, and a melody of its own. */
export function demoAudio(k: number, kind: AudioKind): Uint8Array<ArrayBuffer> {
  if (kind === "announce") return makeWav(1.2, [880, 0, 880], 0.3);
  const melody = PATTERN.map((p) => SCALE[(p + k) % SCALE.length]);
  return makeWav(12, melody, 0.25 + (k % 3) * 0.05);
}

// --- page --------------------------------------------------------------------

const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

interface Frame {
  title: string;
  clientId: string;
  src: string;
}

function renderPage(
  opts: {
    sessionId: number;
    token: string;
    frames: Frame[];
    hosts: string[];
    domain: string;
  },
): string {
  const data = JSON.stringify({ sid: opts.sessionId, token: opts.token })
    .replaceAll("<", "\\u003c");
  const frames = opts.frames.map((f) => `
    <section>
      <h2>${esc(f.title)} <small>${esc(f.clientId)}</small></h2>
      <iframe src="${
    esc(f.src)
  }" allow="autoplay" referrerpolicy="no-referrer"></iframe>
    </section>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Demo: scoreboard, DJ and judges</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; }
  header { padding: 8px 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid #8884; }
  header strong { margin-right: 8px; }
  button { font: inherit; padding: 4px 10px; cursor: pointer; }
  #state { margin-left: auto; font-variant-numeric: tabular-nums; }
  #msg { padding: 4px 12px; min-height: 1.4em; color: #888; }
  main { flex: 1; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 6px; padding: 6px; min-height: 0; }
  section { display: flex; flex-direction: column; min-height: 0; border: 1px solid #8886; border-radius: 6px; overflow: hidden; }
  h2 { margin: 0; padding: 4px 8px; font-size: 13px; background: #8882; }
  h2 small { font-weight: normal; color: #888; margin-left: 6px; }
  iframe { flex: 1; width: 100%; border: 0; min-height: 0; background: Canvas; }
  details { padding: 0 12px 6px; color: #888; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; grid-template-rows: repeat(4, 60vh); overflow: auto; } }
</style>
</head>
<body>
<header>
  <strong>Session ${opts.sessionId}</strong>
  <button id="audio" title="Clear scores and statuses, then generate a tone for every announcement and song">1. Reset + make audio</button>
  <button id="start">2. Start session</button>
  <button id="skip" title="Stop waiting for whatever the session is stuck on">Skip</button>
  <button id="abort">Abort</button>
  <button id="reset" title="Clear scores and statuses to run it again">Reset</button>
  <button id="reload" title="New links for every frame">Reload frames</button>
  <span id="state">...</span>
</header>
<div id="msg"></div>
<main>${frames}</main>
<details><summary>How this works</summary>
  Each frame is a separate device on its own host (${
    opts.hosts.map(esc).join(", ")
  }), so each has its own sign-in cookie.
  If those names do not resolve (offline), add <code>127.0.0.1 ${
    opts.hosts.map(esc).join(" ")
  }</code> to /etc/hosts.
  Click <b>Enable audio</b> in the DJ frame once, then press <b>Start</b> there when a song is queued.
</details>
<script>
const { sid, token } = ${data};
const headers = { authorization: "Bearer " + token };
const msg = (t) => { document.getElementById("msg").textContent = t; };
async function call(method, path, label) {
  msg(label + "...");
  try {
    const res = await fetch(path, { method, headers });
    const body = await res.json().catch(() => ({}));
    msg(label + ": " + (res.ok ? "ok" : (body.error || res.status)) + (body.missing_audio && body.missing_audio.length ? " (" + body.missing_audio.length + " audio files missing - press 1)" : ""));
    return res.ok;
  } catch (e) { msg(label + " failed: " + e.message); return false; }
}
document.getElementById("audio").onclick = async () => {
  if (await call("POST", "/demo/reset/" + sid, "Resetting")) await call("POST", "/demo/audio/" + sid, "Making audio");
};
document.getElementById("start").onclick = () => call("POST", "/sessions/" + sid + "/start", "Starting");
document.getElementById("skip").onclick = () => call("POST", "/admin/sessions/" + sid + "/skip", "Skipping");
document.getElementById("abort").onclick = () => call("POST", "/admin/sessions/" + sid + "/abort", "Aborting");
document.getElementById("reset").onclick = () => call("POST", "/demo/reset/" + sid, "Resetting");
document.getElementById("reload").onclick = () => location.reload();
async function poll() {
  const el = document.getElementById("state");
  try {
    const res = await fetch("/admin/sessions", { headers });
    const all = await res.json();
    const s = all.find((x) => x.id === sid);
    el.textContent = !s ? "not running" : s.phase + (s.competition_name ? " - " + s.competition_name + " #" + (s.position + 1) : "") + (s.waiting_for.length ? " - waiting for " + s.waiting_for.join(", ") : "");
  } catch { el.textContent = "server unreachable"; }
}
poll(); setInterval(poll, 1500);
</script>
</body>
</html>`;
}

// --- routes ------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export function registerDemoRoutes(app: Hono<any>, deps: DemoDeps): void {
  const authorized = async (header: string | undefined) => {
    const expected = deps.adminToken();
    const given = /^Bearer (.+)$/.exec(header ?? "")?.[1];
    return !!expected && !!given && await deps.safeEqual(given, expected);
  };
  const sessionIdOf = (raw: string | undefined) => {
    const id = Number(
      raw ?? Deno.env.get("DEMO_SESSION") ??
        DEFAULT_DEMO_SESSION,
    );
    return Number.isInteger(id) ? id : undefined;
  };

  app.get("/demo", async (c) => {
    const expected = deps.adminToken();
    if (!expected) return c.text("ADMIN_TOKEN is not set", 503);
    const token = c.req.query("token") ?? "";
    if (!token || !(await deps.safeEqual(token, expected))) {
      return c.text("Open /demo?token=<ADMIN_TOKEN>", 401);
    }
    const sessionId = sessionIdOf(c.req.query("session"));
    if (sessionId === undefined) return c.text("invalid session id", 400);

    // The frames need sibling hostnames, so the page itself lives on the domain.
    const url = new URL(c.req.url);
    const domain = Deno.env.get("DEMO_DOMAIN") ?? "lvh.me";
    if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) {
      return c.redirect(
        `${url.protocol}//${domain}${
          url.port ? `:${url.port}` : ""
        }/demo${url.search}`,
      );
    }

    const trackId = await deps.getSessionTrackId(sessionId);
    const competitions = trackId === undefined
      ? []
      : await deps.getSessionCompetitions(sessionId);
    if (trackId === undefined || competitions.length === 0) {
      return c.text(
        `Session ${sessionId} has no competitions. Load the demo data ` +
          `(deno task demo:seed) or open /demo?token=...&session=<id>.`,
        404,
      );
    }
    const judges = [
      ...new Map(
        competitions.flatMap((comp) => comp.rubric.judges).map((
          j,
        ) => [j.id, j]),
      ).values(),
    ].slice(0, 2);

    // Fresh links every time; last time's demo links stop working.
    for (const old of deps.credentials.list()) {
      if (old.label === DEMO_LABEL && !old.revokedAt) {
        await deps.credentials.revoke(old.id);
      }
    }
    const port = url.port ? `:${url.port}` : "";
    const frame = async (
      title: string,
      host: string,
      clientId: string,
    ): Promise<Frame> => {
      const { secret } = await deps.credentials.issue(clientId, DEMO_LABEL);
      return {
        title,
        clientId,
        src: `${url.protocol}//${host}.${domain}${port}/join/${secret}`,
      };
    };
    const frames = [
      await frame("Scoreboard", "scoreboard", `sb${trackId}`),
      await frame("DJ", "dj", `dj${trackId}`),
      ...await Promise.all(
        judges.map((j, i) =>
          frame(`Judge: ${j.name}`, `judge${i + 1}`, `judge${j.id}`)
        ),
      ),
    ];
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.html(renderPage({
      sessionId,
      token,
      frames,
      domain,
      hosts: ["scoreboard", "dj", "judge1", "judge2"].map((h) =>
        `${h}.${domain}`
      ),
    }));
  });

  // Tones for every announcement and song in the session, so the DJ can play.
  app.post("/demo/audio/:id", async (c) => {
    if (!(await authorized(c.req.header("authorization")))) {
      return c.json({ error: "admin credentials required" }, 401);
    }
    const sessionId = sessionIdOf(c.req.param("id"));
    if (sessionId === undefined) return c.json({ error: "invalid id" }, 400);
    const competitions = await deps.getSessionCompetitions(sessionId);
    if (competitions.length === 0) {
      return c.json({ error: "no competitions in that session" }, 404);
    }
    let files = 0;
    let k = 0;
    for (const comp of competitions) {
      for (const competitor of comp.competitors) {
        for (const kind of ["announce", "music"] as const) {
          await deps.audio.add(
            { competitionId: comp.id, competitorId: competitor.id, kind },
            demoAudio(k, kind),
          );
          files++;
        }
        k++;
      }
    }
    await deps.announceNow();
    return c.json({ success: true, files });
  });

  app.post("/demo/reset/:id", async (c) => {
    if (!(await authorized(c.req.header("authorization")))) {
      return c.json({ error: "admin credentials required" }, 401);
    }
    const sessionId = sessionIdOf(c.req.param("id"));
    if (sessionId === undefined) return c.json({ error: "invalid id" }, 400);
    if (deps.isRunning(sessionId)) {
      return c.json({ error: "abort the running session first" }, 409);
    }
    await deps.resetSession(sessionId);
    return c.json({ success: true });
  });
}
