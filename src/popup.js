import { BILLING_URL, extensionFor, formatPrice, KEYS_URL } from "./api.js";
import { actionById, buildArgs, isReady } from "./lib/actions.js";
import { formatCredits, formatUsd, isRunning, priceLabel } from "./lib/run.js";

const PRICING_URL = "https://popnow.ai/pricing";
const DEFAULT_REST_MODELS = { image: "google/nano-banana-2.1/text-to-image", video: "minimax/h3/text-to-video" };
const CONSENT_TEXT = "Anyone in this image is me or agreed to this, and no one in it is under 18.";

const $ = (id) => document.getElementById(id);
const views = ["create", "progress", "result", "creations"];

const state = {
  mode: undefined,
  kind: "image",
  action: undefined,
  source: undefined,
  prepared: undefined,
  quote: undefined,
  quoteKey: undefined,
  consent: false,
  following: undefined,
  shown: undefined,
  quoteTimer: undefined,
  quoteSeq: 0,
};

class ServiceError extends Error {
  constructor(reply) {
    super(reply.error);
    this.name = reply.name ?? "Error";
    this.origin = reply.origin;
  }
}

async function send(type, message = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...message });
  if (!reply) throw new Error("PopNow stopped answering. Try again.");
  if (!reply.ok) throw new ServiceError(reply);
  return reply.value;
}

// ── Small view helpers ────────────────────────────────────────────────────────────────────────────

function showSection(id) {
  $("signin").hidden = id !== "signin";
  $("home").hidden = id !== "home";
  $("balance").hidden = id !== "home";
  $("menu-button").hidden = id !== "home";
}

function showView(id) {
  for (const view of views) $(view).hidden = view !== id;
  const tab = id === "creations" ? "creations" : "create";
  $("tab-create").setAttribute("aria-selected", String(tab === "create"));
  $("tab-creations").setAttribute("aria-selected", String(tab === "creations"));
}

function showError(error) {
  const box = $("error");
  box.replaceChildren();
  box.hidden = !error;
  if (!error) return;
  box.textContent = error.message ?? String(error);
  // The stored sign-in is gone by now; show the sign-in screen.
  if (error.name === "SignInRequiredError") init().catch(() => undefined);
}

function note(text, link) {
  const box = $("price-note");
  box.replaceChildren();
  box.hidden = !text;
  if (!text) return;
  box.append(text);
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = link.text;
    box.append(" ", a);
  }
}

function money(quoteOrBalance) {
  return priceLabel(quoteOrBalance);
}

// ── Mode, balance and menu ───────────────────────────────────────────────────────────────────────

async function refreshBalance() {
  const chip = $("balance");
  try {
    const balance = await send("balance");
    chip.textContent = balance.unit === "usd" ? formatUsd(balance.usd) : formatCredits(balance.credits);
    chip.href = state.mode === "key" ? BILLING_URL : PRICING_URL;
    chip.title = state.mode === "key" ? "Add funds" : "Get credits";
  } catch (error) {
    chip.textContent = "";
    if (error.name === "SignInRequiredError" || error.name === "KeyRejectedError") showError(error);
  }
}

function applyMode() {
  const key = state.mode === "key";
  $("menu-signout").textContent = key ? "Remove API key" : "Sign out";
  $("menu-credits").textContent = key ? "Add funds" : "Get credits";
  $("menu-credits").href = key ? BILLING_URL : PRICING_URL;
  $("menu-library").hidden = key;
  $("save").hidden = key;
  $("creations-all").hidden = key;
}

function toggleMenu(open) {
  const menu = $("menu");
  menu.hidden = open === undefined ? !menu.hidden : !open;
  $("menu-button").setAttribute("aria-expanded", String(!menu.hidden));
}

// ── The form: prompt box or a right-click action ─────────────────────────────────────────────────

function fingerprint(request) {
  return request ? JSON.stringify([request.tool, request.args, request.rest?.model, request.rest?.input]) : "";
}

function currentRequest() {
  const prompt = $("prompt").value.trim();
  if (state.action) {
    if (!state.prepared) return undefined;
    const values = { prompt };
    if (state.action.choice) values[state.action.choice.name] = $("choice").value;
    if (state.action.effect) values.effect = $("choice").value;
    if (!isReady(state.action, values)) return undefined;
    return { tool: state.action.tool, args: buildArgs(state.action, state.prepared.ref, values), title: state.action.title, free: Boolean(state.action.free) };
  }
  if (!prompt) return undefined;
  const title = prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt;
  const model = $("model").value;
  if (state.mode === "key") return { rest: { model, input: { prompt }, kind: state.kind }, title };
  const args = { prompt, ...(model ? { model } : {}) };
  return { tool: state.kind === "video" ? "create_video" : "create_image", args, title };
}

function setGo(label, enabled) {
  $("go").textContent = label;
  $("go").disabled = !enabled;
}

function goLabel() {
  if (state.action?.free) return state.action.title;
  return state.action?.video || state.kind === "video" ? "Generate video" : "Generate";
}

function invalidateQuote() {
  state.quote = undefined;
  state.quoteKey = undefined;
  clearTimeout(state.quoteTimer);
  note("");
  const request = currentRequest();
  if (!request) {
    setGo(goLabel(), false);
    return;
  }
  if (request.free) {
    setGo(goLabel(), !state.consent || $("consent").checked);
    return;
  }
  setGo("Getting the price…", false);
  state.quoteTimer = setTimeout(() => fetchQuote(request), 450);
}

function enough(quote) {
  if (quote.balance === undefined) return true;
  return quote.unit === "usd" ? Number(quote.usd) <= Number(quote.balance) : quote.credits <= quote.balance;
}

function showQuote(quote) {
  state.quote = quote;
  if (!enough(quote)) {
    setGo(`${goLabel()} · ${money(quote)}`, false);
    const have = quote.unit === "usd" ? formatUsd(quote.balance) : formatCredits(quote.balance);
    note(`You have ${have}.`, state.mode === "key" ? { href: BILLING_URL, text: "Add funds" } : { href: PRICING_URL, text: "Get credits" });
    return;
  }
  setGo(`${goLabel()} · ${money(quote)}`, !state.consent || $("consent").checked);
  if (quote.expected && quote.expected !== quote.usd) note(`Up to ${formatUsd(quote.usd)}. Usually ${formatUsd(quote.expected)}.`);
}

async function fetchQuote(request) {
  const seq = ++state.quoteSeq;
  try {
    const quote = await send("quote", request);
    if (seq !== state.quoteSeq || fingerprint(currentRequest()) !== fingerprint(request)) return;
    state.quoteKey = fingerprint(request);
    showQuote(quote);
  } catch (error) {
    if (seq !== state.quoteSeq) return;
    setGo(goLabel(), false);
    showError(error);
  }
}

async function loadModels() {
  const select = $("model");
  select.replaceChildren();
  const models = await send("models", { kind: state.kind });
  if (state.mode === "key") {
    const preferred = DEFAULT_REST_MODELS[state.kind];
    models.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    for (const item of models) select.add(new Option([item.name, formatPrice(item.usd)].filter(Boolean).join(" · "), item.id));
  } else {
    select.add(new Option("Auto", ""));
    for (const item of models) select.add(new Option(item.price ? `${item.name} · ${item.price}` : item.name, item.id));
  }
  invalidateQuote();
}

function setKind(kind) {
  state.kind = kind;
  $("kind-image").setAttribute("aria-checked", String(kind === "image"));
  $("kind-video").setAttribute("aria-checked", String(kind === "video"));
  loadModels().catch(showError);
}

function resetConsent() {
  state.consent = false;
  $("consent").checked = false;
  $("consent-row").hidden = true;
}

function clearAction() {
  state.action = undefined;
  state.source = undefined;
  state.prepared = undefined;
  $("source").hidden = true;
  $("kind").hidden = false;
  $("model-row").hidden = false;
  $("choice-row").hidden = true;
  $("prompt-row").hidden = false;
  $("prompt-label").textContent = "Prompt";
  $("prompt").placeholder = "A paper boat on a rainy window sill, soft morning light";
  $("allow-upload").hidden = true;
  $("use-page-copy").hidden = true;
  resetConsent();
  invalidateQuote();
}

async function fillChoice(action) {
  const select = $("choice");
  select.replaceChildren();
  $("choice-row").hidden = !(action.choice || action.effect);
  if (action.choice) {
    $("choice-label").textContent = action.choice.label;
    for (const option of action.choice.options) select.add(new Option(option, option, false, option === action.choice.value));
  } else if (action.effect) {
    $("choice-label").textContent = "Effect";
    select.add(new Option("Loading effects…", ""));
    const effects = await send("effects");
    select.replaceChildren(new Option("Choose an effect", ""));
    for (const effect of effects) select.add(new Option(effect.name, effect.id));
  }
}

async function prepareSource(force = false) {
  const { source } = state;
  state.prepared = undefined;
  $("allow-upload").hidden = true;
  $("use-page-copy").hidden = true;
  $("source-state").textContent = force || !source.srcUrl.startsWith("https:") ? "Reading the image…" : "";
  invalidateQuote();
  try {
    const prepared = await send("prepareImage", { ...source, force });
    if (state.source !== source) return;
    state.prepared = prepared;
    if (prepared.preview) $("source-img").src = prepared.preview;
    $("source-state").textContent = prepared.how === "upload" ? "Uploaded from this page" : "";
    invalidateQuote();
  } catch (error) {
    $("source-state").textContent = "";
    if (error.name === "UploadBlockedError" && error.origin) {
      $("allow-upload").hidden = false;
      $("allow-upload").dataset.origin = error.origin;
      note("PopNow needs permission to upload images from pages.");
      return;
    }
    showError(error);
  }
}

async function startAction(pending) {
  const action = actionById(pending.action);
  if (!action) return;
  if (action.accountOnly && state.mode === "key") {
    showError(new Error(`${action.title} needs a PopNow account.`));
    return;
  }
  clearAction();
  showView("create");
  state.action = action;
  state.source = { srcUrl: pending.srcUrl, tabId: pending.tabId, frameId: pending.frameId, pageUrl: pending.pageUrl };
  $("source").hidden = false;
  $("action-title").textContent = action.title;
  $("source-img").src = pending.srcUrl.startsWith("blob:") ? "icons/icon-48.png" : pending.srcUrl;
  $("kind").hidden = true;
  $("model-row").hidden = true;
  $("prompt-row").hidden = !action.field;
  $("prompt").value = "";
  if (action.field) {
    $("prompt-label").textContent = action.field.label;
    $("prompt").placeholder = action.field.placeholder;
  }
  await Promise.all([fillChoice(action).catch(showError), prepareSource()]);
  if (action.field) $("prompt").focus();
}

// ── Running and following a creation ─────────────────────────────────────────────────────────────

async function go() {
  showError();
  const request = currentRequest();
  if (!request) return;
  if (!request.free && !(state.quote && state.quoteKey === fingerprint(request))) return;
  if (state.consent && !$("consent").checked) return;
  $("go").disabled = true;
  try {
    const outcome = await send("run", {
      ...request,
      approved: request.free ? undefined : state.quote,
      consent: state.consent && $("consent").checked ? true : undefined,
      source: state.source?.pageUrl,
      ...(request.rest ? { rest: { ...request.rest, idempotencyKey: crypto.randomUUID() } } : {}),
    });
    handleOutcome(outcome, request);
  } catch (error) {
    $("go").disabled = false;
    showError(error);
  }
}

function handleOutcome(outcome, request) {
  switch (outcome.kind) {
    case "job":
      if (isRunning(outcome.record)) follow(outcome.record.id);
      else showJob(outcome.record);
      break;
    case "saved":
      showJob(outcome.record);
      break;
    case "confirm":
      // The price went up after it was quoted. Nothing started; ask again with the new price.
      state.quoteKey = fingerprint(request);
      showQuote(outcome.quote);
      note("The price changed before it started. Nothing was charged.");
      break;
    case "consent":
      state.consent = true;
      $("consent-text").textContent = CONSENT_TEXT;
      $("consent-row").hidden = false;
      if (outcome.quote) {
        state.quoteKey = fingerprint(request);
        showQuote(outcome.quote);
      } else {
        setGo($("go").textContent, false);
      }
      break;
    case "lost":
      showError(new Error("PopNow didn't answer in time. It may still be making this: check My creations before you try again."));
      invalidateQuote();
      break;
    case "error":
      showError(new Error(outcome.text));
      if (state.prepared?.how === "link") $("use-page-copy").hidden = false;
      invalidateQuote();
      break;
    default:
      showError(new Error(outcome.text || "Done."));
      invalidateQuote();
  }
}

function elapsed(since) {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function follow(id) {
  state.following = id;
  showView("progress");
  while (state.following === id) {
    const job = (await send("jobs")).find((item) => item.id === id);
    if (!job) break;
    $("status").textContent = `${job.status === "queued" ? "Queued" : "Making it"} · ${elapsed(job.createdAt)}`;
    if (!isRunning(job)) {
      state.following = undefined;
      showJob(job);
      return;
    }
    try {
      await send("poll", { waitSeconds: 10 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function showJob(job) {
  state.shown = job;
  refreshBalance();
  if (job.status === "lost") {
    showView("create");
    showError(new Error("PopNow didn't answer in time. It may still be making this: check My creations before you try again."));
    return;
  }
  if (job.status !== "succeeded") {
    showView("create");
    showError(new Error(`${job.error || "The model could not finish this."} Failed creations are refunded.`));
    if (state.prepared?.how === "link") $("use-page-copy").hidden = false;
    invalidateQuote();
    return;
  }
  const media = $("media");
  media.replaceChildren();
  const file = job.files?.[0];
  if (job.saved) {
    $("result-text").textContent = "Saved to your library.";
    $("download").hidden = true;
    $("copy").hidden = true;
    $("save").hidden = true;
  } else if (file) {
    const element = document.createElement(file.type?.startsWith("video/") ? "video" : "img");
    element.src = file.url;
    if (element.tagName === "VIDEO") {
      element.controls = true;
      element.loop = true;
    } else {
      element.alt = job.title || "Result";
    }
    media.append(element);
    const cost = job.costUsd ? formatUsd(job.costUsd) : typeof job.credits === "number" ? formatCredits(job.credits) : "";
    $("result-text").textContent = cost ? `Used ${cost}` : "";
    $("download").hidden = false;
    $("copy").hidden = false;
    $("copy").textContent = "Copy link";
    $("save").hidden = state.mode === "key" || !file.link;
    $("save").disabled = false;
    $("save").textContent = "Save to my library";
  } else {
    $("result-text").textContent = job.text || "Done.";
    $("download").hidden = true;
    $("copy").hidden = true;
    $("save").hidden = true;
  }
  showView("result");
}

function download() {
  const file = state.shown?.files?.[0];
  if (!file) return;
  chrome.downloads.download({ url: file.url, filename: `popnow-${state.shown.jobId ?? state.shown.id}.${extensionFor(file.type)}` });
}

async function copyLink() {
  const file = state.shown?.files?.[0];
  if (!file) return;
  await navigator.clipboard.writeText(file.url);
  $("copy").textContent = "Copied";
}

async function saveShown() {
  const file = state.shown?.files?.[0];
  if (!file?.link) return;
  $("save").disabled = true;
  try {
    const outcome = await send("run", { tool: "save_to_library", args: { url: file.link }, title: state.shown.title });
    if (outcome.kind === "saved") $("save").textContent = "Saved";
    else throw new Error(outcome.text || "PopNow could not save this.");
  } catch (error) {
    $("save").disabled = false;
    showError(error);
  }
}

// ── My creations ─────────────────────────────────────────────────────────────────────────────────

function creationItem({ url, kind, label, meta, onClick }) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "creation";
  const thumb = document.createElement(kind === "video" && url ? "video" : "img");
  thumb.className = "thumb";
  if (url) {
    thumb.src = url;
    if (thumb.tagName === "VIDEO") {
      thumb.muted = true;
      thumb.preload = "metadata";
    } else {
      thumb.alt = "";
      thumb.loading = "lazy";
    }
  }
  const text = document.createElement("span");
  text.className = "creation-text";
  const title = document.createElement("span");
  title.textContent = label || kind || "Creation";
  const sub = document.createElement("span");
  sub.className = "hint";
  sub.textContent = meta;
  text.append(title, sub);
  button.append(thumb, text);
  button.addEventListener("click", onClick);
  li.append(button);
  return li;
}

async function showCreations() {
  showError();
  showView("creations");
  const list = $("creations-list");
  list.replaceChildren();
  $("creations-empty").hidden = true;
  const local = (await send("jobs")).filter((job) => isRunning(job));
  for (const job of local) {
    list.append(creationItem({ kind: job.tool === "create_video" ? "video" : "image", label: job.title, meta: "In progress", onClick: () => follow(job.id) }));
  }
  if (state.mode === "key") {
    for (const job of (await send("jobs")).filter((item) => item.status === "succeeded" && item.files?.length)) {
      const file = job.files[0];
      list.append(
        creationItem({ url: file.url, kind: file.type?.startsWith("video/") ? "video" : "image", label: job.title, meta: job.costUsd ? formatUsd(job.costUsd) : "", onClick: () => showJob(job) }),
      );
    }
  } else {
    const items = await send("creations");
    for (const item of items) {
      list.append(
        creationItem({
          url: item.url,
          kind: item.kind,
          label: item.label || item.model,
          meta: [item.when, item.cost].filter(Boolean).join(" · "),
          onClick: () => item.url && chrome.tabs.create({ url: item.url }),
        }),
      );
    }
  }
  $("creations-empty").hidden = list.children.length > 0;
}

// ── Start-up ─────────────────────────────────────────────────────────────────────────────────────

async function takePending() {
  const { pending } = await chrome.storage.session.get("pending");
  if (!pending || Date.now() - pending.at > 2 * 60_000) return false;
  await chrome.storage.session.remove("pending");
  if (pending.action) await startAction(pending);
  else if (pending.prompt !== undefined) {
    clearAction();
    showView("create");
    $("prompt").value = pending.prompt;
    invalidateQuote();
  }
  return true;
}

let started = false;

async function init() {
  const { mode } = await send("status");
  state.mode = mode ?? undefined;
  if (!state.mode) {
    showSection("signin");
    return;
  }
  showSection("home");
  applyMode();
  refreshBalance();
  if (!started) {
    started = true;
    await loadModels().catch(showError);
  }
  const params = new URLSearchParams(location.search);
  if (await takePending()) return;
  const jobs = await send("jobs");
  const wanted = params.get("job") && jobs.find((job) => job.id === params.get("job"));
  if (wanted) {
    if (isRunning(wanted)) follow(wanted.id);
    else showJob(wanted);
    return;
  }
  const running = jobs.find(isRunning);
  if (running && running.status !== "starting") follow(running.id);
  else showView("create");
}

async function login() {
  showError();
  $("login").disabled = true;
  $("login").textContent = "Waiting for sign-in…";
  try {
    await send("login");
    started = false;
    await init();
  } catch (error) {
    showError(error);
  } finally {
    $("login").disabled = false;
    $("login").textContent = "Sign in with PopNow";
  }
}

async function signOut() {
  toggleMenu(false);
  if (state.mode === "key") await send("removeKey");
  else await send("logout");
  started = false;
  clearAction();
  await init();
}

async function saveKey() {
  await send("setKey", { key: $("key").value });
  $("key").value = "";
  started = false;
  await init();
}

function wire() {
  const params = new URLSearchParams(location.search);
  if (params.get("window")) document.body.classList.add("window");
  $("keys-link").href = KEYS_URL;
  $("login").addEventListener("click", login);
  $("save-key").addEventListener("click", () => saveKey().catch(showError));
  $("menu-button").addEventListener("click", () => toggleMenu());
  $("menu-signout").addEventListener("click", () => signOut().catch(showError));
  document.addEventListener("click", (event) => {
    if (!$("menu").hidden && !event.target.closest("#menu, #menu-button")) toggleMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") toggleMenu(false);
  });
  $("tab-create").addEventListener("click", () => {
    state.following = undefined;
    showView("create");
  });
  $("tab-creations").addEventListener("click", () => {
    state.following = undefined;
    showCreations().catch(showError);
  });
  $("kind-image").addEventListener("click", () => setKind("image"));
  $("kind-video").addEventListener("click", () => setKind("video"));
  for (const id of ["prompt", "model", "choice"]) $(id).addEventListener(id === "prompt" ? "input" : "change", invalidateQuote);
  $("consent").addEventListener("change", () => {
    if (state.quote) showQuote(state.quote);
    else invalidateQuote();
  });
  $("go").addEventListener("click", go);
  $("prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !$("go").disabled) go();
  });
  $("source-clear").addEventListener("click", clearAction);
  $("allow-upload").addEventListener("click", async () => {
    const origin = $("allow-upload").dataset.origin;
    try {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (granted) {
        note("");
        await prepareSource(true);
      }
    } catch {
      showError(new Error("PopNow can't upload to this address from the extension."));
    }
  });
  $("use-page-copy").addEventListener("click", () => {
    showError();
    prepareSource(true);
  });
  $("download").addEventListener("click", download);
  $("copy").addEventListener("click", () => copyLink().catch(showError));
  $("save").addEventListener("click", saveShown);
  $("again").addEventListener("click", () => {
    showError();
    showView("create");
    invalidateQuote();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    // Only a sign-in or sign-out matters here, not a refreshed token.
    const flipped = (name) => name in changes && Boolean(changes[name].oldValue) !== Boolean(changes[name].newValue);
    if (area === "local" && (flipped("account") || flipped("apiKey"))) {
      started = false;
      init().catch(showError);
    }
    if (area === "session" && changes.pending?.newValue && state.mode) takePending().catch(showError);
  });
}

wire();
init().catch(showError);
