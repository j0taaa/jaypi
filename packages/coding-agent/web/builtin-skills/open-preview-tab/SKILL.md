---
name: open-preview-tab
description: Open a new Pi web preview tab in the current conversation for a URL or local server file path.
---

# Open Preview Tab

Use this skill when the user asks to open, show, preview, or keep visible a website, local HTML/PDF/Markdown/text/image file, screenshot, generated artifact, or other previewable output in the Pi web preview sidebar.

When `PI_WEB_PREVIEW_TAB_URL` is available, open a new preview tab by sending the source to Pi web:

```sh
curl -fsS -X POST "$PI_WEB_PREVIEW_TAB_URL" \
  -H 'content-type: application/json' \
  -d '{"source":"<url-or-local-file-path>"}'
```

The `source` can be:

- A website URL, such as `https://example.com`
- A host-like URL without a protocol, such as `localhost:3000` or `example.com`
- An absolute local file path on the server, such as `/Users/jota/project/README.md`
- A relative file path from the current working directory, such as `dist/report.html`
- Empty, to open the current conversation export

Do not add `http://` or `https://` to local file paths. Pi web will normalize host-like sources when appropriate and will keep file paths as file previews.

Prefer this skill over pasting long file contents into chat when the user wants to visually inspect a rendered artifact. After opening the preview tab, mention briefly what was opened.

If `PI_WEB_PREVIEW_TAB_URL` is not available, tell the user the preview tab endpoint is not available in this session and provide the URL or file path they can paste into the preview sidebar manually.
