# Store listing

**Name:** PopNow: AI Image and Video Generator

**Short description:** Right-click any image to edit, animate, upscale or relight it with AI. Sign in with PopNow and see the price in credits first.

**Description:**

PopNow brings AI image and video tools to every page. Right-click a picture, choose what to do, and see the price in credits before anything starts.

- Right-click any image: Edit image, Animate, Remove background, Upscale, Expand, Relight, Apply effect, Save to my library
- Write a prompt to create images and videos with Nano Banana, Seedream, Kling, MiniMax H3, Veo and more
- The price in credits is on the button before every run
- Videos keep rendering when you close the popup, with a notification when they're ready
- Download, copy the link or save results to your PopNow library
- Your credit balance and latest creations in one place
- Failed creations are refunded automatically

Sign in with your PopNow account. Same credits and same prices as popnow.ai.

**Website:** https://popnow.ai
**Support:** support@popnow.ai
**Privacy policy:** https://popnow.ai/privacy

**Single purpose (Chrome):** Create and edit images and videos with PopNow from images on web pages or from a prompt.

**Permission justifications (Chrome):**

- `storage`: keeps the user's PopNow sign-in and the list of creations still running.
- `contextMenus`: adds the PopNow menu to images and to selected text.
- `activeTab`: lets the extension read the image the user right-clicked, in that tab only, after they choose a PopNow action.
- `scripting`: runs a short function in that tab to read an image that has no public link (for example a data: or blob: image) so it can be uploaded.
- `downloads`: saves a result when the user clicks Download.
- `identity`: opens the PopNow sign-in window (`launchWebAuthFlow`).
- `notifications`: tells the user when a long creation is ready.
- `alarms`: checks on running creations while the popup is closed.
- Host `https://api.popnow.ai/*`: calls PopNow.
- Optional hosts `https://*.r2.cloudflarestorage.com/*`, `https://*.popnow.ai/*`: requested only when the browser blocks an upload from a page, to send the image to PopNow's signed upload address.

**Remote code:** No.

**Data use disclosure:** Authentication information (PopNow sign-in tokens, kept locally); website content (only the image or text the user picks for a PopNow action). Not sold, not used for unrelated purposes.

**Reviewer note:** Sign in with the PopNow test account given in the review notes. It has credits for a few runs. Right-click any image on a page, for example on https://unsplash.com, and choose PopNow → Remove background.

**Screenshots (1280×800), to retake with a real account:**

1. Right-click menu on an image with the PopNow submenu open.
2. Relight: the image, the "New light" box and the "Generate · N credits" button.
3. Result with Download, Copy link and Save to my library.
4. Prompt box with model picker and the price on the button.
5. My creations with the credit balance in the header.
