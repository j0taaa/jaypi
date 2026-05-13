---
name: progress-tracker
description: Track work progress in Pi web by updating a Markdown task file that the UI watches and renders above the input.
---

# Progress Tracker

Use this skill when the user wants visible task progress while you work.

Create or update a Markdown file with this format:

```md
# Progress

- [ ] Task not started
- [~] Task in progress
- [x] Task done
```

Use only these task markers:

- `[ ]` for todo
- `[~]` for currently doing
- `[x]` for done

When `Current Pi web server URL` is present in the system prompt, register the tracker file with Pi web after creating it:

```sh
# Replace this with the exact value from "Current Pi web server URL".
pi_web_url="<current-pi-web-server-url>"
curl -fsS -X POST "$pi_web_url/api/progress-tracker" \
  -H 'content-type: application/json' \
  -d '{"path":"./.pi/progress.md"}'
```

After registration, update the Markdown file as work progresses. Pi web will watch the file and update the progress UI.

If `Current Pi web server URL` is not available, keep progress visible in normal chat with the same task-list format.
