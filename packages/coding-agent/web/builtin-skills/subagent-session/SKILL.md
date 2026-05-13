---
name: subagent-session
description: Run another Pi web agent in a child conversation, or continue an existing child conversation, and wait for its final answer.
---

# Subagent Session

Use this skill when a task should be delegated to another Pi web agent in a separate conversation, or when you need to send a follow-up message to an existing subagent session.

Pi web provides `Current Pi web server URL` in the system prompt when this skill is available. Use that URL plus `/api/subagent-session` to start a child session or continue an existing one.

Start a new child session with a POST request:

```json
{
  "agent": "Plan",
  "prompt": "Create a decision-complete implementation plan for this feature."
}
```

Send a follow-up message to an existing child session by passing `sessionId`, `sessionFile`, or `sessionPath` from an earlier response:

```json
{
  "sessionId": "...",
  "prompt": "Continue from your previous answer and compare the second option."
}
```

For existing sessions, `agent` is optional and the existing session context is preserved.

Use a portable shell command like:

```sh
# Replace this with the exact value from "Current Pi web server URL".
pi_web_url="<current-pi-web-server-url>"
curl -fsS -X POST "$pi_web_url/api/subagent-session" \
  -H 'content-type: application/json' \
  -d '{"agent":"Plan","prompt":"Create a decision-complete implementation plan for this feature."}'
```

The response is JSON:

```json
{
  "success": true,
  "data": {
    "id": "subagent_...",
    "sessionFile": "...",
    "sessionId": "...",
    "answer": "...",
    "status": "done"
  }
}
```

The endpoint waits until the child agent finishes its output, then returns the latest final assistant text in `data.answer`.

For new child sessions, the child receives only the prompt you send. Include all context the child needs inside `prompt`.

For existing child sessions, the prompt is appended to that session, so the child can use its previous conversation context.

Choose the agent by id or exact name, such as `Plan` or `Main`.

If `Current Pi web server URL` is not present, ask the user to run the delegation manually in a new conversation.
