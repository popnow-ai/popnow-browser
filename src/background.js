// Service worker: right-click menus, sign-in, every call to PopNow, and polling of running jobs.
// MV3 may stop this worker at any time, so running jobs live in chrome.storage.local and an alarm
// picks them up again.

import { actionFromMenuId, MENU_PARENT, MENU_SELECTION, menuEntries } from "./lib/actions.js";
import { decodeDataUrl, grabImageInPage, imageSource } from "./lib/page-image.js";
import { isRunning } from "./lib/run.js";
import { createService } from "./lib/service.js";
import { MAX_UPLOAD_BYTES } from "./lib/upload.js";

const POLL_ALARM = "popnow-poll";
const storage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};
const service = createService({ fetch: (...args) => fetch(...args), storage, version: chrome.runtime.getManifest().version });

/** Keeps the worker awake while a long call (sign-in, a creation that waits on the server) is open. */
async function keepAlive(work) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => undefined), 20_000);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

let building = Promise.resolve();
function buildMenus() {
  building = building.then(async () => {
    await chrome.contextMenus.removeAll();
    const mode = await service.mode();
    chrome.contextMenus.create({ id: MENU_SELECTION, title: "Create with PopNow", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_PARENT, title: "PopNow", contexts: ["image"] });
    for (const entry of menuEntries(mode)) chrome.contextMenus.create(entry);
  }).catch(() => undefined);
  return building;
}

async function ensurePolling() {
  const running = (await service.jobs()).some(isRunning);
  if (running) {
    const existing = await chrome.alarms.get(POLL_ALARM);
    if (!existing) await chrome.alarms.create(POLL_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(POLL_ALARM);
  }
}

async function extensionPageOpen() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP", "TAB"] });
  return contexts.length > 0;
}

async function notifyDone(job) {
  if (await extensionPageOpen()) return;
  const ok = job.status === "succeeded";
  const what = job.tool === "create_video" || job.tool === "apply_effect" ? "video" : "image";
  await chrome.notifications.create(job.id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: ok ? `Your ${what} is ready` : "PopNow could not finish this",
    message: ok ? job.title || "Open PopNow to see it." : "Failed creations are refunded. Open PopNow for details.",
  });
}

async function poll(waitSeconds = 0) {
  const left = await keepAlive(service.poll({ notify: notifyDone, waitSeconds }));
  if (left === 0) await chrome.alarms.clear(POLL_ALARM);
  return left;
}

async function openWindow(query = "") {
  if (!query && chrome.action.openPopup) {
    try {
      await chrome.action.openPopup();
      return;
    } catch {
      // No focused browser window, or an older Chrome: open a small window instead.
    }
  }
  await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?window=1${query}`), type: "popup", width: 420, height: 700 });
}

async function prepareImage({ srcUrl, tabId, frameId, force }) {
  if (!force && imageSource(srcUrl) === "link") return { ref: srcUrl, preview: srcUrl, how: "link" };
  let dataUrl = srcUrl.startsWith("data:") ? srcUrl : undefined;
  if (!dataUrl) {
    if (typeof tabId !== "number") throw new Error("Right-click the image on its page again.");
    let injected;
    try {
      [injected] = await chrome.scripting.executeScript({
        target: { tabId, ...(typeof frameId === "number" && frameId > 0 ? { frameIds: [frameId] } : {}) },
        func: grabImageInPage,
        args: [srcUrl, MAX_UPLOAD_BYTES],
      });
    } catch {
      throw new Error("This page can't be read any more. Right-click the image on its page again.");
    }
    const grabbed = injected?.result ?? {};
    if (grabbed.error === "too_large") throw new Error("This image is too large to upload.");
    if (!grabbed.dataUrl) throw new Error("This page doesn't let PopNow read the image. Save it and upload it on popnow.ai.");
    dataUrl = grabbed.dataUrl;
  }
  if (decodeDataUrl(dataUrl).bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("This image is too large to upload.");
  const ref = await service.uploadImage({ dataUrl, srcUrl });
  return { ref, preview: dataUrl, how: "upload" };
}

const handlers = {
  status: async () => ({ mode: (await service.mode()) ?? null }),
  login: () =>
    keepAlive(
      service.login({
        redirectUri: chrome.identity.getRedirectURL(),
        launch: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
      }),
    ),
  logout: () => service.logout(),
  setKey: ({ key }) => service.setKey(key),
  removeKey: () => service.removeKey(),
  balance: () => service.balance(),
  models: ({ kind }) => service.models(kind),
  effects: () => service.effects(),
  creations: () => service.creations(),
  jobs: () => service.jobs(),
  prepareImage: (message) => keepAlive(prepareImage(message)),
  quote: (message) => keepAlive(service.quote(message)),
  run: async (message) => {
    const outcome = await keepAlive(service.run(message));
    await ensurePolling();
    return outcome;
  },
  poll: ({ waitSeconds }) => poll(waitSeconds),
  forgetJob: ({ id }) => service.forgetJob(id),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !handlers[message?.type]) return false;
  handlers[message.type](message)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error), name: error?.name, origin: error?.origin }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  buildMenus();
  ensurePolling();
});
chrome.runtime.onStartup.addListener(() => {
  buildMenus();
  ensurePolling();
});

chrome.storage.onChanged.addListener((changes, area) => {
  const flipped = (name) => name in changes && Boolean(changes[name].oldValue) !== Boolean(changes[name].newValue);
  if (area === "local" && (flipped("apiKey") || flipped("account"))) buildMenus();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) poll().catch(() => undefined);
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  openWindow(`&job=${encodeURIComponent(id)}`);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let pending;
  if (info.menuItemId === MENU_SELECTION) {
    pending = { prompt: info.selectionText ?? "" };
  } else {
    const action = actionFromMenuId(info.menuItemId);
    if (!action || !info.srcUrl) return;
    pending = { action: action.id, srcUrl: info.srcUrl, pageUrl: info.pageUrl, tabId: tab?.id, frameId: info.frameId };
  }
  // openPopup has to run while the click still counts as a user action, so it doesn't wait for storage.
  chrome.storage.session.set({ pending: { ...pending, at: Date.now() } }).catch(() => undefined);
  openWindow();
});
