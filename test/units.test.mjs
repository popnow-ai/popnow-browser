import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { actionById, ACTIONS, buildArgs, isReady, menuEntries } from "../src/lib/actions.js";
import { decodeDataUrl, fileNameFor, imageSource } from "../src/lib/page-image.js";
import { classify, confirmedArgs, formatCredits, formatUsd, parseCreations, parseEffects, parseModels, priceLabel } from "../src/lib/run.js";

describe("right-click actions", () => {
  it("offers every image tool, and hides the library when an API key is in use", () => {
    assert.deepEqual(ACTIONS.map((a) => a.tool), ["edit_image", "create_video", "remove_background", "upscale", "expand_image", "relight_photo", "apply_effect", "save_to_library"]);
    assert.equal(menuEntries("account").length, 8);
    assert.ok(!menuEntries("key").some((entry) => entry.id === "popnow-save"));
    assert.ok(menuEntries("account").every((entry) => entry.contexts[0] === "image"));
    assert.ok(!ACTIONS.some((a) => /face|swap/i.test(`${a.id} ${a.title} ${a.tool}`)));
  });

  it("builds arguments with the image link and the user's choices", () => {
    assert.deepEqual(buildArgs(actionById("expand"), "https://x/a.jpg", {}), { image_url: "https://x/a.jpg", aspect_ratio: "16:9" });
    assert.deepEqual(buildArgs(actionById("upscale"), "popnow://f/1", { size: "8k" }), { image_url: "popnow://f/1", size: "8k" });
    assert.deepEqual(buildArgs(actionById("save"), "popnow://f/1"), { url: "popnow://f/1" });
    assert.deepEqual(buildArgs(actionById("effect"), "https://x/a.jpg", { effect: "zombie-turn" }), { image_url: "https://x/a.jpg", effect: "zombie-turn" });
    assert.equal(isReady(actionById("edit"), { prompt: "  " }), false);
    assert.equal(isReady(actionById("effect"), {}), false);
    assert.equal(isReady(actionById("remove_background"), {}), true);
  });
});

describe("page images", () => {
  it("passes https links and reads everything else in the page", () => {
    assert.equal(imageSource("https://cdn.example/a.jpg"), "link");
    for (const src of ["data:image/png;base64,AA==", "blob:https://x/1", "http://x/a.jpg", "file:///a.png", "nonsense"]) assert.equal(imageSource(src), "page");
  });

  it("decodes data URLs and names files", () => {
    assert.deepEqual([...decodeDataUrl("data:image/png;base64,AQIDBA==").bytes], [1, 2, 3, 4]);
    assert.equal(decodeDataUrl("data:image/svg+xml,%3Csvg%3E").contentType, "image/svg+xml");
    assert.throws(() => decodeDataUrl("https://x"), /could not read/);
    assert.equal(fileNameFor("https://x.example/p/Sunset%20Beach.JPG?w=1", "image/jpeg"), "Sunset-Beach.jpg");
    assert.equal(fileNameFor("blob:https://x/1", "image/webp"), "image.webp");
  });
});

describe("prices and results", () => {
  it("writes credits and USD apart", () => {
    assert.equal(formatCredits(1234), "1,234 credits");
    assert.equal(formatCredits(1), "1 credit");
    assert.equal(formatUsd("0.030000000"), "$0.03");
    assert.equal(formatUsd("5"), "$5.00");
    assert.equal(formatUsd("0.012345678"), "$0.012345");
    assert.equal(priceLabel({ unit: "credits", credits: 48 }), "48 credits");
    assert.equal(priceLabel({ unit: "usd", usd: "0.25" }), "$0.25");
    assert.doesNotMatch(priceLabel({ unit: "credits", credits: 48 }), /\$/);
  });

  it("strips any approval from arguments before adding the user's", () => {
    assert.deepEqual(confirmedArgs("account", { prompt: "x", max_credits: 5, consent: true, max_usd: "9" }, { unit: "credits", credits: 48 }), { prompt: "x", max_credits: 48 });
    assert.deepEqual(confirmedArgs("key", { prompt: "x", max_credits: 5 }, { unit: "usd", usd: "0.1" }), { prompt: "x", currency: "USD", max_usd: "0.1" });
    assert.deepEqual(confirmedArgs("account", { prompt: "x" }, undefined, true), { prompt: "x", consent: true });
  });

  it("classifies tool results", () => {
    assert.equal(classify({ structuredContent: { needs_confirmation: true, credits: 450, balance: 9 } }, "account").kind, "confirm");
    assert.equal(classify({ structuredContent: { needs_consent: true } }, "account").kind, "consent");
    assert.equal(classify({ isError: true, content: [{ type: "text", text: "Not enough credits." }] }, "account").text, "Not enough credits.");
    assert.deepEqual(classify({ content: [{ type: "text", text: "Not started: the price is now 60 credits, more than the 48 the user agreed to." }] }, "account").quote, { unit: "credits", credits: 60 });
    const job = classify({ structuredContent: { job_id: "j", status: "succeeded", credits: 48, files: [{ url: "https://m/x.png", popnow_link: "popnow://g/x", type: "image/png" }] } }, "account");
    assert.deepEqual(job.job, { jobId: "j", status: "succeeded", credits: 48, files: [{ url: "https://m/x.png", link: "popnow://g/x", type: "image/png" }] });
  });

  it("parses list_models, effects and creations text", () => {
    const models = parseModels("- Seedream 5 (model: seedream-5) by ByteDance: text to image [create_image], about 30 to 40 credits\n- Veo (model: veo) by Google: text to video [create_video], about 900 credits", "create_image");
    assert.deepEqual(models, [{ id: "seedream-5", name: "Seedream 5", provider: "ByteDance", price: "about 30 to 40 credits" }]);
    assert.deepEqual(parseEffects("- Clay Figure (clay-figure): x\n- Bad line\n- Werewolf Turn (werewolf-turn) (popular): y").map((e) => e.id), ["clay-figure", "werewolf-turn"]);
    assert.deepEqual(parseCreations("No creations yet."), []);
  });
});
