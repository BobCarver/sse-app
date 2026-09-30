import { expect, test } from "@playwright/test";

// Drives the REAL pages (/dj, /judge, /scoreboard) through the UI:
// session start -> DJ plays -> judges submit -> scoreboard shows scores.

// 0.3s of silence as a valid WAV so <audio> can play/end in headless Chromium.
function silentWav(seconds = 0.3): Buffer {
    const rate = 8000, n = Math.floor(rate * seconds);
    const b = Buffer.alloc(44 + n);
    b.write("RIFF", 0);
    b.writeUInt32LE(36 + n, 4);
    b.write("WAVEfmt ", 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); // PCM
    b.writeUInt16LE(1, 22); // mono
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate, 28);
    b.writeUInt16LE(1, 32);
    b.writeUInt16LE(8, 34);
    b.write("data", 36);
    b.writeUInt32LE(n, 40);
    b.fill(128, 44); // 8-bit silence
    return b;
}

test.use({
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

test("real pages: full session through the UI", async ({ browser, request }) => {
    const wav = silentWav();
    const pageErrors: string[] = [];
    async function open(url: string) {
        const context = await browser.newContext();
        await context.route(/-(announce|music)$/, (r) =>
            r.fulfill({ status: 200, contentType: "audio/wav", body: wav }));
        const page = await context.newPage();
        page.on("pageerror", (e) => pageErrors.push(`${url}: ${e.message}`));
        await page.goto(url);
        return { context, page };
    }

    const dj = await open("/dj?track=1");
    const j2 = await open("/judge?judge=2");
    const j3 = await open("/judge?judge=3");
    const sb = await open("/scoreboard?track=1");

    try {
        // Give the pages a moment to register + connect before starting.
        await new Promise((r) => setTimeout(r, 1000));
        const start = await request.post("/sessions/1/start");
        expect(start.status()).toBe(200);

        // Judges get their sliders (rubric criterion "Technique") and a disabled submit.
        for (const j of [j2, j3]) {
            await expect(j.page.locator("#sliders label")).toHaveText("Technique");
        }

        // DJ announcement plays, then the music; on completion judges are enabled.
        for (const j of [j2, j3]) {
            await expect(j.page.locator("#submit")).toBeEnabled({ timeout: 20_000 });
        }

        // Judge 2 -> 8, judge 3 -> 6
        for (const [j, v] of [[j2, "8"], [j3, "6"]] as const) {
            await j.page.locator("#sliders input").evaluate((el, val) => {
                (el as HTMLInputElement).value = val as string;
                el.dispatchEvent(new Event("input", { bubbles: true }));
            }, v);
            await j.page.locator("#submit").click();
            await expect(j.page.locator("#status")).toHaveText("Scores submitted");
            await expect(j.page.locator("#submit")).toBeDisabled();
        }

        // Scoreboard: one row (Technique), two judge columns.
        const cells = sb.page.locator("#scoreboard tbody td");
        await expect(cells).toHaveText(["8", "6"]);

        // No uncaught errors on any page (catches browser-only bugs).
        expect(pageErrors).toEqual([]);
    } finally {
        await Promise.all([dj, j2, j3, sb].map((c) => c.context.close()));
    }
});

test("real pages: a judge whose connection drops mid-scoring recovers and can still submit", async ({ browser, request }) => {
    const wav = silentWav();
    const pageErrors: string[] = [];
    async function open(url: string) {
        const context = await browser.newContext();
        // Keep a handle on every EventSource so the test can kill the live one.
        await context.addInitScript(() => {
            const Native = window.EventSource;
            (window as any).__eventSources = [];
            (window as any).EventSource = class extends Native {
                constructor(url: string | URL, init?: EventSourceInit) {
                    super(url, init);
                    (window as any).__eventSources.push(this);
                }
            };
        });
        await context.route(/-(announce|music)$/, (r) =>
            r.fulfill({ status: 200, contentType: "audio/wav", body: wav }));
        const page = await context.newPage();
        page.on("pageerror", (e) => pageErrors.push(`${url}: ${e.message}`));
        await page.goto(url);
        return { context, page };
    }

    const dj = await open("/dj?track=1");
    const j2 = await open("/judge?judge=2");
    const j3 = await open("/judge?judge=3");
    const sb = await open("/scoreboard?track=1");

    try {
        await new Promise((r) => setTimeout(r, 1000));
        expect((await request.post("/sessions/1/start")).status()).toBe(200);

        for (const j of [j2, j3]) {
            await expect(j.page.locator("#submit")).toBeEnabled({ timeout: 20_000 });
        }

        // Judge 2 starts scoring, then loses the network.
        await j2.page.locator("#sliders input").evaluate((el) => {
            (el as HTMLInputElement).value = "9";
            el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        // The connection dies the way a browser reports it when it gives up:
        // closed + error event.
        await j2.page.evaluate(() => {
            const es = (window as any).__eventSources.at(-1) as EventSource;
            es.close();
            es.dispatchEvent(new Event("error"));
        });
        await expect(j2.page.locator("#connection")).toContainText("reconnecting");

        // The page reopens by itself (fresh token) and the server replays state.
        await expect(j2.page.locator("#connection")).toHaveText("", { timeout: 15_000 });
        expect(await j2.page.evaluate(() => (window as any).__eventSources.length)).toBe(2);

        // The judge's in-progress slider survived the replay, and submitting works.
        await expect(j2.page.locator("#sliders input")).toHaveValue("9");
        await expect(j2.page.locator("#submit")).toBeEnabled();
        await j2.page.locator("#submit").click();
        await expect(j2.page.locator("#status")).toHaveText("Scores submitted");

        await j3.page.locator("#submit").click();
        await expect(j3.page.locator("#status")).toHaveText("Scores submitted");

        await expect(sb.page.locator("#scoreboard tbody td")).toHaveText(["9", "5"]);
        expect(pageErrors).toEqual([]);
    } finally {
        await Promise.all([dj, j2, j3, sb].map((c) => c.context.close()));
    }
});
