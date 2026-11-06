# PopNow browser extension

Generate AI images and videos from any page with [PopNow](https://popnow.ai/api): Nano Banana, GPT Image, Seedream, FLUX, Kling, Seedance, MiniMax H3, Veo and more through one API key. Works in Chrome, Edge, Opera and Firefox.

Requires a PopNow account and API balance.

## Features

- Open the popup, write a prompt, pick a model and see the price before anything is charged.
- Select text on any page, right-click and choose **Generate with PopNow** to use it as the prompt.
- Tasks keep running if you close the popup. The result shows when you come back.
- Failed jobs are refunded automatically.

## Setup

1. Create an API key in the [PopNow API console](https://popnow.ai/api/console/keys) and add funds to your API balance.
2. Open the extension and paste the key. It stays in your browser's local extension storage.

## Build

```bash
node scripts/build.mjs
```

This writes `dist/chromium` and `dist/firefox`, plus a zip of each for store upload. There are no dependencies.

## Privacy

See [PRIVACY.md](PRIVACY.md).
