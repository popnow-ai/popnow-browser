# PopNow browser extension

Right-click any image on the web to edit, animate, upscale, relight or expand it with [PopNow](https://popnow.ai), or write a prompt in the popup to create images and videos with Nano Banana, Seedream, Kling, MiniMax H3, Veo and more. Works in Chrome, Edge, Opera and Firefox.

Built by PopNow AI ([popnow.ai](https://popnow.ai)), the world's first AI studio with automatic price protection.

## Features

- **Sign in with your PopNow account.** Same credits and same prices as popnow.ai.
- **Right-click an image** and choose Edit image, Animate, Remove background, Upscale, Expand, Relight, Apply effect or Save to my library.
- **See the price first.** Every paid run shows its price in credits on the button. Nothing starts until you click it, and if the price changes before it starts, PopNow asks again.
- **Keep browsing.** Videos keep rendering when you close the popup, and a notification tells you when they're ready.
- **Download, copy the link or save to your library** from the result.
- **My creations** shows your latest work and your credit balance.
- Failed creations are refunded automatically.

Images with a public https address are sent to PopNow as a link. Images that only exist in the page (data: and blob: images, or pictures behind a sign-in) are read from the page you right-clicked and uploaded to your account.

## Developers: API key mode

Under **Developers** on the sign-in screen you can paste a PopNow API key instead. With a key, everything is billed in USD from your API balance and prices show in USD; the right-click tools use the developer MCP server at `https://api.popnow.ai/api/v1/mcp`, and the prompt box uses the REST API. Removing the key returns the extension to account mode.

## How it works

- Sign-in is OAuth 2.1 with PKCE and dynamic client registration against `https://api.popnow.ai/mcp`, through `chrome.identity.launchWebAuthFlow`. The return address is `chrome.identity.getRedirectURL()` (`https://<extension-id>.chromiumapp.org/`), registered at sign-in.
- Tokens are kept in `chrome.storage.local`, never logged and never sent anywhere except `api.popnow.ai`. Sign out revokes them.
- Running jobs are stored, so a stopped service worker picks them up again; an alarm polls `get_job` every 30 seconds until they finish.
- Code that talks to PopNow lives in `src/lib/` as plain modules with no browser globals, and is tested in Node against a fake server.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Your sign-in, an optional API key and the list of running creations. |
| `contextMenus` | The PopNow menu on images and selected text. |
| `activeTab`, `scripting` | Read the image you right-clicked when it has no public link (only in that tab, only after you choose a PopNow action). |
| `downloads` | Save a result when you click Download. |
| `identity` | The PopNow sign-in window. |
| `notifications` | Tell you when a long creation is ready. |
| `alarms` | Check on running creations while the popup is closed. |
| `https://api.popnow.ai/*` | Talk to PopNow. |
| Optional: `https://*.r2.cloudflarestorage.com/*`, `https://*.popnow.ai/*` | Requested only if an upload from a page is blocked by the browser, to send the image to PopNow's signed upload address. |

## Build and test

```bash
node --test test/
node scripts/build.mjs
```

The build writes `dist/chromium` and `dist/firefox`, plus a zip of each. There are no dependencies.

## Privacy

See [PRIVACY.md](PRIVACY.md).
