import { BILLING_URL, extensionFor, formatPrice, isFinished, KEYS_URL, PopNowClient, PopNowError } from "./api.js";

const DEFAULT_MODELS = { image: "google/nano-banana-2.1/text-to-image", video: "minimax/h3/text-to-video" };
const TASKS = { image: "text-to-image", video: "text-to-video" };
const FIRST_POLL_MS = 3000;
const MAX_POLL_MS = 15000;

const $ = (id) => document.getElementById(id);
const sections = ["setup", "form", "progress", "result"];

let client;
let kind = "image";
let quote;
let pending; // A confirmed request whose outcome is unknown; a retry reuses its idempotency key.
let lastAsset;
let lastTaskId;

function show(section) {
  for (const id of sections) $(id).hidden = id !== section;
}

function showError(error) {
  const box = $("error");
  box.textContent = "";
  box.hidden = !error;
  if (!error) return;
  box.textContent = error.message ?? String(error);
  if (error instanceof PopNowError && error.isBalance) {
    const link = document.createElement("a");
    link.href = BILLING_URL;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = " Add funds";
    box.append(link);
  }
  if (error instanceof PopNowError && error.isAuth) show("setup");
}

async function loadModels() {
  const select = $("model");
  select.replaceChildren();
  const models = await client.listModels(kind, TASKS[kind]);
  const preferred = DEFAULT_MODELS[kind];
  models.sort((a, b) => Number(b.model === preferred) - Number(a.model === preferred));
  for (const item of models) {
    const price = formatPrice(item.usd);
    select.add(new Option([item.displayName ?? item.model, price].filter(Boolean).join(" · "), item.model));
  }
}

function setKind(next) {
  kind = next;
  $("kind-image").setAttribute("aria-selected", String(kind === "image"));
  $("kind-video").setAttribute("aria-selected", String(kind === "video"));
  resetConfirm();
  loadModels().catch(showError);
}

function resetConfirm() {
  quote = undefined;
  $("confirm").hidden = true;
  $("price").hidden = false;
}

function request() {
  return { model: $("model").value, input: { prompt: $("prompt").value.trim() } };
}

async function getPrice() {
  showError();
  const { model, input } = request();
  if (!input.prompt) {
    showError(new Error("Describe what to create."));
    return;
  }
  $("price").disabled = true;
  try {
    const fingerprint = JSON.stringify([model, input]);
    quote = pending?.fingerprint === fingerprint ? pending.quote : await client.quote(model, input);
    const usually =
      quote.expectedChargeUsd && quote.expectedChargeUsd !== quote.maxChargeUsd ? ` Usually $${quote.expectedChargeUsd}.` : "";
    $("confirm-text").textContent = `Generate for up to $${quote.maxChargeUsd}?${usually}`;
    $("confirm").hidden = false;
    $("price").hidden = true;
  } catch (error) {
    showError(error);
  } finally {
    $("price").disabled = false;
  }
}

async function generate() {
  showError();
  const { model, input } = request();
  const fingerprint = JSON.stringify([model, input]);
  const attempt = pending?.fingerprint === fingerprint ? pending : { fingerprint, quote, idempotencyKey: crypto.randomUUID() };
  pending = attempt;
  $("generate").disabled = true;
  try {
    const task = await client.createTask(model, input, attempt.quote, attempt.idempotencyKey);
    pending = undefined;
    await chrome.storage.local.set({ activeTask: task.taskId });
    await follow(task);
  } catch (error) {
    // A 4xx means the task was refused. Anything else may have started it, so keep the key for a retry.
    if (error instanceof PopNowError && error.status < 500) pending = undefined;
    showError(error);
  } finally {
    $("generate").disabled = false;
  }
}

async function follow(initial) {
  show("progress");
  let task = initial;
  let delay = FIRST_POLL_MS;
  while (!isFinished(task)) {
    $("status").textContent = task.state === "queued" ? "Queued" : "Rendering";
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, MAX_POLL_MS);
    task = await client.getTask(task.taskId);
  }
  await chrome.storage.local.remove("activeTask");
  showResult(task);
}

function showResult(task) {
  resetConfirm();
  if (task.state !== "succeeded") {
    show("form");
    showError(new Error(`${task.errorMessage ?? "The model could not finish this request."} Failed jobs are refunded automatically.`));
    return;
  }
  const asset = (task.output?.assets ?? []).find((item) => item.url && !item.unavailable);
  if (!asset) {
    show("form");
    showError(new Error("The task finished without a file."));
    return;
  }
  lastAsset = asset;
  lastTaskId = task.taskId;
  const media = document.createElement(asset.mime?.startsWith("video/") ? "video" : "img");
  media.src = asset.url;
  if (media.tagName === "VIDEO") media.controls = true;
  else media.alt = "Generated result";
  $("media").replaceChildren(media);
  $("result-text").textContent = task.costUsd ? `Cost $${task.costUsd}` : "";
  show("result");
}

function download() {
  chrome.downloads.download({ url: lastAsset.url, filename: `popnow-${lastTaskId}.${extensionFor(lastAsset.mime)}` });
}

async function saveKey() {
  const key = $("key").value.trim();
  if (!key) return;
  await chrome.storage.local.set({ apiKey: key });
  $("key").value = "";
  await start(key);
}

async function start(key) {
  showError();
  client = new PopNowClient(key);
  show("form");
  await loadModels();
  const { activeTask } = await chrome.storage.local.get("activeTask");
  if (activeTask) await follow(await client.getTask(activeTask));
}

function init() {
  const params = new URLSearchParams(location.search);
  if (params.get("tab")) document.body.classList.add("tab");
  if (params.get("prompt")) $("prompt").value = params.get("prompt");
  $("keys-link").href = KEYS_URL;
  $("settings").addEventListener("click", () => show("setup"));
  $("save-key").addEventListener("click", () => saveKey().catch(showError));
  $("kind-image").addEventListener("click", () => setKind("image"));
  $("kind-video").addEventListener("click", () => setKind("video"));
  $("model").addEventListener("change", resetConfirm);
  $("prompt").addEventListener("input", resetConfirm);
  $("price").addEventListener("click", getPrice);
  $("generate").addEventListener("click", generate);
  $("cancel").addEventListener("click", resetConfirm);
  $("download").addEventListener("click", download);
  $("again").addEventListener("click", () => show("form"));
  chrome.storage.local.get("apiKey").then(({ apiKey }) => {
    if (apiKey) start(apiKey).catch(showError);
    else show("setup");
  });
}

init();
