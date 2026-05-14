---
name: open-preview-tab
description: Open a new Pi web preview tab in the current conversation for a URL or local server file path.
---

# Open Preview Tab

Use this skill when the user asks to open, show, preview, or keep visible a website, local HTML/PDF/Markdown/text/image file, screenshot, generated artifact, or other previewable output in the Pi web preview sidebar.

Pi web provides `Current Pi web server URL` in the system prompt when this skill is available. Use that URL plus `/api/preview-tab` to open a new preview tab:

```sh
# Replace this with the exact value from "Current Pi web server URL".
pi_web_url="http://127.0.0.1:5173"

curl -fsS -X POST "$pi_web_url/api/preview-tab" \
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

If `Current Pi web server URL` is not available, tell the user the preview tab endpoint is not available in this session and provide the URL or file path they can paste into the preview sidebar manually.
