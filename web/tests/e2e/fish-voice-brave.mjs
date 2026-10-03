// Run through Agent Brave's browser_run_code_unsafe after claiming a tab.
// Serve this worktree's bundle entirely through intercepted requests: a temporary loopback preview,
// no deployment, live signer or provider call. The mock does not prove relay auth.
export default async (page, fixture) => {
  const assert = {
    equal(a, b, msg = "") {
      if (a !== b) throw new Error(`${msg}: ${a} !== ${b}`);
    },
    deepEqual(a, b) {
      if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    },
    ok(value) {
      if (!value) throw new Error("Assertion failed");
    },
    match(value, pattern) {
      if (!pattern.test(value))
        throw new Error(`${value} does not match ${pattern}`);
    },
  };
  const root = fixture.root;
  const exports = {};
  new Function("exports", fixture.helper)(exports);
  const { installMockRelay, mockEvent } = exports;
  const viewer = fixture.viewer;
  const agent = "b".repeat(64);
  const id = "0123456789abcdef0123456789abcdef";
  const old = "ABCDEFGHIJKLMNOP";
  const events = [
    mockEvent({
      kind: 30177,
      pubkey: viewer,
      tags: [["d", agent]],
      content: JSON.stringify({
        name: "Jame Agent",
        model: "test-model",
        provider: "test",
      }),
    }),
    mockEvent({
      kind: 30183,
      pubkey: viewer,
      tags: [["d", agent]],
      content: JSON.stringify({
        version: 1,
        engine: "fish",
        key: `fish:${old}`,
        label: "Stored Jame",
      }),
    }),
  ];
  const relay = await installMockRelay(page, events, {
    onPublish(event, handle) {
      handle.push(event);
    },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  let isAdmin = true;
  let voices = [];
  const writes = [];
  const signed = [];
  const previews = [];
  const searches = [];
  const labels = ["zed", "bella", "Adam", "Émile", "10 Ten", "2 Two"];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/healthz")
      return json({ libraryAdmins: isAdmin ? [viewer] : [] });
    if (url.pathname === "/voices/chatterbox")
      return json({
        voices: labels.map((label, i) => ({
          key: `chatterbox:v${i}`,
          slug: `v${i}`,
          label,
          reserved: false,
        })),
      });
    if (url.pathname === "/voices/eleven")
      return json({
        curated: true,
        voices: labels.map((label, i) => ({ id: `id${i}abcdefghij`, label })),
      });
    if (url.pathname === "/voices/fish/available") {
      searches.push(url.searchParams.get("q"));
      return json({
        voices: [
          {
            id,
            label: "Jame",
            detail: "en · by author",
            inLibrary: voices.some((v) => v.id === id),
          },
        ],
      });
    }
    if (url.pathname === "/voices/fish" && request.method() === "GET")
      return json({ curated: true, voices });
    if (
      url.pathname.startsWith("/voices/fish") &&
      ["POST", "DELETE"].includes(request.method())
    ) {
      const event = JSON.parse(
        Buffer.from(request.headers().authorization.slice(6), "base64"),
      );
      signed.push({ event, body: request.postData() });
      assert.equal(event.pubkey, viewer);
      assert.equal(event.tags.find((t) => t[0] === "u")[1], url.href);
      assert.equal(
        event.tags.find((t) => t[0] === "method")[1],
        request.method(),
      );
      if (request.method() === "POST") {
        const digest = await page.evaluate(
          async (body) =>
            Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(body),
                ),
              ),
            )
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          request.postData(),
        );
        assert.equal(event.tags.find((t) => t[0] === "payload")[1], digest);
        assert.equal(JSON.parse(request.postData()).id, id);
        voices = [{ id, label: "Jame" }];
      } else {
        voices = [];
      }
      writes.push(request.method());
      return json(
        { voices, removed: true, voice: { id, label: "Jame" } },
        request.method() === "POST" ? 201 : 200,
      );
    }
    if (url.pathname === "/tts") {
      previews.push(JSON.parse(request.postData()));
      return route.fulfill({
        contentType: "audio/L16; rate=24000; channels=1",
        headers: { "x-tts-engine": "fish", "x-tts-voice": `fish:${id}` },
        body: Buffer.alloc(4800),
      });
    }
    if (url.hostname === new URL(fixture.origin).hostname) {
      const path = url.pathname.startsWith("/assets/")
        ? url.pathname
        : "/index.html";
      return route.fulfill({
        response: await page.request.get(`${fixture.preview}${path}`),
      });
    }
    return json({ voices: [], status: "ok" });
  });
  // Synthetic hosts have no worker-network origin; PWA registration is outside this voice workflow.
  await page.addInitScript(() => {
    delete Object.getPrototypeOf(navigator).serviceWorker;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${fixture.origin}/repos`);
  await page.getByRole("button", { name: "Enter key manually" }).click();
  await page.getByPlaceholder("nsec1…").fill(fixture.nsec);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByPlaceholder("New passphrase").fill("disposable-fish-test");
  await page
    .getByPlaceholder("Confirm passphrase")
    .fill("disposable-fish-test");
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByTestId("channel-sidebar").waitFor();
  await page.goto(`${fixture.origin}/repos/settings?group=voice`);
  const card = page.getByTestId("settings-voice-library");
  await card.waitFor();
  assert.deepEqual(
    await card.getByTestId("voice-library-label").allTextContents(),
    ["2 Two", "10 Ten", "Adam", "bella", "Émile", "zed"],
  );
  await card.getByRole("button", { name: "Fish Audio", exact: true }).click();
  await card
    .getByRole("textbox", { name: "Voice id or URL" })
    .fill(`https://fish.audio/m/${id}`);
  await card.getByRole("button", { name: "Add voice", exact: true }).click();
  await card
    .getByTestId("voice-library-label")
    .filter({ hasText: "Jame" })
    .waitFor();
  await card.getByRole("button", { name: "Browse Fish Audio" }).click();
  await card
    .getByRole("searchbox", { name: "Search public Fish voices" })
    .fill("public & author");
  await card
    .getByTestId("voice-library-available")
    .getByText("Jame", { exact: true })
    .waitFor();
  assert.ok(searches.includes("public & author"));
  const agentCard = page.getByTestId("settings-agent-voices");
  await agentCard.getByRole("button", { name: "Change…", exact: true }).click();
  const picker = page.getByTestId("voice-picker-dialog");
  await picker.waitFor();
  assert.match(
    await picker.getByTestId("voice-picker-row").first().textContent(),
    /Stored Jame.*not in library/,
  );
  const row = picker
    .getByTestId("voice-picker-row")
    .filter({ hasText: "Jame" })
    .last();
  await row.getByRole("button", { name: "Preview", exact: true }).click();
  await row.getByRole("button", { name: "Select", exact: true }).click();
  await picker
    .getByRole("button", { name: "Confirm Jame", exact: true })
    .click();
  await picker.waitFor({ state: "hidden" });
  assert.equal(relay.published.filter((e) => e.kind === 30183).length, 1);
  const assigned = JSON.parse(
    relay.published.find((e) => e.kind === 30183).content,
  );
  assert.equal(assigned.engine, "fish");
  assert.equal(assigned.key, `fish:${id}`);
  await card
    .getByTestId("voice-library-curated")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  const confirm = page.getByTestId("voice-library-remove-confirm");
  await confirm.waitFor();
  assert.match(
    await confirm.getByTestId("voice-library-usage").textContent(),
    /Jame Agent/,
  );
  await confirm
    .getByRole("button", { name: "Remove voice", exact: true })
    .click();
  await confirm.waitFor({ state: "hidden" });
  await agentCard.getByTestId("voice-not-in-library").waitFor();
  await agentCard.getByRole("button", { name: "Change…", exact: true }).click();
  await picker.waitFor();
  assert.match(
    await picker.getByTestId("voice-picker-row").first().textContent(),
    /Jame.*not in library/,
  );
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  await page.screenshot({ path: `${root}/logs/fish-web-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  assert.ok(await card.isVisible());
  await page.screenshot({ path: `${root}/logs/fish-web-phone.png` });
  isAdmin = false;
  await page.goto(`${fixture.origin}/repos/settings?group=voice`);
  await page.getByTestId("voice-library-readonly").waitFor();
  assert.equal(
    await card.getByRole("button", { name: "Add voice", exact: true }).count(),
    0,
  );
  assert.equal(
    await card.getByRole("button", { name: "Remove", exact: true }).count(),
    0,
  );
  assert.ok(previews.some((p) => p.engine === "fish" && p.voice === id));
  assert.deepEqual(writes, ["POST", "DELETE"]);
  assert.equal(errors.length, 0, errors.join("\n"));
  const receipt = {
    pass: true,
    checks: [
      "built Settings mount",
      "curated sorting",
      "Fish URL add with verified NIP-98",
      "public search",
      "Fish preview",
      "owner 30183 assignment",
      "removal usage confirm",
      "soft-removed badge and pinned row",
      "390px phone",
      "non-admin read-only",
    ],
    published: 1,
    writes,
    previews: previews.length,
    pageErrors: errors,
    consoleErrors,
  };
  receipt.signed = signed;
  await page.evaluate(async () => {
    localStorage.clear();
    for (const database of await indexedDB.databases())
      if (database.name) indexedDB.deleteDatabase(database.name);
  });
  await page.unrouteAll({ behavior: "wait" });
  return receipt;
};
