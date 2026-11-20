# Privacy

The PopNow browser extension has no analytics and reads no page content by itself.

- **Your sign-in** (OAuth tokens for your PopNow account, or an API key if you add one) is stored in the browser's local extension storage and sent only to `api.popnow.ai`. Signing out deletes it and revokes the tokens.
- **Images you right-click** are sent to PopNow only after you choose a PopNow action. A public image is sent as its link. An image without a public link is read from that page and uploaded to your PopNow account.
- **Your prompt** is sent to `api.popnow.ai` when you ask for a price or start a creation. Text from a page is used only when you select it and choose **Create with PopNow**.
- **Running creations** (their ID, title and result links) are kept in local extension storage so the extension can tell you when they finish.
- **Generated files** are loaded from PopNow's storage and saved only when you click Download.

PopNow's handling of requests is covered by its [privacy policy](https://popnow.ai/privacy).
