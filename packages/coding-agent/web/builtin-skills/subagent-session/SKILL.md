---
name: subagent-session
description: Run another Pi web agent in a separate child conversation and wait for its final answer.
---

# Subagent Session

Use this skill when a task should be delegated to another Pi web agent in a separate conversation.

In Pi web, `PI_WEB_SUBAGENT_SESSION_URL` is injected into shell commands. Do not infer that it is missing just because it is not shown in the prompt. When you have shell access, first check the variable in the shell and use it if it is set.

When `PI_WEB_SUBAGENT_SESSION_URL` is set, start a child session with a POST request:

```json
{
  "agent": "Plan",
  "prompt": "Create a decision-complete implementation plan for this feature."
}
```

Use a portable shell command like:

```sh
test -n "$PI_WEB_SUBAGENT_SESSION_URL" || { echo "PI_WEB_SUBAGENT_SESSION_URL is not set"; exit 1; }
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

Only fall back to asking the user to run the delegation manually in a new conversation after a shell command confirms that `PI_WEB_SUBAGENT_SESSION_URL` is empty or unavailable.
