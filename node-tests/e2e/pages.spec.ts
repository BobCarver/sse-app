import { type APIRequestContext, type Browser, expect, test } from "@playwright/test";

// Drives the REAL pages through admin-issued links:
//   admin issues links -> devices open them -> session start -> DJ plays ->
//   judges submit -> scoreboard shows scores. Plus drop/recover and revocation.

const ADMIN = { authorization: `Bearer ${process.env.ADMIN_TOKEN ?? "test-admin"}` };

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

/** What the admin does: issue a link for a client id. */
async function issue(request: APIRequestContext, client_id: string) {
    const res = await request.post("/admin/credentials", {
        headers: ADMIN,
        data: { client_id, label: "e2e" },
    });
    expect(res.status()).toBe(201);
    return await res.json() as { id: number; link: string };
}

const pageErrors: string[] = [];

/** What a device does: open its link in a fresh browser context. */
async function openLink(browser: Browser, link: string) {
    const wav = silentWav();
    const context = await browser.newContext();
    // Keep a handle on every EventSource so tests can kill the live one.
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
    page.on("pageerror", (e) => pageErrors.push(`${link.split("/join/")[0]}: ${e.message}`));
    await page.goto(link);
    return { context, page };
}

async function setup(browser: Browser, request: APIRequestContext) {
    pageErrors.length = 0;
    const links = {
        dj: await issue(request, "dj1"),
        j2: await issue(request, "judge2"),
        j3: await issue(request, "judge3"),
        sb: await issue(request, "sb1"),
    };
    const dj = await openLink(browser, links.dj.link);
    const j2 = await openLink(browser, links.j2.link);
    const j3 = await openLink(browser, links.j3.link);
    const sb = await openLink(browser, links.sb.link);
    // the link landed each device on its own page
    expect(dj.page.url()).toContain("/dj");
    expect(j2.page.url()).toContain("/judge");
    expect(sb.page.url()).toContain("/scoreboard");
    await new Promise((r) => setTimeout(r, 1000)); // let the pages connect
    return { links, dj, j2, j3, sb, all: [dj, j2, j3, sb] };
}

async function startSession(request: APIRequestContext) {
    const res = await request.post("/sessions/1/start", { headers: ADMIN });
    expect(res.status()).toBe(200);
}

test("real pages: full session through the UI", async ({ browser, request }) => {
    const { j2, j3, sb, all } = await setup(browser, request);
    try {
        await startSession(request);

        for (const j of [j2, j3]) {
            await expect(j.page.locator("#sliders label")).toHaveText("Technique");
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

        await expect(sb.page.locator("#scoreboard tbody td")).toHaveText(["8", "6"]);
        expect(pageErrors).toEqual([]);
    } finally {
        await Promise.all(all.map((c) => c.context.close()));
    }
});

test("real pages: a judge whose connection drops mid-scoring recovers and can still submit", async ({ browser, request }) => {
    const { j2, j3, sb, all } = await setup(browser, request);
    try {
        await startSession(request);
        for (const j of [j2, j3]) {
            await expect(j.page.locator("#submit")).toBeEnabled({ timeout: 20_000 });
        }

        await j2.page.locator("#sliders input").evaluate((el) => {
            (el as HTMLInputElement).value = "9";
            el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        // The connection dies the way a browser reports it when it gives up.
        await j2.page.evaluate(() => {
            const es = (window as any).__eventSources.at(-1) as EventSource;
            es.close();
            es.dispatchEvent(new Event("error"));
        });
        await expect(j2.page.locator("#connection")).toContainText("reconnecting");
        await expect(j2.page.locator("#connection")).toHaveText("", { timeout: 15_000 });
        expect(await j2.page.evaluate(() => (window as any).__eventSources.length)).toBe(2);

        // In-progress slider survived the replay; submitting works.
        await expect(j2.page.locator("#sliders input")).toHaveValue("9");
        await expect(j2.page.locator("#submit")).toBeEnabled();
        await j2.page.locator("#submit").click();
        await expect(j2.page.locator("#status")).toHaveText("Scores submitted");
        await j3.page.locator("#submit").click();
        await expect(j3.page.locator("#status")).toHaveText("Scores submitted");

        await expect(sb.page.locator("#scoreboard tbody td")).toHaveText(["9", "5"]);
        expect(pageErrors).toEqual([]);
    } finally {
        await Promise.all(all.map((c) => c.context.close()));
    }
});

test("real pages: a revoked judge is locked out at once and told why", async ({ browser, request }) => {
    const { links, j2, j3, all } = await setup(browser, request);
    try {
        await startSession(request);
        for (const j of [j2, j3]) {
            await expect(j.page.locator("#submit")).toBeEnabled({ timeout: 20_000 });
        }

        // Admin revokes judge 2's link while they are mid-scoring.
        const del = await request.delete(`/admin/credentials/${links.j2.id}`, { headers: ADMIN });
        expect(del.status()).toBe(200);

        // Their next submit is refused...
        await j2.page.locator("#submit").click();
        await expect(j2.page.locator("#status")).toContainText("Access denied");

        // ...and if their connection drops they do not keep retrying forever.
        await j2.page.evaluate(() => {
            const es = (window as any).__eventSources.at(-1) as EventSource;
            es.close();
            es.dispatchEvent(new Event("error"));
        });
        await expect(j2.page.locator("#connection")).toContainText("Access revoked", { timeout: 15_000 });

        // The old link no longer opens.
        const res = await request.get(links.j2.link, { maxRedirects: 0 });
        expect(res.status()).toBe(401);

        // Other judges are unaffected.
        await j3.page.locator("#submit").click();
        await expect(j3.page.locator("#status")).toHaveText("Scores submitted");
    } finally {
        await Promise.all(all.map((c) => c.context.close()));
    }
});

test("real pages: a page opened without a link explains what to do", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        for (const path of ["/dj", "/judge", "/scoreboard"]) {
            await page.goto(path);
            await expect(page.locator("#status")).toContainText("valid link");
        }
    } finally {
        await context.close();
    }
});

test("real pages: a link for one role cannot be used on another role's page", async ({ browser, request }) => {
    const judge = await issue(request, "judge2");
    const { context, page } = await openLink(browser, judge.link);
    try {
        await page.goto("/dj"); // same cookie, wrong page
        await expect(page.locator("#status")).toContainText("not a dj page");
    } finally {
        await context.close();
    }
});
