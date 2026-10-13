// Operator tool: device links, and control of running sessions.
//
//   ADMIN_TOKEN=... deno task links issue --tracks 1,2 --judges 2,3
//   ADMIN_TOKEN=... deno task links list
//   ADMIN_TOKEN=... deno task links revoke 7
//
//   ADMIN_TOKEN=... deno task links sessions        what is running / who it waits for
//   ADMIN_TOKEN=... deno task links skip 1          stop waiting for whatever session 1 is stuck on
//                                                   (a competitor nobody scored: skip it)
//   ADMIN_TOKEN=... deno task links reopen 1        nobody scored the competitor: ask the judges again
//   ADMIN_TOKEN=... deno task links hold 1          pause session 1: nothing new starts until release
//   ADMIN_TOKEN=... deno task links release 1       let session 1 carry on
//   ADMIN_TOKEN=... deno task links cancel 1        drop session 1 for good; its track moves on
//
//   ADMIN_TOKEN=... deno task links push            send the scores to the portal now (cloud copy)
//   ADMIN_TOKEN=... deno task links push --final    the authoritative upload after the event
//
// Sessions run themselves: each track arms its next session (see sequencer.ts).
//
// Options: --base <url>   server address (default $BASE_URL or http://localhost:3000)
//          --tracks 1,2   issue a DJ (dj<N>) and a scoreboard (sb<N>) link per track
//          --judges 2,3   issue a judge (judge<N>) link per judge id
//          --label <text> label stored with each link (default: the client id)
//
// Links are shown only once, when issued: the server keeps just a hash. Print
// them as QR codes (e.g. `qrencode -t ANSIUTF8 <link>`) and hand them out.

const token = Deno.env.get("ADMIN_TOKEN");
if (!token) {
  console.error("Set ADMIN_TOKEN to the server's admin token.");
  Deno.exit(2);
}

const args = [...Deno.args];
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const base =
  (opt("base") ?? Deno.env.get("BASE_URL") ?? "http://localhost:3000")
    .replace(/\/$/, "");
const tracks = opt("tracks")?.split(",").filter(Boolean) ?? [];
const judges = opt("judges")?.split(",").filter(Boolean) ?? [];
const label = opt("label");
const final_ = args.includes("--final");
const [command, arg] = args.filter((a) => a !== "--final");

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(
      `${init.method ?? "GET"} ${path} -> ${res.status}: ${body.error ?? ""}`,
    );
    Deno.exit(1);
  }
  return body;
}

switch (command) {
  case "issue": {
    const ids = [
      ...tracks.flatMap((t) => [`dj${t}`, `sb${t}`]),
      ...judges.map((j) => `judge${j}`),
    ];
    if (ids.length === 0) {
      console.error("Nothing to issue: pass --tracks and/or --judges");
      Deno.exit(2);
    }
    for (const client_id of ids) {
      const c = await call("/admin/credentials", {
        method: "POST",
        body: JSON.stringify({ client_id, label: label ?? client_id }),
      });
      console.log(`${client_id}\t#${c.id}\t${c.link}`);
    }
    break;
  }
  case "list": {
    for (const c of await call("/admin/credentials")) {
      console.log(
        `#${c.id}\t${c.client_id}\t${c.label ?? ""}\t${
          c.revoked_at ? "REVOKED" : "active"
        }`,
      );
    }
    break;
  }
  case "revoke": {
    if (!arg) {
      console.error("Usage: revoke <id>");
      Deno.exit(2);
    }
    await call(`/admin/credentials/${arg}`, { method: "DELETE" });
    console.log(`revoked #${arg}`);
    break;
  }
  case "sessions": {
    const list = await call("/admin/sessions");
    if (list.length === 0) console.log("no sessions");
    for (const s of list) {
      const at = s.competition_id === null
        ? "not started"
        : `competition ${s.competition_id} #${s.position}`;
      console.log(
        `session ${s.id} (track ${s.track_id ?? "?"})  ${
          s.running ? s.phase : "not running"
        }  ${at}`,
      );
      if (s.waiting_for.length) {
        console.log(`  waiting for: ${s.waiting_for.join(", ")}`);
      }
      for (
        const i of s.incomplete as {
          judge_id: number;
          competitor_id: number;
          reason: string;
        }[]
      ) {
        console.log(
          `  missing score: judge${i.judge_id} for competitor ${i.competitor_id} (${i.reason})`,
        );
      }
    }
    break;
  }
  case "skip":
  case "reopen":
  case "hold":
  case "release":
  case "cancel": {
    if (!arg) {
      console.error(`Usage: ${command} <sessionId>`);
      Deno.exit(2);
    }
    const r = await call(`/admin/sessions/${arg}/${command}`, {
      method: "POST",
    });
    console.log(
      command === "skip"
        ? `skipped: ${r.skipped}`
        : command === "reopen"
        ? "scoring re-opened"
        : r.message ?? `${command}: done`,
    );
    break;
  }
  case "push": {
    const final = final_;
    const r = await call("/admin/cloud/push", {
      method: "POST",
      body: JSON.stringify({ final }),
    });
    console.log(
      r.sent
        ? `${final ? "final " : ""}push sent (digest ${r.digest})`
        : `nothing to send (${r.skipped})`,
    );
    break;
  }
  default:
    console.error(
      "Usage: issue | list | revoke <id> | sessions | skip <sessionId> | reopen | hold | release | cancel <sessionId> | push [--final]",
    );
    Deno.exit(2);
}
