// What right-clicking an image can do. Each action maps to one PopNow tool.
// `accountOnly` actions are hidden when an API key is in use (the developer server has no library).

export const MENU_PARENT = "popnow-image";
export const MENU_SELECTION = "popnow-generate";

export const ACTIONS = [
  {
    id: "edit",
    title: "Edit image",
    tool: "edit_image",
    imageArg: "image_url",
    field: { name: "prompt", label: "What should change?", placeholder: "Put her in a red raincoat", required: true },
  },
  {
    id: "animate",
    title: "Animate",
    tool: "create_video",
    imageArg: "image_url",
    video: true,
    field: { name: "prompt", label: "How should it move?", placeholder: "The camera slowly pushes in as the wind picks up", required: true },
  },
  { id: "remove_background", title: "Remove background", tool: "remove_background", imageArg: "image_url" },
  {
    id: "upscale",
    title: "Upscale",
    tool: "upscale",
    imageArg: "image_url",
    choice: { name: "size", label: "Size", options: ["2k", "4k", "8k"], value: "4k" },
  },
  {
    id: "expand",
    title: "Expand",
    tool: "expand_image",
    imageArg: "image_url",
    choice: { name: "aspect_ratio", label: "New shape", options: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2"], value: "16:9" },
  },
  {
    id: "relight",
    title: "Relight",
    tool: "relight_photo",
    imageArg: "image_url",
    field: { name: "prompt", label: "New light", placeholder: "Warm golden-hour sun from the left", required: true },
  },
  { id: "effect", title: "Apply effect", tool: "apply_effect", imageArg: "image_url", video: true, effect: true },
  { id: "save", title: "Save to my library", tool: "save_to_library", imageArg: "url", free: true, accountOnly: true },
];

export function actionById(id) {
  return ACTIONS.find((action) => action.id === id);
}

/** Whether every input the action needs is filled in. */
export function isReady(action, values) {
  if (action.field?.required && !String(values[action.field.name] ?? "").trim()) return false;
  if (action.effect && !values.effect) return false;
  return true;
}

/** The tool arguments for an action on an image link (https:// or popnow://). */
export function buildArgs(action, imageRef, values = {}) {
  const args = { [action.imageArg]: imageRef };
  if (action.field) {
    const text = String(values[action.field.name] ?? "").trim();
    if (text) args[action.field.name] = text;
  }
  if (action.choice) args[action.choice.name] = values[action.choice.name] || action.choice.value;
  if (action.effect) args.effect = values.effect;
  return args;
}

/** Context menu entries for the current mode. */
export function menuEntries(mode) {
  return ACTIONS.filter((action) => mode !== "key" || !action.accountOnly).map((action) => ({
    id: `popnow-${action.id}`,
    parentId: MENU_PARENT,
    title: action.title,
    contexts: ["image"],
  }));
}

export function actionFromMenuId(menuItemId) {
  return typeof menuItemId === "string" && menuItemId.startsWith("popnow-") ? actionById(menuItemId.slice("popnow-".length)) : undefined;
}
