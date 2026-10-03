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
  compact   PreCompact   -> touches .voice_compacting so the faces can
                            run their compaction animation while the CLI
                            is folding the context down. Cleared by the
                            next idle, since PreCompact has no "done"
                            counterpart to fire on.

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
# The uuid of the last reply we logged, so a Stop hook can tell a
# genuinely new reply from the previous turn's still-stale one.
LAST_REPLY = BUS_DIR / ".transcript_last"
# Touched at PreCompact, removed at the next Stop: the faces treat its
# presence (and freshness) as "compaction in progress".
COMPACTING = BUS_DIR / ".voice_compacting"
MAX_LINES = 200
# How long to wait for the CLI to flush this turn's reply to the
# transcript file before giving up. See wait_for_reply().
REPLY_WAIT_S = 1.0
REPLY_POLL_S = 0.1


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
    """The newest assistant text in the transcript, with its uuid."""
    try:
        lines = Path(transcript_path).read_text(
            encoding="utf-8", errors="replace"
        ).splitlines()
    except OSError:
        return None, None
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
            return text, obj.get("uuid")
    return None, None


def wait_for_reply(transcript_path):
    """This turn's reply, waiting out the flush that made it lag.

    The Stop hook can fire BEFORE the CLI has written the turn's final
    assistant message to the transcript file, so a naive read returns
    the PREVIOUS turn's reply -- the panel then sat exactly one turn
    behind forever. Identity, not recency, is what settles it: we
    remember the uuid we logged last time and poll until a different
    one shows up.

    KNOWN LIMIT: waiting does not actually fix this. The CLI writes the
    turn's assistant message AFTER its Stop hooks complete, so the line
    we want cannot appear while we are still blocking for it -- the wait
    only guarantees we never log the SAME line twice. The real cure is
    for whatever produced the reply to publish it (backtalk does this in
    signals.transcript); this stays for setups with no voice line, where
    one turn behind beats nothing at all.

    Bounded, and gives up quietly rather than logging a known-stale
    line: a missing line is honest, a wrong one is not."""
    try:
        seen = LAST_REPLY.read_text(encoding="utf-8").strip()
    except OSError:
        seen = ""
    deadline = time.time() + REPLY_WAIT_S
    while True:
        text, uuid = last_assistant_text(transcript_path)
        if text and uuid and uuid != seen:
            try:
                LAST_REPLY.write_text(uuid, encoding="utf-8")
            except OSError:
                pass
            return text
        if time.time() >= deadline:
            return None
        time.sleep(REPLY_POLL_S)


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
        prompt = " ".join((data.get("prompt") or "").split())
        if prompt:
            append(TRANSCRIPT, f"YOU: {prompt}")
    elif mode == "reply":
        text = wait_for_reply(data.get("transcript_path", ""))
        if text:
            text = " ".join(text.split())
            append(TRANSCRIPT, f"JANUS: {text}")
    elif mode == "compact":
        COMPACTING.write_text(str(time.time()), encoding="utf-8")
        append(ACTIVITY, f"{int(time.time() * 1000)}|Compacting context")
    elif mode == "idle":
        COMPACTING.unlink(missing_ok=True)
        append(ACTIVITY, f"{int(time.time() * 1000)}|__IDLE__")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
