---
name: subagent-session
description: Run another Pi web agent in a separate child conversation and wait for its final answer.
---

# Subagent Session

Use this skill when a task should be delegated to another Pi web agent in a separate conversation.

When `PI_WEB_SUBAGENT_SESSION_URL` is available, start a child session with a POST request:

```json
{
  "agent": "Plan",
  "prompt": "Create a decision-complete implementation plan for this feature."
}
```

Use a portable shell command like:

```sh
curl -fsS -X POST "$PI_WEB_SUBAGENT_SESSION_URL" \
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

The child session receives only the prompt you send. Include all context the child needs inside `prompt`.

Choose the agent by id or exact name, such as `Plan` or `Main`.

If `PI_WEB_SUBAGENT_SESSION_URL` is not available, ask the user to run the delegation manually in a new conversation.
