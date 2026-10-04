#!/bin/bash
# face-state.sh -- what is currently on Janus's face. Read-only.
# Run this before commenting on the stage; cards persist across restarts.
set -euo pipefail
PORT="$(python -c "import json,pathlib;print(json.loads(pathlib.Path('$(dirname "$0")/../ai-visualizer.json').read_text()).get('port',8790))" 2>/dev/null || echo 8790)"
curl -fsS "http://127.0.0.1:${PORT}/stage" | python -m json.tool
