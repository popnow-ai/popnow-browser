// Builds dist/chromium (Chrome, Edge, Opera) and dist/firefox, then zips each for store upload.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const base = JSON.parse(readFileSync("src/manifest.json", "utf8"));
const { minimum_chrome_version: _chromeOnly, ...portable } = base;
const targets = {
  chromium: base,
  firefox: {
    ...portable,
    background: { scripts: ["background.js"], type: "module" },
    browser_specific_settings: {
      gecko: { id: "extension@popnow.ai", strict_min_version: "128.0", data_collection_permissions: { required: ["authenticationInfo", "websiteContent"] } },
    },
  },
};

for (const [name, manifest] of Object.entries(targets)) {
  const out = `dist/${name}`;
  mkdirSync(out, { recursive: true });
  cpSync("src", out, { recursive: true });
  cpSync("icons", `${out}/icons`, { recursive: true });
  writeFileSync(`${out}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("zip", ["-qr", `../popnow-${name}-${base.version}.zip`, "."], { cwd: out });
}
