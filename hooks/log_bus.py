#!/usr/bin/env python3
"""Feed the ai-visualizer's activity/transcript panels from Claude Code's
own hooks. Four modes, picked by argv[1], each reading one hook event's
JSON off stdin:

  activity  PreToolUse   -> appends a one-line summary of the tool call
  user      UserPromptSubmit -> appends what Mind typed or said
  reply     Stop         -> appends Janus's final reply this turn
  idle      Stop         -> appends an __IDLE__ marker so the activity
                            panel's timer clears instead of counting up
                            forever on the last tool call of the turn

Never raises past main(): a hook that errors can interrupt the session,
so every failure here is swallowed silently rather than surfaced.
"""
import json
import sys
import time
from pathlib import Path

BUS_DIR = Path(r"E:/Jarvis/backtalk")
ACTIVITY = BUS_DIR / ".activity_log"
TRANSCRIPT = BUS_DIR / ".transcript_log"
MAX_LINES = 200


def append(path, line):
    lines = []
    if path.exists():
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    lines.append(line)
    path.write_text("\n".join(lines[-MAX_LINES:]) + "\n", encoding="utf-8")


def summarize_tool(name, inp):
    if name == "Bash":
        return "$ " + (inp.get("description") or inp.get("command", "")[:80])
    if name in ("Read", "Edit", "Write"):
        return f"{name}: {inp.get('file_path', '')}"
    if name == "Grep":
        return f"Grep: {inp.get('pattern', '')}"
    if name == "Glob":
        return f"Glob: {inp.get('pattern', '')}"
    if name == "WebSearch":
        return f"WebSearch: {inp.get('query', '')}"
    if name == "WebFetch":
        return f"WebFetch: {inp.get('url', '')}"
    if name == "Agent":
        return f"Agent: {inp.get('description', '')}"
    if name == "TodoWrite":
        return "Updating task list"
    return name


def last_assistant_text(transcript_path):
    try:
        lines = Path(transcript_path).read_text(
            encoding="utf-8", errors="replace"
        ).splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if obj.get("type") != "assistant":
            continue
        parts = (obj.get("message") or {}).get("content") or []
        texts = [p.get("text", "") for p in parts
                 if isinstance(p, dict) and p.get("type") == "text"]
        text = " ".join(t for t in texts if t).strip()
        if text:
            return text
    return None


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}

    if mode == "activity":
        line = summarize_tool(data.get("tool_name", ""), data.get("tool_input") or {})
        if line:
            append(ACTIVITY, f"{int(time.time() * 1000)}|{line}")
    elif mode == "user":
        prompt = (data.get("prompt") or "").strip()
        if prompt:
            append(TRANSCRIPT, f"YOU: {prompt}")
    elif mode == "reply":
        text = last_assistant_text(data.get("transcript_path", ""))
        if text:
            append(TRANSCRIPT, f"JANUS: {text}")
    elif mode == "idle":
        append(ACTIVITY, f"{int(time.time() * 1000)}|__IDLE__")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
