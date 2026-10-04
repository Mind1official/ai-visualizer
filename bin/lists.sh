#!/bin/bash
# lists.sh -- the two standing lists in the top-right of Janus's face:
# what we are working on RIGHT NOW, and the to-do list. They persist; the
# stage does not. Clearing the stage never touches these.
#
#   lists.sh '{"p":"now","a":"set","items":["Gmail server","Tuition fix"]}'
#   lists.sh '{"p":"todo","a":"add","text":"Bounce the voice line"}'
#   lists.sh '{"p":"todo","a":"done","id":"i123"}'      # toggles the strike
#   lists.sh '{"p":"todo","a":"remove","id":"i123"}'
#   lists.sh '{"p":"now","a":"clear"}'
#
# p is "now" or "todo". `set` replaces a whole list, which is usually the
# honest move: these mirror Active Priorities, so rewrite rather than patch.
# An empty list draws nothing at all. Press L on the face to hide both.
set -euo pipefail
PORT="$(python -c "import json,pathlib;print(json.loads(pathlib.Path('$(dirname "$0")/../ai-visualizer.json').read_text()).get('port',8790))" 2>/dev/null || echo 8790)"
curl -fsS -X POST "http://127.0.0.1:${PORT}/panels" \
  -H "Content-Type: application/json" \
  -d "${1:?usage: lists.sh '{\"p\":\"todo\",\"a\":\"add\",\"text\":\"...\"}'}"
echo
