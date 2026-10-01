import { expect, test } from "@playwright/test";

// The demo page (DEMO=1): a scoreboard, a DJ and two judges in one tab, each
// frame signed in as its own device. Frames live on sibling hostnames of
// lvh.me (see app/src/demo.ts); Chromium is told to resolve them to this machine
// so the test does not need DNS.

const TOKEN = process.env.ADMIN_TOKEN ?? "test-admin";

test.use({
    launchOptions: {
        args: [
            "--autoplay-policy=no-user-gesture-required",
            "--host-resolver-rules=MAP lvh.me 127.0.0.1, MAP *.lvh.me 127.0.0.1",
        ],
    },
});

test("demo page: four devices in one tab run a whole session", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // The e2e seed's session 1 (one competitor, judges 2 and 3).
    await page.goto(`/demo?token=${TOKEN}&session=1`);
    await expect(page).toHaveURL(/lvh\.me:\d+\/demo/); // moved to the demo domain

    const frames = page.locator("iframe");
    await expect(frames).toHaveCount(4);
    const [sb, dj, j1, j2] = [0, 1, 2, 3].map((i) => page.frameLocator("iframe").nth(i));

    // Each frame landed on its own page, signed in as itself (separate cookies).
    await expect.poll(() => page.frames().map((f) => new URL(f.url()).pathname).sort())
        .toEqual(["/demo", "/dj", "/judge", "/judge", "/scoreboard"]);
    await expect(sb.locator("#scoreboard")).toBeAttached();
    await expect(j1.locator("#judge")).toBeVisible();
    await expect(j2.locator("#judge")).toBeVisible();

    // 1. audio for the performance, which the DJ frame downloads and verifies.
    await page.getByRole("button", { name: /Reset \+ make audio/ }).click();
    await expect(page.locator("#msg")).toContainText("Making audio: ok");
    await expect(dj.locator("#audioStatus")).toContainText("Audio ready", { timeout: 20_000 });

    // The DJ turns audio on once, then the session is started from the page.
    await dj.locator("#unlock").click();
    await page.getByRole("button", { name: /Start session/ }).click();
    await expect(page.locator("#msg")).toContainText("Starting: ok");

    // The song waits for the DJ: play is pressed in the DJ frame once the announcement is over.
    await expect(dj.locator("#start")).toBeEnabled({ timeout: 30_000 });
    await dj.locator("#start").click();

    // The DJ plays the announcement and the song; then each judge gets sliders.
    for (const j of [j1, j2]) {
        await expect(j.locator("#sliders label")).toHaveText("Technique", { timeout: 40_000 });
        await expect(j.locator("#submit")).toBeEnabled({ timeout: 20_000 });
    }
    for (const [j, v] of [[j1, "9"], [j2, "7"]] as const) {
        await j.locator("#sliders input").evaluate((el, val) => {
            (el as HTMLInputElement).value = val as string;
            el.dispatchEvent(new Event("input", { bubbles: true }));
        }, v);
        await j.locator("#submit").click();
    }
    await expect(sb.locator("#scoreboard tbody td")).toHaveText(["9", "7"]);

    // The session ends by itself after the last score. Reset clears it for next time.
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator("#msg")).toContainText("Resetting: ok");
    expect(errors).toEqual([]);
});

test("demo page: refuses a missing or wrong token", async ({ request }) => {
    expect((await request.get("/demo", { maxRedirects: 0 })).status()).toBe(401);
    expect((await request.get("/demo?token=wrong", { maxRedirects: 0 })).status()).toBe(401);
});
