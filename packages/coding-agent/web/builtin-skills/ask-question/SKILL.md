---
name: ask-question
description: Ask the user a multiple-choice question and allow a custom answer when none of the options match.
---

# Ask Question

Use this skill when you need the user to choose between a small set of options before continuing.

When `Current Pi web server URL` is present in the system prompt, ask through Pi web's native inline question UI. Send a POST request to `<current-pi-web-server-url>/api/ask-question` with JSON:

```json
{
  "question": "Which option should I use?",
  "options": ["Option A", "Option B"]
}
```

Use a portable shell command like:

```sh
# Replace this with the exact value from "Current Pi web server URL".
pi_web_url="<current-pi-web-server-url>"
curl -fsS -X POST "$pi_web_url/api/ask-question" \
  -H 'content-type: application/json' \
  -d '{"question":"Which option should I use?","options":["Option A","Option B"]}'
```

The response is JSON:

```json
{
  "answer": "Option A",
  "optionIndex": 0,
  "custom": false
}
```

If the user writes their own answer, `optionIndex` is `null` and `custom` is `true`.

If `Current Pi web server URL` is not available, ask in normal chat. Include numbered options and an `Other` option that tells the user they can write their own answer.
