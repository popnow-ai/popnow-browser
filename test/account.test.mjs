import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { requireSecure } from "../src/lib/oauth.js";
import { createService } from "../src/lib/service.js";
import { UploadBlockedError } from "../src/lib/upload.js";
import { API_KEY, followSignIn, memoryStorage, startFake } from "./fake-server.mjs";

const REDIRECT = "https://abcdefghijklmnop.chromiumapp.org/";
const PNG = "data:image/png;base64,AQIDBA==";

describe("account mode", () => {
  let fake;
  let storage;
  let clock;
  let service;
  const make = (fetchImpl = fetch) =>
    createService({ fetch: fetchImpl, storage, now: () => clock, mcpUrl: `${fake.origin}/mcp`, keyMcpUrl: `${fake.origin}/api/v1/mcp`, apiUrl: `${fake.origin}/api/v1` });

  beforeEach(async () => {
    fake = await startFake();
    storage = memoryStorage();
    clock = 1_700_000_000_000;
    service = make();
  });
  afterEach(() => fake.server.close());

  const signIn = () => service.login({ redirectUri: REDIRECT, launch: followSignIn });
  const paidCalls = (name) => fake.calls.filter((call) => call.name === name);

  it("signs in with discovery, dynamic registration, PKCE and the chromiumapp.org redirect", async () => {
    await signIn();
    const [reg] = fake.registered;
    assert.deepEqual(reg.redirect_uris, [REDIRECT]);
    assert.equal(reg.token_endpoint_auth_method, "none");
    assert.equal(reg.scope, "generate read");
    assert.equal(fake.authorize.code_challenge_method, "S256");
    assert.equal(fake.authorize.resource, `${fake.origin}/mcp`);
    assert.equal(fake.authorize.redirect_uri, REDIRECT);
    assert.ok(fake.authorize.code_challenge.length >= 43);
    assert.equal(fake.lastTokenForm.redirect_uri, REDIRECT);
    assert.ok(fake.lastTokenForm.code_verifier.length >= 43);
    assert.equal(storage.data.account.accessToken, "at-1");
    assert.equal(storage.data.account.refreshToken, "rt-1");
    assert.equal(storage.data.account.expiresAt, clock + 3600_000);
    assert.equal(await service.mode(), "account");
  });

  it("refuses a reply with the wrong state or issuer and saves nothing", async () => {
    fake.forceState = "wrong";
    await assert.rejects(signIn(), /not the one PopNow was waiting for/);
    fake.forceState = undefined;
    fake.callbackIssuer = "https://evil.example";
    await assert.rejects(signIn(), /unexpected server/);
    assert.equal(fake.tokens.issued, 0);
    assert.equal(storage.data.account, undefined);
  });

  it("checks the issuer and requires https except on this computer", async () => {
    fake.declaredIssuer = "https://other.example";
    await assert.rejects(signIn(), /issuer mismatch/);
    assert.throws(() => requireSecure("http://api.popnow.ai/mcp", "x"), /must use https/);
    assert.equal(requireSecure("http://127.0.0.1:9/mcp", "x").hostname, "127.0.0.1");
    await assert.rejects(service.login({ redirectUri: "http://evil.example/", launch: followSignIn }), /must use https/);
  });

  it("shows the balance in credits through MCP (initialize, initialized, then the call)", async () => {
    await signIn();
    assert.deepEqual(await service.balance(), { unit: "credits", credits: 12000 });
    assert.deepEqual(fake.calls.map((call) => call.method), ["initialize", "notifications/initialized", "tools/call"]);
    assert.match(fake.calls[0].accept, /application\/json/);
    assert.match(fake.calls[0].accept, /text\/event-stream/);
  });

  it("reads JSON replies as well as event streams", async () => {
    await signIn();
    fake.sse = false;
    assert.deepEqual(await service.balance(), { unit: "credits", credits: 12000 });
    fake.sse = true;
    assert.deepEqual(await service.balance(), { unit: "credits", credits: 12000 });
  });

  it("quotes with estimate_cost, which starts nothing", async () => {
    await signIn();
    const quote = await service.quote({ tool: "create_image", args: { prompt: "a lighthouse" } });
    assert.deepEqual(quote, { unit: "credits", credits: 48, balance: 12000 });
    assert.equal(paidCalls("create_image").length, 0);
    assert.equal(fake.balance, 12000);
    assert.deepEqual(paidCalls("estimate_cost")[0].args, { tool: "create_image", arguments: { prompt: "a lighthouse" } });
  });

  it("runs only with the confirmed price as max_credits", async () => {
    await signIn();
    const quote = await service.quote({ tool: "create_image", args: { prompt: "a lighthouse" } });
    const outcome = await service.run({ tool: "create_image", args: { prompt: "a lighthouse" }, approved: quote, title: "a lighthouse" });
    assert.equal(outcome.kind, "job");
    assert.equal(outcome.record.status, "succeeded");
    assert.equal(outcome.record.files[0].url, "https://media.example/x.png");
    assert.deepEqual(paidCalls("create_image")[0].args, { prompt: "a lighthouse", max_credits: 48 });
  });

  it("never raises the confirmed price when the server asks for more", async () => {
    await signIn();
    const quote = await service.quote({ tool: "create_image", args: { prompt: "x", max_credits: 999 } });
    fake.price.create_image = 60;
    const outcome = await service.run({ tool: "create_image", args: { prompt: "x", max_credits: 999 }, approved: quote, title: "x" });
    assert.equal(outcome.kind, "confirm");
    assert.deepEqual(outcome.quote, { unit: "credits", credits: 60 });
    const runs = paidCalls("create_image");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].args.max_credits, 48);
    assert.equal(fake.balance, 12000);
    assert.deepEqual(await service.jobs(), []);
  });

  it("asks for consent and only sends consent: true when the user ticked it", async () => {
    await signIn();
    const args = { image_url: "https://example.com/person.jpg", prompt: "red coat" };
    const quote = await service.quote({ tool: "edit_image", args });
    const first = await service.run({ tool: "edit_image", args, approved: quote, title: "Edit image" });
    assert.equal(first.kind, "consent");
    assert.equal(paidCalls("edit_image")[0].args.consent, undefined);
    const smuggled = await service.run({ tool: "edit_image", args: { ...args, consent: true }, approved: quote, title: "Edit image" });
    assert.equal(smuggled.kind, "consent", "consent in the arguments is dropped; only the user's tick counts");
    const second = await service.run({ tool: "edit_image", args, approved: quote, consent: true, title: "Edit image" });
    assert.equal(second.kind, "job");
    assert.equal(paidCalls("edit_image").at(-1).args.consent, true);
  });

  it("keeps a long job in storage and polls it to the end, notifying once", async () => {
    await signIn();
    const args = { image_url: "https://example.com/cat.jpg", prompt: "it turns its head" };
    const quote = await service.quote({ tool: "create_video", args });
    const outcome = await service.run({ tool: "create_video", args, approved: quote, title: "Animate" });
    assert.equal(outcome.record.status, "running");
    assert.equal(storage.data.jobs[0].jobId, "j-video");

    // A new service instance stands in for a restarted service worker.
    service = make();
    const notified = [];
    const notify = async (job) => notified.push(job);
    assert.equal(await service.poll({ notify }), 1);
    assert.equal(await service.poll({ notify }), 0);
    assert.equal(await service.poll({ notify }), 0);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].status, "succeeded");
    assert.equal(notified[0].files[0].url, "https://media.example/v.mp4");
    assert.deepEqual(paidCalls("get_job")[0].args, { job_id: "j-video", wait_seconds: 0 });
  });

  it("marks a run whose answer never came as lost instead of starting it again", async () => {
    await signIn();
    const timingOut = async (url, init) => {
      if (String(init?.body ?? "").includes('"create_image"')) throw new DOMException("timed out", "TimeoutError");
      return fetch(url, init);
    };
    service = make(timingOut);
    const outcome = await service.run({ tool: "create_image", args: { prompt: "x" }, approved: { unit: "credits", credits: 48 }, title: "x" });
    assert.equal(outcome.kind, "lost");
    assert.equal((await service.jobs())[0].status, "lost");
    assert.equal(await service.poll(), 0);
  });

  it("gives up on a start that never reported back", async () => {
    await storage.set({ jobs: [{ id: "r1", mode: "account", tool: "create_image", status: "starting", createdAt: clock }] });
    await signIn();
    assert.equal(await service.poll(), 1);
    clock += 5 * 60_000;
    assert.equal(await service.poll(), 0);
    assert.equal((await service.jobs())[0].status, "lost");
  });

  it("uploads a page image through an upload window without sending the token to storage", async () => {
    await signIn();
    const link = await service.uploadImage({ dataUrl: PNG, srcUrl: "blob:https://site.example/1234" });
    assert.equal(link, "popnow://f/abc");
    assert.deepEqual(fake.uploads, ["POST /files", "POST /files/f1/commit", "POST /close"]);
    assert.deepEqual(fake.uploadRequest, { contentType: "image/png", bytes: 4, name: "image.png" });
    assert.equal(fake.puts[0].bytes, 4);
    assert.equal(fake.puts[0].authorization, undefined);
    assert.deepEqual(paidCalls("request_upload")[0].args, { kinds: ["image"], max_files: 1, note: "Images from PopNow for Chrome" });
  });

  it("reports a blocked upload address so the popup can ask for permission", async () => {
    await signIn();
    const blocked = async (url, init) => {
      if (String(url).includes("/put/")) throw new TypeError("Failed to fetch");
      return fetch(url, init);
    };
    service = make(blocked);
    await assert.rejects(service.uploadImage({ dataUrl: PNG, srcUrl: "data:" }), (error) => error instanceof UploadBlockedError && error.origin === fake.origin);
  });

  it("refreshes an expired token once and saves the new one", async () => {
    await signIn();
    fake.expire = "at-1";
    assert.equal((await service.balance()).credits, 12000);
    assert.equal(fake.tokens.refreshed, 1);
    assert.equal(storage.data.account.accessToken, "at-2");
    assert.equal(storage.data.account.refreshToken, "rt-1");
  });

  it("refreshes before expiry, and concurrent calls share one rotating refresh", async () => {
    await signIn();
    fake.rotate = true;
    clock += 3600_000;
    await Promise.all([service.balance(), service.effects(), service.creations()]);
    assert.equal(fake.tokens.refreshed, 1);
    assert.equal(storage.data.account.refreshToken, "rt-2");
  });

  it("signs out locally when the refresh token is refused", async () => {
    await signIn();
    fake.expire = "at-1";
    fake.refuseRefresh = true;
    await assert.rejects(service.balance(), { name: "SignInRequiredError" });
    assert.equal(storage.data.account, undefined);
    assert.equal(await service.mode(), undefined);
  });

  it("signs out, revokes both tokens and forgets the session", async () => {
    await signIn();
    await service.logout();
    assert.deepEqual(fake.tokens.revoked, ["rt-1", "at-1"]);
    assert.equal(storage.data.account, undefined);
    assert.equal(await service.mode(), undefined);
  });

  it("lists models, effects and creations from the account", async () => {
    await signIn();
    assert.deepEqual((await service.models("image")).map((m) => m.id), ["nano-banana-2.1"]);
    assert.deepEqual((await service.models("video")).map((m) => [m.id, m.price]), [["minimax-h3", "about 185 credits"], ["kling-3", "about 300 credits"]]);
    assert.deepEqual((await service.effects()).map((e) => e.id), ["zombie-turn", "tiny-planet"]);
    const creations = await service.creations();
    assert.equal(creations.length, 2);
    assert.deepEqual([creations[0].jobId, creations[0].cost, creations[0].url, creations[0].label], ["j-old", "48 credits", "https://media.example/old.png", "a lighthouse"]);
    assert.equal(creations[1].label, "Zombie Turn");
  });

  it("saves to the library for free, without a price", async () => {
    await signIn();
    const outcome = await service.run({ tool: "save_to_library", args: { url: "popnow://g/x" }, title: "Saved" });
    assert.equal(outcome.kind, "saved");
    assert.equal(outcome.link, "popnow://a/1");
    assert.equal(paidCalls("save_to_library")[0].args.max_credits, undefined);
  });

  it("asks to sign in when there is no session", async () => {
    await assert.rejects(service.balance(), /Sign in/);
  });
});

describe("API-key mode", () => {
  let fake;
  let storage;
  let service;

  beforeEach(async () => {
    fake = await startFake();
    storage = memoryStorage();
    service = createService({ fetch, storage, mcpUrl: `${fake.origin}/mcp`, keyMcpUrl: `${fake.origin}/api/v1/mcp`, apiUrl: `${fake.origin}/api/v1` });
    await service.setKey(` ${API_KEY} `);
  });
  afterEach(() => fake.server.close());

  it("uses the key over a signed-in account and shows USD only", async () => {
    await storage.set({ account: { accessToken: "at-1", mcpUrl: `${fake.origin}/mcp` } });
    assert.equal(await service.mode(), "key");
    assert.deepEqual(await service.balance(), { unit: "usd", usd: "5.000000000" });
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.devCalls.at(-1).auth, `Bearer ${API_KEY}`);
  });

  it("quotes in USD and runs with currency USD and max_usd, never max_credits", async () => {
    const args = { image_url: "https://example.com/cat.jpg" };
    const quote = await service.quote({ tool: "remove_background", args });
    assert.deepEqual(quote, { unit: "usd", usd: "0.030000000", balance: "5.000000000" });
    const outcome = await service.run({ tool: "remove_background", args, approved: quote, title: "Remove background" });
    assert.equal(outcome.kind, "job");
    assert.equal(outcome.record.costUsd, "0.030000000");
    const calls = fake.devCalls.filter((call) => call.name === "remove_background");
    assert.deepEqual(calls[0].args, args);
    assert.deepEqual(calls[1].args, { ...args, currency: "USD", max_usd: "0.030000000" });
  });

  it("runs a prompt through the REST API and polls the task", async () => {
    const run = { model: "google/nano-banana-2.1/text-to-image", input: { prompt: "a fox" }, kind: "image", idempotencyKey: "idem-1" };
    const quote = await service.quote({ rest: run });
    assert.deepEqual(quote, { unit: "usd", usd: "0.039", quoteId: "q1", expected: "0.039" });
    const outcome = await service.run({ rest: run, approved: quote, title: "a fox" });
    assert.equal(outcome.record.mode, "rest");
    assert.deepEqual(fake.createTask, { model: run.model, input: run.input, quoteId: "q1", expectedCostUsd: "0.039" });
    assert.equal(fake.createTaskKey, "idem-1");
    const notified = [];
    assert.equal(await service.poll({ notify: async (job) => notified.push(job) }), 0);
    assert.equal(notified[0].files[0].url, "https://media.example/rest.png");
    assert.equal(notified[0].costUsd, "0.039");
  });

  it("uploads with the REST ticket and keeps the key off the signed address", async () => {
    const link = await service.uploadImage({ dataUrl: PNG, srcUrl: "https://intranet.example/a/photo.webp" });
    assert.equal(link, "popnow://f/kf1");
    assert.deepEqual(fake.rest, ["POST /api/v1/common/upload-url", "POST /api/v1/files/kf1/commit"]);
    assert.equal(fake.puts[0].authorization, undefined);
  });

  it("lists effects from the developer catalog", async () => {
    assert.deepEqual((await service.effects()).map((e) => e.name), ["Zombie Turn"]);
  });

  it("goes back to account mode when the key is removed", async () => {
    await service.removeKey();
    assert.equal(await service.mode(), undefined);
  });
});
