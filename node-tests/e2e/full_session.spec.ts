import { expect, test } from "@playwright/test";

test("E2E - Full session flow with DJ and judges", async ({ browser }) => {
    async function createClient(sub: string) {
        const context = await browser.newContext();
        const page = await context.newPage();

        // Forward page console to node output so we can see client-side logs
        page.on("console", (msg) => {
            console.log(`[page:${sub}] ${msg.type()} ${msg.text()}`);
        });
        // Log failed network requests and error HTTP responses for diagnostics
        page.on("requestfailed", (req) => {
            console.log(
                `[page:${sub}] requestfailed ${req.url()} ${req.failure()?.errorText}`,
            );
        });
        page.on("response", (res) => {
            if (res.status() >= 400) {
                console.log(
                    `[page:${sub}] response ${res.status()} ${res.url()} ${res.statusText()}`,
                );
            }
        });

        await page.goto(`/register?sub=${sub}`);
        await page.goto("/");
        await page.evaluate((who) => {
            (window as any).__msgs = [];
            const es = new EventSource("/events");

            es.addEventListener("open", () => {
                console.log("[es] open", who);
                (window as any).__msgs.push({
                    event: "es_open",
                    data: { who },
                });
            });
            es.addEventListener("error", (ev) => {
                // push stringified error details to messages for diagnostics
                console.error("[es] error", who, ev);
                (window as any).__msgs.push({
                    event: "es_error",
                    data: { who, message: String(ev) },
                });
            });
            es.addEventListener("close", () => {
                console.log("[es] close", who);
                (window as any).__msgs.push({
                    event: "es_close",
                    data: { who },
                });
            });

            const evts = [
                "client_status",
                "competition_start",
                "performance_start",
                "performance_recovery",
                "enable_scoring",
                "score_update",
            ];
            for (const e of evts) {
                es.addEventListener(e, (ev) => {
                    (window as any).__msgs.push({
                        event: e,
                        data: JSON.parse(ev.data),
                    });
                });
            }
            (window as any).waitForEvent = (type, timeout = 15000) =>
                new Promise((resolve, reject) => {
                    const start = Date.now();
                    (function poll() {
                        const msgs = (window as any).__msgs;
                        const idx = msgs.findIndex((m: any) =>
                            m.event === type
                        );
                        if (idx !== -1) {
                            const m = msgs.splice(idx, 1)[0];
                            resolve(m.data);
                            return;
                        }
                        if (Date.now() - start > timeout) {
                            // Dump current messages to console for diagnostics
                            console.error(
                                "[waitForEvent] timeout waiting for",
                                type,
                                "current_msgs=",
                                (window as any).__msgs,
                            );
                            reject(new Error("timeout"));
                            return;
                        }
                        setTimeout(poll, 50);
                    })();
                });
        }, sub);
        return { context, page };
    }

    const dj = await createClient("dj0");
    const judge1 = await createClient("judge2");
    const judge2 = await createClient("judge3");
    const sb = await createClient("sb10");

    console.log("clients created, attempting to start session");

    try {
        const startOk = await dj.page.evaluate(async () => {
            console.log("dj: about to POST /sessions/1/start");
            const r = await fetch("/sessions/1/start", { method: "POST" });
            console.log("dj: POST /sessions/1/start done", r.status);
            return r.ok;
        });
        console.log("startOk value from page:", startOk);
        expect(startOk).toBe(true);

        // Wait for DJ and judges to receive client_status (scoreboard may be unassigned)
        await Promise.all([
            dj.page.evaluate(() =>
                (window as any).waitForEvent("client_status")
            ),
            judge1.page.evaluate(() =>
                (window as any).waitForEvent("client_status")
            ),
            judge2.page.evaluate(() =>
                (window as any).waitForEvent("client_status")
            ),
        ]);
        expect(startOk).toBe(true);

        const comp = await dj.page.evaluate(() =>
            (window as any).waitForEvent("competition_start")
        );
        expect(comp.competition.id).toBeDefined();
        const perf = await dj.page.evaluate(() =>
            (window as any).waitForEvent("performance_start")
        );
        expect(perf.position).toBe(0);

        await dj.page.evaluate(() =>
            fetch("/response", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tag: `perf:10:0`, payload: true }),
            })
        );

        await Promise.all([
            judge1.page.evaluate(() =>
                (window as any).waitForEvent("enable_scoring")
            ),
            judge2.page.evaluate(() =>
                (window as any).waitForEvent("enable_scoring")
            ),
        ]);

        await Promise.all([
            judge1.page.evaluate(() =>
                fetch("/response", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        tag: `score:10:100:2`,
                        payload: [{ criteria_id: 1, score: 8.5 }, {
                            criteria_id: 2,
                            score: 9,
                        }],
                    }),
                })
            ),
            judge2.page.evaluate(() =>
                fetch("/response", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        tag: `score:10:100:3`,
                        payload: [{ criteria_id: 1, score: 7.5 }, {
                            criteria_id: 2,
                            score: 8,
                        }],
                    }),
                })
            ),
        ]);

        const s1 = await sb.page.evaluate(() =>
            (window as any).waitForEvent("score_update")
        );
        const s2 = await sb.page.evaluate(() =>
            (window as any).waitForEvent("score_update")
        );
        expect([s1.judge_id, s2.judge_id].every(Boolean)).toBe(true);
    } finally {
        await Promise.all([
            dj.context.close(),
            judge1.context.close(),
            judge2.context.close(),
            sb.context.close(),
        ]);
    }
});
