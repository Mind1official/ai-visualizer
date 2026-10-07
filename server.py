#!/usr/bin/env python3
# ai-visualizer: give your AI agent a face.
# Copyright (C) 2026 Jared Rhodenizer
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
"""ai-visualizer server. Python standard library only, nothing to install.

Serves the face gallery at http://127.0.0.1:8790/ and exposes:

  /state   polled by the faces (~8x/sec):
           {"state":  "idle|listening|thinking|speaking",
            "level":  0.0-1.0,       voice loudness while speaking
            "samples": [64 floats],  raw waveform snapshot (0s when quiet)
            "alert":  bool,          optional attention signal
            "loading": bool}         true while the voice line plays its
                                     own thinking sound (we stay quiet)
  /context how full the agent's context window is, or {} when the
           voice line is not publishing it:
           {"used", "total", "free", "pct", "categories", "ts"}
  /config  the merged ai-visualizer.json plus the list of installed
           faces, discovered by scanning the faces/ folder. Drop a new
           folder with an index.html into faces/ and it appears in the
           gallery. That is the whole plugin system.

READ-ONLY on the signal bus. The bus is three tiny files written by a
voice line (backtalk writes them natively, github.com/jaredrhod/backtalk):

  .voice_state        idle | listening | thinking | speaking
  .voice_waveform     JSON {ts, samples: [64 floats]} while audio plays
  .voice_loading_pid  exists while the voice line plays a thinking sound
  .voice_alert        optional: non-empty file = attention needed
  .voice_context      optional: JSON context-window fill (show_context)

Where the bus lives comes from "bus_dir" in ai-visualizer.json (default:
this folder). Point it at your backtalk folder, or point backtalk's
"signals_dir" here. Either direction works.

Run:
  python3 server.py             the real bus
  python3 server.py --mock speaking
                                no voice line needed: /state synthesizes
                                the chosen state (idle|listening|thinking
                                |speaking) so you can see a face perform
  python3 server.py --no-open   do not auto-open the browser
Ctrl-C stops.
"""
import json
import math
import mimetypes
import subprocess
import sys
import threading
import time
import webbrowser
import urllib.request
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATES = {"idle", "listening", "thinking", "speaking"}
WAVEFORM_STALE_S = 0.6
# How long a .voice_compacting touch stays believable (see read_bus).
COMPACTING_STALE_S = 300

DEFAULTS = {
    "name": "JARVIS",       # shown on the chip / headers, yours to change
    "badge": "",            # optional handle shown in some faces' chrome
    "face": "board",        # the default face the root URL opens
    "port": 8790,
    "bus_dir": "",          # where the .voice_* files live ("" = here)
    "thinking_sound": True, # play assets/thinking.wav while thinking
    # OUR FORK: poll the Clip Desk for stream vitals (bitrate, dropped
    # frames) and hand them to the face. "" disables it entirely.
    "clip_desk": "http://127.0.0.1:8796",
    "vitals_poll_s": 5,
}


def load_config():
    cfg = dict(DEFAULTS)
    try:
        user = json.loads((HERE / "ai-visualizer.json").read_text())
        for k, v in user.items():
            cfg[k] = v
    except FileNotFoundError:
        pass
    except ValueError as e:
        print(f"[config] ai-visualizer.json is not valid JSON ({e}), "
              f"using defaults")
    return cfg


CFG = load_config()
BUS = Path(CFG["bus_dir"]).expanduser() if CFG.get("bus_dir") else HERE

MOCK = None
NO_OPEN = "--no-open" in sys.argv
if "--mock" in sys.argv:
    i = sys.argv.index("--mock")
    MOCK = sys.argv[i + 1] if len(sys.argv) > i + 1 else "speaking"
    if MOCK not in STATES and MOCK != "music":
        MOCK = "speaking"
PORT = int(CFG.get("port", 8790))
if "--port" in sys.argv:
    i = sys.argv.index("--port")
    PORT = int(sys.argv[i + 1])


def list_faces():
    faces = []
    fdir = HERE / "faces"
    if fdir.is_dir():
        for p in sorted(fdir.iterdir()):
            if p.is_dir() and (p / "index.html").exists():
                meta = {"id": p.name, "title": p.name.title(), "tagline": ""}
                try:
                    meta.update(json.loads((p / "face.json").read_text()))
                except (OSError, ValueError):
                    pass
                meta["id"] = p.name
                faces.append(meta)
    return faces


def mock_bus():
    t = time.time()
    level = 0.0
    samples = [0.0] * 64
    if MOCK == "speaking":
        level = abs(math.sin(t * 6.0)) * 0.85
        samples = [
            (math.sin(i * 0.55 + t * 9.0) * 0.6
             + math.sin(i * 1.7 - t * 13.0) * 0.4)
            * 9000.0 * (0.35 + 0.65 * abs(math.sin(t * 2.6)))
            for i in range(64)
        ]
    music = MOCK == "music"
    bands = []
    if music:
        # a fake 124 bpm kick plus drifting mids and hats, so the
        # visualizer can be looked at without playing anything
        kick = max(0.0, math.cos((t * 124 / 60 % 1) * math.pi)) ** 6
        bands = [min(1.0, max(0.0,
                     (kick * (1 - i / 10) if i < 10 else 0)
                     + 0.35 * abs(math.sin(t * 1.3 + i * 0.4)) * (1 - i / 48)
                     + (0.25 * abs(math.sin(t * 7 + i)) if i > 22 else 0)))
                 for i in range(32)]
    return {"state": "idle" if music else MOCK, "level": level,
            "samples": samples,
            # so the input box can be looked at without a voice line
            "prompt": "Type something and press Enter" if MOCK == "thinking" else "",
            "alert": False, "loading": MOCK == "thinking",
            "compacting": MOCK == "compacting",
            "music": music, "bands": bands,
            # Faked so the usage readout can be looked at without
            # spending a real session to make it appear.
            "rate_limits": {
                "five_hour": {"utilization": 0.34, "resets_at": t + 9200},
                "seven_day": {"utilization": 0.61, "resets_at": t + 288000},
            }}


MUSIC_STALE_S = 3

# --- stream vitals (our fork) -------------------------------------------
# Polled on a BACKGROUND THREAD, never inside read_bus(). read_bus runs on
# every /state request at 8 Hz; a blocking HTTP call in there would stall
# the whole face the moment the Clip Desk got slow or went away, which is
# precisely when a dashboard must not freeze.
#
# The cache is the only thing /state reads, and a reading older than
# VITALS_STALE_S is treated as absent -- so a dead poller shows NOTHING
# rather than a number frozen at whatever the stream was doing minutes
# ago. A stale vitals card is worse than no card, because it is believed.
VITALS_STALE_S = 25
_VITALS = {"ts": 0.0, "data": None}


def _vitals_poller():
    url = (CFG.get("clip_desk") or "").rstrip("/")
    if not url:
        return
    url += "/health"
    every = max(2, int(CFG.get("vitals_poll_s") or 5))
    quiet = False               # log a failure once, not every 5 seconds
    while True:
        try:
            with urllib.request.urlopen(url, timeout=4) as r:
                d = json.loads(r.read().decode("utf-8", "replace"))
            _VITALS["data"] = d
            _VITALS["ts"] = time.time()
            quiet = False
        except Exception as e:
            # Leave the last reading alone; staleness alone decides
            # whether the face still shows it.
            if not quiet:
                print(f"[vitals] Clip Desk not answering ({e}) -- will keep trying quietly")
                quiet = True
        time.sleep(every)


def read_vitals():
    """The cached vitals, or None if there is nothing trustworthy."""
    d = _VITALS["data"]
    if not d or time.time() - _VITALS["ts"] > VITALS_STALE_S:
        return None
    # Only worth putting on screen when OBS is actually streaming. An
    # "offline" or "unknown" verdict is not news; it is the normal state
    # for most of the day.
    if d.get("verdict") in (None, "offline", "unknown"):
        return None
    return {
        "verdict": d.get("verdict"),
        "summary": d.get("summary"),
        "kbps": d.get("bitrateKbps"),
        "fps": d.get("fps"),
        "cpu": d.get("cpuPct"),
        "congestion": d.get("congestionPct"),
        "encoderPct": (d.get("encoder") or {}).get("pct"),
        "renderPct": (d.get("render") or {}).get("pct"),
        "encoderNow": (d.get("encoder") or {}).get("lastSecond"),
        "renderNow": (d.get("render") or {}).get("lastSecond"),
        "uptimeSec": d.get("uptimeSec"),
    }


# --- chat watcher tally (our fork) --------------------------------------
# The chat watcher is a separate process (tools/chat-watcher.py); it drops
# its running token count in a small JSON file and we serve it beside the
# vitals. File, not an HTTP push: the watcher must never block on the face
# being up, and the face must never block on the watcher.
#
# Same staleness doctrine as the vitals -- a frozen counter is worse than
# no counter, because it is believed.
WATCHER_FILE = BUS / ".watcher_tally"
WATCHER_STALE_S = 40


def read_watcher():
    """The watcher's tally, or None when it is not running or not live."""
    try:
        d = json.loads(WATCHER_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    if time.time() - float(d.get("ts") or 0) > WATCHER_STALE_S:
        return None
    # The watcher only writes live=true while the channel is actually live,
    # and this card is for stream time only.
    if not d.get("live"):
        return None
    return {"replies": d.get("replies"), "calls": d.get("calls"),
            "tin": d.get("in"), "tout": d.get("out")}


# --- stack health (our fork) -------------------------------------------
# tools/health.py drops its verdict and a rolling history here on every run.
# File, not a push, for the same reason as the watcher tally: neither side
# may block on the other being up.
#
# The check runs every 15 minutes, so "stale" has to be generous -- but it
# still has to EXIST. A health panel frozen at OK is the worst object in this
# whole stack, because it is the one thing Mind would trust without looking.
# Two missed runs and the panel disappears instead of lying.
HEALTH_FILE = BUS / ".health"
HEALTH_STALE_S = 2400


def read_health():
    """The stack's health, or None when the check has stopped running."""
    try:
        d = json.loads(HEALTH_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    try:
        age = time.time() - float(d.get("ts") or 0)
    except (TypeError, ValueError):
        return None
    if age < 0 or age > HEALTH_STALE_S:
        return None
    hist = d.get("hist")
    return {"verdict": d.get("verdict") or "unknown",
            "up": d.get("up"), "total": d.get("total"),
            "idle": d.get("idle") or 0,
            "down": [n for n in (d.get("down") or []) if isinstance(n, str)],
            "age_s": int(age),
            "hist": [int(h) for h in hist if isinstance(h, (int, float))]
                    if isinstance(hist, list) else []}


def read_bus():
    if MOCK:
        return mock_bus()
    try:
        state = (BUS / ".voice_state").read_text().strip().lower()
        if state not in STATES:
            state = "idle"
    except OSError:
        state = "idle"
    level = 0.0
    samples = [0.0] * 64
    try:
        payload = json.loads((BUS / ".voice_waveform").read_text())
        age = time.time() - float(payload.get("ts", 0))
        raw = payload.get("samples") or []
        if raw and age < WAVEFORM_STALE_S:
            # A fresh waveform IS speech, whatever the state file says.
            state = "speaking"
            samples = [float(s) for s in raw[:64]]
            mean = sum(abs(s) for s in samples) / len(samples)
            level = min(1.0, mean / 3000.0)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        alert = (BUS / ".voice_alert").stat().st_size > 0
    except OSError:
        alert = False
    loading = (BUS / ".voice_loading_pid").exists()
    # Touched by the PreCompact hook and cleared at the next Stop. The
    # staleness bound is the real safety net: PreCompact has no "done"
    # event, so a session that dies mid-compaction would otherwise leave
    # every face animating a compaction that ended hours ago.
    compacting = False
    try:
        age = time.time() - float((BUS / ".voice_compacting").read_text())
        compacting = 0 <= age < COMPACTING_STALE_S
    except (OSError, ValueError):
        pass
    # Absent unless the voice line was told to publish it, which is the
    # normal case: it is the account holder's own spend and it stays off
    # until asked for. An empty dict simply means no readout.
    rate_limits = {}
    try:
        rate_limits = json.loads((BUS / ".voice_rate_limits").read_text())
    except (OSError, ValueError):
        pass
    # Music mode (backtalk music.py): {ts, on, bands}. Refreshed ~8x a
    # second while music plays, so a stale reading means the voice line
    # stopped publishing and the visualizer must come down.
    music, bands = False, []
    try:
        m = json.loads((BUS / ".voice_music").read_text())
        if m.get("on") and time.time() - float(m.get("ts", 0)) < MUSIC_STALE_S:
            music = True
            bands = [float(b) for b in (m.get("bands") or [])[:64]]
    except (OSError, ValueError, TypeError):
        pass
    # OUR FORK: non-empty .voice_prompt means the agent is waiting on a typed
    # answer, and its contents are the question. Absent or empty = no input
    # box at all, which is the normal case -- the face stays clean until there
    # is actually something to answer.
    prompt = ""
    try:
        prompt = (BUS / ".voice_prompt").read_text(encoding="utf-8").strip()[:200]
    except OSError:
        prompt = ""
    # OUR FORK: .voice_remote exists while a phone holds the floor. The face
    # shows a TAKE BACK THE LINE button on it, because that is the only
    # escape hatch left at the desk -- the local mic is paused for the whole
    # time a remote session is live.
    remote = (BUS / ".voice_remote").exists()
    return {"state": state, "level": level, "samples": samples,
            "alert": alert, "loading": loading, "rate_limits": rate_limits,
            "compacting": compacting, "music": music, "bands": bands,
            "prompt": prompt, "remote": remote, "vitals": read_vitals(),
            "watcher": read_watcher(), "health": read_health()}


# --- the stage (our fork) ----------------------------------------------------
# Cards shown ON THE FACE, deliberately independent of barehands. The board
# keeps its scene only in memory behind its own server, so mirroring it would
# mean the webcam and hand tracker had to be running just to read a note. The
# two serve different jobs: the board is for HANDLING things, the face is for
# SEEING them.
#
# Persisted as one small JSON file so it survives a server restart and can be
# written directly by the agent when that is simpler than an HTTP call.
STAGE_FILE = HERE / ".stage.json"
STAGE_MAX = 12          # more cards than this on one screen is noise
STAGE_MEDIA = HERE / "stage-media"


def read_stage():
    try:
        data = json.loads(STAGE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"cards": [], "focus": "", "ts": 0}
    cards = [c for c in (data.get("cards") or []) if isinstance(c, dict)]
    return {"cards": cards[:STAGE_MAX],
            "focus": str(data.get("focus") or ""),
            "ts": float(data.get("ts") or 0)}


def write_stage(stage):
    stage["ts"] = time.time()
    try:
        STAGE_FILE.write_text(json.dumps(stage, indent=1), encoding="utf-8")
    except OSError:
        pass
    return stage


def stage_action(body):
    """One action per call, mirroring the verbs board.sh already uses so the
    agent does not have to learn a second vocabulary.

      present   one thing center stage, everything else dimmed
      add       another card alongside whatever is up
      remove    drop one card by id
      clear     empty the stage

    Returns the new stage. An unknown action is an error rather than a silent
    no-op: a typo that quietly does nothing is the worst outcome here."""
    action = str(body.get("a") or body.get("action") or "").lower()
    stage = read_stage()
    if action == "clear":
        return write_stage({"cards": [], "focus": ""})
    if action == "remove":
        cid = str(body.get("id") or "")
        stage["cards"] = [c for c in stage["cards"] if c.get("id") != cid]
        if stage["focus"] == cid:
            stage["focus"] = ""
        return write_stage(stage)
    if action not in ("present", "add", "add_card"):
        raise ValueError(f"unknown action {action!r} "
                         f"(present, add, remove, clear)")
    card = {
        "id": str(body.get("id") or f"c{int(time.time() * 1000) % 10**9}"),
        "title": str(body.get("title") or "")[:160],
        "body": str(body.get("body") or "")[:6000],
        "src": str(body.get("src") or "")[:300],
        # A string the user needs on their clipboard -- a url, a token name, a
        # command. The face renders a COPY button for it; the card itself can
        # stay readable prose while the button carries the exact text.
        "copy": str(body.get("copy") or "")[:4000],
    }
    if not (card["title"] or card["body"] or card["src"] or card["copy"]):
        raise ValueError("a card needs a title, a body, a src or a copy")
    # Replace rather than duplicate when the same id comes back: re-presenting
    # a card is how you update it.
    stage["cards"] = [c for c in stage["cards"] if c.get("id") != card["id"]]
    stage["cards"].append(card)
    stage["cards"] = stage["cards"][-STAGE_MAX:]
    if action == "present":
        stage["focus"] = card["id"]
    return write_stage(stage)


# --- the panels (our fork) ---------------------------------------------------
# Two standing lists in the top-right of the face: what we are working on RIGHT
# NOW (often more than one thread) and the to-do list. Distinct from the stage
# on purpose -- the stage is transient and gets cleared, these persist and are
# meant to be glanced at.
#
# Separate file from the stage so clearing the stage can never take the lists
# with it, which would be the obvious accident.
PANELS_FILE = HERE / ".panels.json"
PANEL_KEYS = ("now", "todo")
PANEL_MAX = 12          # a glanceable list, not a backlog viewer


def read_panels():
    try:
        data = json.loads(PANELS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    out = {}
    for k in PANEL_KEYS:
        items = []
        for it in (data.get(k) or [])[:PANEL_MAX]:
            if isinstance(it, dict) and it.get("text"):
                items.append({"id": str(it.get("id") or ""),
                              "text": str(it["text"])[:200],
                              "done": bool(it.get("done"))})
        out[k] = items
    out["ts"] = float(data.get("ts") or 0)
    return out


def write_panels(panels):
    panels["ts"] = time.time()
    try:
        PANELS_FILE.write_text(json.dumps(panels, indent=1), encoding="utf-8")
    except OSError:
        pass
    return panels


def _new_id():
    return f"i{int(time.time() * 1000) % 10**9}"


def panels_action(body):
    """One action per call.

      set     replace a whole list from an array of strings (the common case:
              the lists are mirrored from Active Priorities, so rewriting is
              more honest than patching item by item)
      add     append one item
      done    toggle an item's struck-through state by id
      remove  drop an item by id
      clear   empty one list

    Which list is `p`: "now" or "todo". An unknown list or action is an error,
    never a silent no-op."""
    panel = str(body.get("p") or body.get("panel") or "").lower()
    if panel not in PANEL_KEYS:
        raise ValueError(f"unknown list {panel!r} (now, todo)")
    action = str(body.get("a") or body.get("action") or "").lower()
    panels = read_panels()
    items = panels[panel]

    if action == "clear":
        panels[panel] = []
    elif action == "set":
        raw = body.get("items")
        if not isinstance(raw, list):
            raise ValueError("set needs \"items\": [\"...\", \"...\"]")
        panels[panel] = [
            {"id": _new_id() + str(i), "text": str(t)[:200], "done": False}
            for i, t in enumerate(raw) if str(t).strip()
        ][:PANEL_MAX]
    elif action == "add":
        text = str(body.get("text") or "").strip()[:200]
        if not text:
            raise ValueError("add needs \"text\"")
        items.append({"id": _new_id(), "text": text, "done": False})
        panels[panel] = items[-PANEL_MAX:]
    elif action in ("done", "remove"):
        cid = str(body.get("id") or "")
        if action == "remove":
            panels[panel] = [i for i in items if i["id"] != cid]
        else:
            hit = False
            for i in items:
                if i["id"] == cid:
                    i["done"] = not i["done"]
                    hit = True
            if not hit:
                raise ValueError(f"no item with id {cid!r}")
            panels[panel] = items
    else:
        raise ValueError(f"unknown action {action!r} "
                         f"(set, add, done, remove, clear)")
    return write_panels(panels)


def read_context():
    """The context-window fill, or {} when nothing is publishing it.

    Polled far less often than /state by design: this only changes once
    per completed turn, so a face has no reason to ask 8x a second.

    A stale reading is kept rather than blanked. The numbers stay true
    until the next turn rewrites them, and a meter that holds its last
    honest value beats one that flickers to empty between turns."""
    if MOCK:
        total = 200000
        used = int(total * 0.42)
        return {"used": used, "total": total, "free": total - used,
                "pct": 0.42, "ts": time.time(),
                "categories": [{"name": "System prompt", "tokens": 3100},
                               {"name": "Tools", "tokens": 11800},
                               {"name": "Messages", "tokens": 69100},
                               {"name": "Free space", "tokens": 116000}]}
    try:
        return json.loads((BUS / ".voice_context").read_text())
    except (OSError, ValueError):
        return {}


def read_log(name, max_lines=60):
    # Written by Claude Code's hooks (log_bus.py), not the voice line --
    # so this is silent (empty list) rather than falling back to idle
    # the way read_bus() does, when nothing has logged yet.
    try:
        text = (BUS / name).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return text.splitlines()[-max_lines:]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/state":
                self._send(json.dumps(read_bus()).encode(),
                           "application/json")
            elif path == "/activity":
                self._send(json.dumps({"lines": read_log(".activity_log")}).encode(),
                           "application/json")
            elif path == "/transcript":
                self._send(json.dumps({"lines": read_log(".transcript_log")}).encode(),
                           "application/json")
            elif path == "/panels":
                self._send(json.dumps(read_panels()).encode(),
                           "application/json")
            elif path == "/stage":
                self._send(json.dumps(read_stage()).encode(),
                           "application/json")
            elif path == "/context":
                self._send(json.dumps(read_context()).encode(),
                           "application/json")
            elif path == "/config":
                out = {"name": CFG["name"], "badge": CFG["badge"],
                       "face": CFG["face"],
                       "thinking_sound": bool(CFG["thinking_sound"]),
                       "faces": list_faces()}
                self._send(json.dumps(out).encode(), "application/json")
            else:
                self._static(path)
        except ConnectionError:
            # THE WHOLE FAMILY, not one member of it. A tab closed or
            # reloaded mid-response raises ConnectionResetError, which is a
            # SIBLING of BrokenPipeError rather than a subclass -- so
            # catching only BrokenPipeError sent it to the generic branch
            # below, which then wrote a 500 back down the socket that had
            # just died and raised a SECOND, uncaught error from inside
            # flush_headers(). One disconnect, two tracebacks. ConnectionError
            # is the common parent of Reset, Broken, Aborted and Refused.
            pass
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            try:
                self._send(body, "application/json", 500)
            except ConnectionError:
                # A real error AND the client already gone. There is nobody
                # left to tell; saying so twice helps no one.
                pass

    # OUR FORK: the one write this server performs. Everything else here is
    # read-only on the bus by design, and that stays true of the .voice_*
    # files the faces READ -- .voice_typed is a separate inbound channel that
    # only ever travels browser -> voice line. backtalk consumes and truncates
    # it, so this end only ever appends.
    def do_POST(self):
        route = self.path.split("?")[0]
        if route == "/stage":
            self._post_json(stage_action, "stage")
            return
        if route == "/panels":
            self._post_json(panels_action, "panels")
            return
        if route != "/say":
            self._send(b"not found", "text/plain", 404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 8192:                 # a typed line, not a payload
                self._send(json.dumps({"ok": False, "error": "empty"}).encode(),
                           "application/json", 400)
                return
            body = json.loads(self.rfile.read(n).decode("utf-8", "replace"))
            text = " ".join(str(body.get("text") or "").split())[:2000]
            if not text:
                self._send(json.dumps({"ok": False, "error": "empty"}).encode(),
                           "application/json", 400)
                return
            # Append, never overwrite: two tabs open at once must not be able
            # to drop each other's line.
            with open(BUS / ".voice_typed", "a", encoding="utf-8") as f:
                f.write(text + chr(10))
            # Clearing the prompt here as well as in backtalk's reader is
            # belt-and-braces: the box vanishes on submit even if the voice
            # line is not running to consume the line.
            try:
                (BUS / ".voice_prompt").unlink()
            except OSError:
                pass
            self._send(json.dumps({"ok": True}).encode(), "application/json")
        except ConnectionError:
            pass
        except Exception as e:
            try:
                self._send(json.dumps({"ok": False, "error": str(e)}).encode(),
                           "application/json", 500)
            except ConnectionError:
                pass

    # One body for every JSON write route: the refusal and error shapes stay
    # identical across them, which is the whole reason to share it.
    def _post_json(self, fn, key):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 262144:
                self._send(json.dumps({"ok": False, "error": "empty"}).encode(),
                           "application/json", 400)
                return
            body = json.loads(self.rfile.read(n).decode("utf-8", "replace"))
            self._send(json.dumps({"ok": True, key: fn(body)}).encode(),
                       "application/json")
        except ConnectionError:
            pass
        except ValueError as e:
            try:
                self._send(json.dumps({"ok": False, "error": str(e)}).encode(),
                           "application/json", 400)
            except ConnectionError:
                pass
        except Exception as e:
            try:
                self._send(json.dumps({"ok": False, "error": str(e)}).encode(),
                           "application/json", 500)
            except ConnectionError:
                pass

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        target = (HERE / path.lstrip("/")).resolve()
        if target != HERE and HERE not in target.parents:
            self._send(b"not found", "text/plain", 404)
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self._send(b"not found", "text/plain", 404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or \
            "application/octet-stream"
        self._send(target.read_bytes(), ctype)

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


# On Windows, prefer the installed Chrome app (a windowed, chrome-less app
# view) over the system default browser, when Chrome is where we expect it.
# The app-id is bound to a URL in Chrome's own app registry (set when the
# app was installed); it's keyed to the Chrome profile, not this machine, so
# it travels across machines signed into the same profile.
CHROME_PROXY = Path(r"C:\Program Files\Google\Chrome\Application\chrome_proxy.exe")
CHROME_APP_ID = "pfhngcmbfeloekfgoeblabklkjhmadjp"
CHROME_PROFILE = "Profile 4"


def open_face(url):
    if sys.platform == "win32" and CHROME_PROXY.exists():
        subprocess.Popen([
            str(CHROME_PROXY),
            f"--profile-directory={CHROME_PROFILE}",
            f"--app-id={CHROME_APP_ID}",
        ])
    else:
        webbrowser.open(url)


if __name__ == "__main__":
    mode = f"MOCK={MOCK}" if MOCK else f"bus: {BUS}"
    root = f"http://127.0.0.1:{PORT}/"
    # The browser opens on the configured face; the gallery stays at "/" for switching.
    face = CFG.get("face", "")
    url = f"{root}faces/{face}/" if face and (HERE / "faces" / face / "index.html").exists() else root
    # ALREADY RUNNING IS NOT AN ERROR, and treating it as one was the whole
    # bug. Closing the browser tab does not stop this server; it keeps going
    # headless. Relaunching then failed to bind, died before the line that
    # opens the browser, and took the traceback with it when the launcher
    # window closed. The end-user symptom was "I can hear my agent but the
    # face never shows up", with the face running perfectly the entire time.
    try:
        if CFG.get("clip_desk"):
            threading.Thread(target=_vitals_poller, daemon=True).start()
        srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, errno.EACCES):
            raise
        # Something holds the port. Ask it whether it is us before claiming
        # anything: a stranger on this port is a different problem and
        # deserves a different sentence.
        mine = False
        try:
            with urllib.request.urlopen(root + "state", timeout=2) as r:
                mine = r.status == 200
        except Exception:
            mine = False
        if mine:
            print(f"already running at {root}  opening it instead", flush=True)
            if not NO_OPEN:
                open_face(url)
            sys.exit(0)
        print(f"port {PORT} is taken by something that is not this server.",
              flush=True)
        print("Close whatever is using it, or set a different \"port\" in "
              "ai-visualizer.json.", flush=True)
        sys.exit(1)
    srv.allow_reuse_address = True
    print(f"ai-visualizer on {root}  opening {url}  ({mode})  Ctrl-C stops", flush=True)
    if not NO_OPEN:
        threading.Timer(0.6, lambda: open_face(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
