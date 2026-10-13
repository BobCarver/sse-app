/**
 * What GET /admin/overview returns and the admin page renders. Shared by server
 * and browser code: keep it free of Deno and DOM APIs.
 */

/**
 * upcoming = not started, in_progress = under way, finished = done. A competitor
 * can also be skipped (the DJ or an administrator skipped the performance).
 */
export type Status = "upcoming" | "in_progress" | "finished" | "skipped";

export interface OverviewCompetitor {
  id: number;
  name: string;
  type: string;
  order: number;
  /** Seconds. */
  duration: number | null;
  status: Status;
  /** How many of the competition's judges have scored this competitor. */
  scored_by: number;
  audio: { announce: boolean; music: boolean };
}

export interface OverviewCompetition {
  id: number;
  name: string;
  order: number;
  status: Status;
  judges: { id: number; name: string }[];
  competitors: OverviewCompetitor[];
}

/** One sign-in link that has been issued and not revoked. */
export interface OverviewLink {
  id: number;
  label: string | null;
  created_at: string;
}

/** A DJ, scoreboard or judge, and the links that let a device act as it. */
export interface OverviewDevice {
  client_id: string;
  kind: "dj" | "sb" | "judge";
  name: string;
  connected: boolean;
  links: OverviewLink[];
}

export interface OverviewLive {
  /** An operator hold is on (nothing new starts until it is released). */
  held?: boolean;
  phase: string;
  competition_name: string | null;
  position: number;
  waiting_for: string[];
}

export interface OverviewSession {
  id: number;
  name: string;
  status: Status;
  start_time: string;
  /** When it is expected to start, if later than planned (the track runs late). */
  estimated_start: string | null;
  /** An operator hold is on (kept across restarts). */
  held: boolean;
  /** Dropped for good by the operator. */
  cancelled: boolean;
  running: boolean;
  live: OverviewLive | null;
  competitions: OverviewCompetition[];
}

export interface OverviewTrack {
  id: number;
  name: string;
  location: string;
  devices: OverviewDevice[];
  sessions: OverviewSession[];
}

export interface OverviewFestival {
  id: number;
  name: string;
  tracks: OverviewTrack[];
}

export interface OverviewJudge {
  id: number;
  name: string;
  email: string | null;
  device: OverviewDevice;
  competitions: { id: number; name: string }[];
}

export interface AdminOverview {
  festivals: OverviewFestival[];
  judges: OverviewJudge[];
}
