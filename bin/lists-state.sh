#!/bin/bash
# lists-state.sh -- read the two standing lists, with their item ids (which
# you need for done/remove). Read-only.
set -euo pipefail
PORT="$(python -c "import json,pathlib;print(json.loads(pathlib.Path('$(dirname "$0")/../ai-visualizer.json').read_text()).get('port',8790))" 2>/dev/null || echo 8790)"
curl -fsS "http://127.0.0.1:${PORT}/panels" | python -m json.tool
