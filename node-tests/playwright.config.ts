import { defineConfig, devices } from "@playwright/test";

// Browser tests drive the real pages against the real app and a real database.
// The app is started here, with the e2e festival bundle (fixtures/bundles/e2e,
// made by `deno task fixtures`); the database must already have the schema
// (tools/e2e.sh / tools/run-e2e.sh / CI take care of that).

const PORT = process.env.E2E_PORT ?? "8000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "test-admin";
process.env.ADMIN_TOKEN = ADMIN_TOKEN; // the specs read it too

export default defineConfig({
    testDir: "./e2e",
    timeout: 120_000,
    expect: { timeout: 5000 },
    // Tests share one session id and one database; they must not run in parallel.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
    use: {
        baseURL: `http://localhost:${PORT}`,
        actionTimeout: 0,
        trace: "on-first-retry",
        headless: true,
    },
    webServer: {
        command: "deno run --allow-net --allow-env --allow-read --allow-write app/src/main.ts",
        cwd: "..",
        url: `http://localhost:${PORT}/_health`,
        timeout: 60_000,
        // Locally, reuse a server you already started; CI always starts a fresh one.
        reuseExistingServer: !process.env.CI,
        env: {
            PORT,
            ADMIN_TOKEN,
            DATABASE_URL: process.env.DATABASE_URL ??
                "postgres://postgres:test@localhost:5432/test_db",
            JUDGE_SCORE_TIMEOUT_MS: "60000",
            BUNDLE_DIR: "fixtures/bundles/e2e",
            AUDIO_DIR: "fixtures/bundles/e2e/audio",
            DEMO: "1", // enables /demo (see e2e/demo.spec.ts)
            // The DJ's start/end buttons are off here: the specs run sessions
            // straight through (the gates are covered by the integration tests).
            DJ_GATES: "0",
        },
    },
    projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ],
});
