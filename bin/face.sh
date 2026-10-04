#!/bin/bash
# face.sh -- put something on Janus's face. The visualizer's own stage,
# independent of barehands: no webcam, no hand tracker, nothing else running.
#
# Verbs match board.sh deliberately, so there is one vocabulary, not two:
#
#   face.sh '{"a":"present","title":"WHO OWES","body":"48 families ..."}'
#   face.sh '{"a":"add","title":"NOTE","body":"second card"}'
#   face.sh '{"a":"present","title":"RENDER","src":"shot.png"}'   # stage-media/
#   face.sh '{"a":"remove","id":"c123"}'
#   face.sh '{"a":"clear"}'
#
# present = center stage, enlarged, everything else dimmed.
# add     = another card alongside whatever is already up.
# Images must live in stage-media/ (the server serves nothing outside its
# own folder), or be a full http(s) URL.
#
# Press S on the face to hide/show the stage without clearing it.
set -euo pipefail
PORT="$(python -c "import json,pathlib;print(json.loads(pathlib.Path('$(dirname "$0")/../ai-visualizer.json').read_text()).get('port',8790))" 2>/dev/null || echo 8790)"
curl -fsS -X POST "http://127.0.0.1:${PORT}/stage" \
  -H "Content-Type: application/json" \
  -d "${1:?usage: face.sh '{\"a\":\"present\",\"title\":\"...\",\"body\":\"...\"}'}"
echo
