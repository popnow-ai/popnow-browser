const MENU_ID = "popnow-generate";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Generate with PopNow", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  const url = chrome.runtime.getURL(`popup.html?tab=1&prompt=${encodeURIComponent(info.selectionText ?? "")}`);
  chrome.tabs.create({ url });
});
