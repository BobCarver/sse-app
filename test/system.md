# Dance Festival Competition System

This system is designed to manage a dance festival with multiple competition
categories and real‐time performance scoring. It consists of several distinct
web applications and a backend server that communicate via a combination of sse
and http requests.

The overall architecture and workflow are as follows:

---

## Key Components

### 1. Competitions

- **Multiple Categories:**
  - The festival may have several tracks running concurrently.
  - Each track has one or more sessions.
  - Only one session in a track may be running at a specific time.
  - Each session has one or more competitions.

- **Room & Schedule:**
  - Each track takes place in a specific location with only one active session
    per track.
  - sessions are scheduled for a preset times but can be adjusted dynamically if
    earlier sessions run longer or finish early.

- **Competition Data:**
  - Each competition has a list of competitors, a rubric, and metadata (such as
    competition ID and name).
  - The rubric defines the criteria and associated judges for the competition.
  - The system supports a competitor participating in multiple competitions.

### 2. Rubric

- **Criteria:**
  - Each competition has a fixed set of scoring criteria (for example, technical
    difficulty, musicality, stage presence, overall performance).
  - Scores are provided on a scale of 1 to 10 with increments of 0.1.

- **Judges:**
  - Each competition involves a slate of judges (typically 3–5 or more).
  - Each judge evaluates only a subset of the criteria predetermined for that
    competition.

- **Assignment:**
  - The assignment of judges to criteria is defined in the competition data and
    enforced by the database schema.

### 3. Role-Based Frontend Apps

Each role has its own web application with a tailored UI and workflow:

- **Session controller:**
  - Runs on the server and Plays an announcement for a competitor.
  - Waits either for either a start signal or a skip signal. For a skip signal
    the competitor is skipped and the competition continues with the next
    competitor. For a start signal another mp3 for the performace of the
    competitor is played.
  - At the end of a performance, session signals the other clients (via sse) to
    enable judge score submissions.

- **Judge App:**
  - Displays the current competitor’s information and a list of score sliders
    corresponding to the criteria assigned to that judge.
  - Judges enter scores during or after the performance.
  - When an enable score message is received the submit button is enabled;
  - judges submit their scores using the `score_submit` message defined in
    `src/protocol.ts` (payload: score update — includes `competition_id`,
    `competitor_id`, `judge_id`, and `scores`).

- **Scoreboard App:**
  - Displays a real-time table with scores submitted by the judges.
  - Updates the current competitor display and a competitor list (with scheduled
    erformance times).
  - Clears and refreshes the table when moving to the next competitor.

### 4. Communication and Synchronization

- **SSE Connections:**
  - All frontend apps (Judge, Scoreboard, DJ) maintain an active SSE connection
    with the server.
  - The server sends and receives messages with the apps – for example, when a
    score is submitted or a competitor is updated.

---

## Canonical messages (see `src/protocol.ts`) 🔧

> Reference: the canonical message definitions and validation logic live in
> `src/protocol.ts`. The score update payload schema is defined in
> `src/types.ts`.

## Workflow Example

### Competition Initialization

- At the scheduled time (or when dynamically adjusted), a session is loaded by
  fetching its JSON configuration (including competitors and rubric) from
  theserver.

### Performance Cycle

A session will consist of multiple sequential competitions.

- At the start of a competition, the server will inform all the web apps that a
  new competition has started.
- Each competition will have multiple competitors.

For each competitor:

1. The DJ plays an announcement .
2. The DJ starts the performance, triggering the competitor's competition, by
   playing the competitor songs. These songs will be stored remotely with the
   competition/competitor values being used to construct the MP3 file name.
3. Immediately after the performance, the server will send a message to the
   judge apps, asking them to enable submission. judges will submit their scores
   via their Judge App by pressing the submit button. Scores in each of the
   categories are captured via a slider in the Judge app.
4. The Scoreboard App displays real-time cumulative scores.
5. Once all scores are received for the competitor, the system advances to the
   next competitor.
6. If a judge fails to enter a score within 30 seconds the Judge App notifies
   the judge by bringing attention to the needed action.

### Real-Time Updates

- All server to web client communicate via SSE ensuring that any change(e.g.,
  new score submissions or competitor updates) are broadcast to all connected
  clients.

### Data Persistence

- All competition data and judges’ scores are recorded in a PostgreSQL database.
- This data can later be reviewed or analyzed for performance assessments.

## Assistant behavior (required)

- Name: When asked, respond exactly `GitHub Copilot`.
- Model: When asked, state `Raptor mini (Preview)`.
- Harmful or off-topic content: For harmful/hateful/violent/lewd requests or
  requests unrelated to software engineering, respond exactly:
  `Sorry, I can't assist with that.`
- Tone & length: Keep answers short and impersonal.
- File-change guidance:
  - If asked to change existing files and it's unclear which files should be
    changed, respond:
    `Please add the files to be modified to the working set, or use #codebase in your request to automatically discover working set files.`
  - When creating new files, follow the project's file-change format: describe
    the solution step-by-step, group changes by file, add a short summary per
    file, include a single code block per file that starts with a comment
    containing the filepath, and use `...existing code...` to indicate unchanged
    regions.

---

## Seeding the database for e2e tests ✅

If you want to run the harness against a real Postgres DB (so you can skip the
HTTP seed endpoint):

- Use the provided SQL file: `test/seed_db.sql`. Apply it with psql or your
  favorite client:

  psql $DATABASE_URL -f test/seed_db.sql

- Or call the programmatic helper from tests (require./old/test-helpers.tsenv):

  import { seedDbSession } from "./test-helpers.ts"; await seedDbSession(200);

This will create a minimal session, competition, judge, and competitor using
deterministic ids the tests expect (session=200, competition=2001, judge=1,
competitor=501, criteria=1).
