import { parseTag, validatePayload } from "./contract.ts";
import { parseClientId } from "./credentials.ts";
import { resolvers } from "./resolveTag.ts";
import { SessionManager } from "./sessionManager.ts";
import type { Scores } from "./types.ts";

export type ResponseResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string };

const fail = (status: 400 | 403 | 404, error: string): ResponseResult => ({
  ok: false,
  status,
  error,
});

/**
 * Handle a client's answer to a tag (`POST /response`): validate the shape,
 * check that `sender` may answer it, validate scores against the rubric and
 * hand the payload to whoever is waiting. Transport (content type, JSON
 * parsing, authentication) stays in the route.
 */
export function handleResponse(
  sender: string,
  body: { tag?: unknown; payload?: unknown } | null | undefined,
): ResponseResult {
  const parsed = parseTag(body?.tag);
  if (!parsed) return fail(400, "missing or malformed tag");
  const invalid = validatePayload(parsed, body?.payload);
  if (invalid) return fail(400, invalid);

  const tag = body!.tag as string;
  const resolver = resolvers.get(tag);
  if (!resolver) return fail(404, "no resolver for tag");

  const session = SessionManager.findSessionForCompetition(
    parsed.competitionId,
  );
  if (!session) return fail(404, "no active session");

  // Ownership: a device may only answer for itself.
  //  - perf:*  -> a DJ that belongs to this session
  //  - score:* -> exactly judge<N> for score:...:N
  const owner = parsed.kind === "perf"
    ? parseClientId(sender)?.kind === "dj" && session.clients.has(sender)
    : sender === `judge${parsed.judgeId}`;
  if (!owner) {
    console.warn(`403: ${sender} tried to answer ${tag}`);
    return fail(403, "not allowed to answer this request");
  }

  let payload = body!.payload;
  if (parsed.kind === "score") {
    const scores = payload as Scores;
    const rejected = session.validateScoreSubmission(
      parsed.competitionId,
      parsed.competitorId,
      parsed.judgeId,
      scores,
    );
    if (rejected) {
      const status = { closed: 404, forbidden: 403, invalid: 400 }[
        rejected.kind
      ] as 404 | 403 | 400;
      return fail(status, rejected.message);
    }
    // Stored as NUMERIC(3,1): round to one decimal so what is saved is what
    // the scoreboard shows.
    payload = scores.map((s) => ({
      criteria_id: s.criteria_id,
      score: Math.round(s.score * 10) / 10,
    }));
  }

  resolvers.delete(tag); // first response wins
  resolver(payload);
  return { ok: true };
}
