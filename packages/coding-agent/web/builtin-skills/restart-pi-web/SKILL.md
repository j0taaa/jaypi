---
name: restart-pi-web
description: Restart Pi web while developing this project itself so the browser uses the latest local code.
---

# Restart Pi Web

Use this skill when the user is developing Pi web / jaypi itself and asks to restart Pi web, reload the updated Pi web server, or make recent local Pi web changes take effect.

Pi web runs the agent as a child process. If you kill the current Pi web process before scheduling the replacement, you may interrupt yourself before the restart happens.

## Workflow

1. Finish any requested code changes and run the required checks first.
2. Tell the user the current Pi web page will disconnect briefly.
3. Schedule a detached restart command that:
   - finds the Pi web server parent process from the current RPC child,
   - starts a new `pi web` after a short delay in the current project directory,
   - then terminates the old Pi web server.
4. After scheduling the restart, do not keep working in the old session. Tell the user to refresh or reopen the printed Pi web URL after a few seconds.

## Command

Run this from the project root:

```sh
mkdir -p .pi
cwd="$PWD"
port="$(node -e 'try { console.log(new URL(process.env.PI_WEB_SUBAGENT_SESSION_URL || process.env.PI_WEB_ASK_QUESTION_URL || "http://127.0.0.1:5173").port || "5173") } catch { console.log("5173") }')"
shell_pid="$$"
rpc_pid="$(ps -o ppid= -p "$shell_pid" | tr -d ' ')"
web_pid="$(ps -o ppid= -p "$rpc_pid" | tr -d ' ')"
if [ -z "$rpc_pid" ] || [ -z "$web_pid" ]; then
  echo "Could not find Pi web parent process"
  exit 1
fi
nohup sh -c '
  cwd="$1"
  port="$2"
  web_pid="$3"
  sleep 1
  kill "$web_pid" 2>/dev/null || true
  sleep 1
  cd "$cwd" || exit 1
  exec pi web --port "$port" --no-open
' sh "$cwd" "$port" "$web_pid" >> .pi/pi-web-restart.log 2>&1 &
echo "Scheduled Pi web restart on port $port. Refresh the browser in a few seconds."
```

If the user wants to restart manually instead, stop the running Pi web process and tell them to run `pi web` from the project root.
