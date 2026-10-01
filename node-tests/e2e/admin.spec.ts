import { expect, test } from "@playwright/test";

// The admin page: sign in with the admin token, see the whole festival as a
// tree, issue and revoke a link (with QR and share links), sign out.
// Runs against the e2e seed (festival test1 > track1 > session1 > Competition 1).

const TOKEN = process.env.ADMIN_TOKEN ?? "test-admin";

test("admin page: sign in, browse the festival tree, issue and revoke a link, sign out", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/admin");
    // Not signed in: the form, and no data.
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();

    await page.locator("#token").fill("not-the-token");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#loginError")).toHaveText("Wrong token.");
    await expect(page.locator("#app")).toBeHidden();

    await page.locator("#token").fill(TOKEN);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#app")).toBeVisible();
    // The token is not left in the page, the URL or the cookie jar.
    await expect(page.locator("#token")).toHaveValue("");
    expect(page.url()).not.toContain(TOKEN);
    const cookies = await page.context().cookies();
    const adminCookie = cookies.find((c) => c.name === "admin_session")!;
    expect(adminCookie.httpOnly).toBe(true);
    expect(adminCookie.sameSite).toBe("Strict");
    expect(adminCookie.value).not.toContain(TOKEN);

    // The hierarchy: festival > track > session > competition > competitor.
    const tree = page.locator("#tree");
    await expect(tree.locator("details.festival")).toContainText("test1");
    await expect(tree.locator("details.track")).toContainText("track1");
    await expect(tree.locator("details.session").first()).toContainText("session1");
    await expect(tree.locator("details.session .badge").first()).toBeVisible(); // status shows as text and colour

    // Competitions and competitors are further down; open each level that is closed
    // (a finished session starts collapsed, which depends on earlier test runs).
    const openIfClosed = async (details: import("@playwright/test").Locator) => {
        if (!(await details.evaluate((el: HTMLDetailsElement) => el.open))) {
            await details.locator("summary").first().click();
        }
    };
    await openIfClosed(tree.locator("details.session").first());
    const competition = tree.locator("details.competition").first();
    await expect(competition).toContainText("Competition 1");
    await openIfClosed(competition);
    await expect(competition.locator("li.competitor").first()).toContainText("Competitor 1");

    // The triangle hides and reveals (native <details>) and survives the 3s refresh.
    const festival = tree.locator("details.festival");
    await festival.locator("summary").first().click();
    await expect(festival).not.toHaveAttribute("open", "");
    await page.waitForTimeout(3500);
    await expect(festival).not.toHaveAttribute("open", ""); // still collapsed after a refresh
    await festival.locator("summary").first().click();
    await expect(festival).toHaveAttribute("open", "");

    // Judges tab.
    await page.locator("#tab-judges").click();
    await expect(page.locator("#judges")).toContainText("Judge A");
    await expect(page.locator("#judges")).toContainText("judgeA@example.com");
    await page.locator("#tab-festival").click();

    // Issue a link for the track's DJ: shown once, with copy, QR, email and text.
    const dj = tree.locator('.device[data-client="dj1"]');
    const linkIds = () => dj.locator('[data-action="revoke"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id!));
    const before = await linkIds(); // other tests leave links around: look for the new one
    await dj.getByRole("button", { name: "New link" }).click();
    const dialog = page.locator("#linkDialog");
    await expect(dialog).toBeVisible();
    const link = await page.locator("#linkText").inputValue();
    expect(link).toMatch(/\/join\/[A-Za-z0-9_-]{40,}$/);
    await expect(dialog.locator("#qr svg")).toBeVisible();
    expect(await page.locator("#mailto").getAttribute("href")).toMatch(/^mailto:/);
    expect(await page.locator("#sms").getAttribute("href")).toMatch(/^sms:/);
    expect(decodeURIComponent((await page.locator("#sms").getAttribute("href"))!)).toContain(link);
    // WhatsApp: opens the chooser until a number is typed, then goes to that person.
    const whatsapp = page.locator("#whatsapp");
    expect(await whatsapp.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent((await whatsapp.getAttribute("href"))!)).toContain(link);
    expect(await whatsapp.getAttribute("target")).toBe("_blank");
    await page.locator("#phone").fill("+44 7700 900123");
    expect(await whatsapp.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/447700900123\?text=/);
    expect(await page.locator("#sms").getAttribute("href")).toMatch(/^sms:\+447700900123/);
    await dialog.getByRole("button", { name: "Copy link" }).click();
    await expect(page.locator("#toast")).toHaveText("Link copied");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#linkText")).toHaveValue(""); // not kept around
    await expect(page.locator("#phone")).toHaveValue(""); // the phone number is not kept either

    // The new link is listed, and works for a device.
    await expect.poll(async () => (await linkIds()).length).toBe(before.length + 1);
    const newId = (await linkIds()).find((id) => !before.includes(id))!;
    const device = await page.context().browser()!.newContext();
    const devicePage = await device.newPage();
    await devicePage.goto(link);
    await expect(devicePage).toHaveURL(/\/dj$/);
    await device.close();

    // Revoke it (with a confirmation): the device is locked out at once.
    page.once("dialog", (d) => d.accept());
    await dj.locator(`[data-action="revoke"][data-id="${newId}"]`).click();
    await expect(dj.locator(`[data-action="revoke"][data-id="${newId}"]`)).toHaveCount(0);
    const locked = await page.context().browser()!.newContext();
    const res = await locked.request.get(link, { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    await locked.close();

    // Sign out: the page goes back to the form and the cookie stops working.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#login")).toBeVisible();
    expect((await page.request.get("/admin/overview")).status()).toBe(401);
    expect(errors).toEqual([]);
});

test("admin page: the API refuses a stranger and a cookie-less change", async ({ request }) => {
    expect((await request.get("/admin/overview")).status()).toBe(401);
    expect((await request.post("/admin/credentials", { data: { client_id: "dj1" } })).status()).toBe(401);
});
