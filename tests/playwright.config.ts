import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    timeout: 120_000,
    expect: { timeout: 5000 },
    use: {
        baseURL: "http://localhost:8000",
        actionTimeout: 0,
        trace: "on-first-retry",
        headless: true,
    },
    webServer: {
        command:
            "DEBUG=1 PORT=8000 deno run --config=deno.json --allow-net --allow-env --allow-read src/main.ts",
        cwd: "../app",
        url: "http://localhost:8000/_health",
        timeout: 60_000,
        reuseExistingServer: true,
        env: {
            DATABASE_URL: "postgres://postgres:test@localhost:5432/test_db",
            JUDGE_SCORE_TIMEOUT_MS: "5000",
            JWT_SECRET: "test-secret",
        },
    },
    projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ],
});
