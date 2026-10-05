/*
 * ai-visualizer: give your AI agent a face.
 * Copyright (C) 2026 Jared Rhodenizer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* ============================================================
   ai-visualizer core — the shared plumbing every face rides on.

   A face is one self-contained page in faces/<name>/index.html.
   It includes this script, calls AV.init(opts), then reads these
   fields every animation frame after calling AV.tick(dtMs):

     AV.state      "idle" | "listening" | "thinking" | "speaking"
     AV.level      0..1 raw voice loudness (speaking only)
     AV.env        0..1 smoothed speech envelope (attack/release eased,
                   adaptively normalized — use this for motion)
     AV.samples    Float32Array(64), 0..1 normalized waveform ring
     AV.alert      bool, optional attention signal
     AV.compacting bool, true while the context window is being compacted
     AV.micLevel   0..1 your microphone (only if init({mic:true}))
     AV.name       display name from config ("JARVIS" by default)
     AV.label      the dotted chip label ("J.A.R.V.I.S.")
     AV.badge      optional handle from config ("" by default)

   Modes:
     live   served by server.py — rides the real signal bus
     demo   ?demo=1, or the page opened as a plain file — a scripted
            voice-turn loop (idle, listening, thinking, speaking) with
            synthesized audio, so every face performs with no voice
            line installed
     shot   ?shot=<state>&t=ms — pins one state and runs the frame
            loop deterministically, then sets document.title to
            "ready" (screenshot/verification harness)

   The thinking sound: assets/thinking-hum.wav plays while the state is
   "thinking", exactly like a voice line would play it. If the bus
   says the voice line is already playing its own (.voice_loading_pid),
   this player stays quiet — you never hear it twice. The speaker
   button (bottom left) toggles it; browsers may require one click on
   the page before audio is allowed.
   ============================================================ */
"use strict";

const AV = (() => {
  const Q = new URLSearchParams(location.search);
  const SHOT = Q.get("shot");
  const SHOT_T = parseInt(Q.get("t") || "4000", 10);
  const DEMO = Q.get("demo") === "1" || location.protocol === "file:" || !!SHOT;

  // where core.js lives -> where assets/ lives (works over http and file://)
  const ROOT = new URL(".", document.currentScript.src);

  const A = {
    state: "idle", level: 0, env: 0, alert: false, micLevel: 0,
    samples: new Float32Array(64),
    name: "JARVIS", label: "J.A.R.V.I.S.", badge: "",
    demo: DEMO, shot: SHOT, faces: [],
    _sndOn: true, _mic: false, _readyCbs: [], _ready: false,
  };

  function dotted(name) {
    const up = String(name).toUpperCase();
    if (/^[A-Z0-9]{2,10}$/.test(up)) return up.split("").join(".") + ".";
    return up;
  }

  /* -------------------------------- config -------------------------------- */
  function applyConfig(cfg) {
    if (cfg.name) { A.name = String(cfg.name); A.label = dotted(A.name); }
    A.badge = String(cfg.badge || "");
    if (cfg.thinking_sound === false) A._sndWant = false;
    A.faces = cfg.faces || [];
    A._ready = true;
    A._readyCbs.forEach(cb => cb(A));
    A._readyCbs = [];
  }

  A.ready = cb => { A._ready ? cb(A) : A._readyCbs.push(cb); };

  /* ------------------------------ bus polling ------------------------------ */
  let raw = { state: "idle", level: 0, samples: null, alert: false,
              loading: false };
  if (!DEMO) {
    setInterval(async () => {
      try {
        const r = await fetch("/state", { cache: "no-store" });
        raw = await r.json();
      } catch (e) { /* server gone: hold last state */ }
    }, 120);
  }

  /* ------------------------------ demo driver ------------------------------ */
  // A scripted voice turn: the face performs everything with no voice line.
  const SCRIPT = [["idle", 6000], ["listening", 3500], ["thinking", 4200],
                  ["speaking", 8500]];
  let demoT = 0, demoClock = 0;
  const PIN = SHOT || Q.get("state");   // ?state=speaking pins the demo
  function demoUpdate(dt) {
    demoClock += dt;
    let st = PIN || "idle";
    if (!PIN) {
      demoT = (demoT + dt) % SCRIPT.reduce((a, s) => a + s[1], 0);
      let t = demoT;
      for (const [name, len] of SCRIPT) {
        if (t < len) { st = name; break; }
        t -= len;
      }
    }
    const tt = demoClock / 1000;
    const speaking = st === "speaking";
    const cadence = speaking
      ? Math.max(0, Math.sin(tt * 2.1) * 0.6 + Math.sin(tt * 0.9) * 0.5)
      : 0;
    const samples = new Array(64);
    for (let i = 0; i < 64; i++) {
      // drifting per-sample color so the synthetic voice has a moving
      // spectrum, not a steady tone — spectrum-driven faces dance
      const m = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.23 + tt * 1.7))
        * Math.abs(Math.sin(tt * 2.9 + i * 0.05));
      samples[i] = speaking
        ? (Math.sin(i * 0.55 + tt * 9) * 0.6 + Math.sin(i * 1.7 - tt * 13)
           * 0.4) * 9000 * (0.15 + 0.85 * cadence) * m
        : 0;
    }
    raw = { state: st, level: speaking ? Math.min(1, cadence) : 0,
            samples, alert: false, loading: false };
    if (st === "listening")
      A.micLevel = 0.25 + 0.55 * Math.abs(Math.sin(tt * 2.7))
        * Math.abs(Math.sin(tt * 0.61));
  }

  /* ----------------------- envelope + samples easing ----------------------- */
  let peak = 0.05, sPeak = 200;
  function tick(dt) {
    if (DEMO) demoUpdate(dt);
    A.state = raw.state || "idle";
    A.alert = !!raw.alert;
    // True while Claude Code folds the context down (PreCompact hook).
    // A face that wants to show it reads AV.compacting; the rest ignore it.
    A.compacting = !!raw.compacting;
    A.music = !!raw.music;
    A.bands = raw.bands || [];
    // Empty unless the voice line was told to publish usage. A face that
    // wants to draw it reads AV.rateLimits; every other face ignores it.
    A.rateLimits = raw.rate_limits || {};
    A.level = raw.level || 0;
    // OUR FORK: non-empty = the agent is waiting on a typed answer, and the
    // string is the question. promptUpdate() owns the input box; a face can
    // also read AV.prompt if it wants to react in its own visuals.
    A.prompt = raw.prompt || "";
    promptUpdate();
    A.remote = !!raw.remote;
    reclaimUpdate();

    // adaptive envelope: normalize against a decaying peak, then ease
    // (attack 50ms, release 350ms) — motion code rides AV.env
    const dts = dt / 1000;
    peak = Math.max(A.level, 0.05, peak - 0.5 * peak * dts);
    const target = Math.min(1, A.level / peak);
    const tau = target > A.env ? 50 : 350;
    A.env += (target - A.env) * Math.min(1, dt / tau);

    // waveform ring: rectify, normalize against its own decaying peak,
    // blend toward the newest frame so the ring flows instead of flickers
    const s = raw.samples;
    A.rawSamples = s && s.length ? s : null;   // signed, int16-scale floats
    if (s && s.length) {
      let mx = 0;
      for (let i = 0; i < s.length; i++) mx = Math.max(mx, Math.abs(s[i]));
      sPeak = Math.max(mx, 200, sPeak * 0.98);
      const n = s.length;
      for (let i = 0; i < 64; i++) {
        const v = Math.abs(s[Math.min(n - 1, Math.round(i * (n - 1) / 63))])
          / sPeak;
        A.samples[i] = A.samples[i] * 0.45 + Math.min(1, v) * 0.55;
      }
    } else {
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);
    }
    if (A.state !== "speaking" && !DEMO)
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);

    if (A._mic && A._micAnalyser) micRead();
    soundUpdate();
  }

  /* --------------------------------- mic ---------------------------------- */
  let micPeak = 0.02;
  function micRead() {
    const an = A._micAnalyser;
    const buf = A._micBuf;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    micPeak = Math.max(rms, 0.02, micPeak * 0.999);
    A.micLevel = Math.min(1, rms / micPeak);
  }
  async function micStart() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      A._micAnalyser = an;
      A._micBuf = new Float32Array(an.fftSize);
      const kick = () => ctx.state === "suspended" && ctx.resume();
      addEventListener("click", kick); addEventListener("keydown", kick);
    } catch (e) { /* no mic permission: level stays 0, faces degrade */ }
  }

  /* ----------------------------- thinking sound ---------------------------- */
  let audio = null, sndBtn = null, playing = false;
  A._sndWant = true;
  function soundInit() {
    if (SHOT) return;
    try { A._sndOn = localStorage.getItem("av_sound") !== "0"; }
    catch (e) { A._sndOn = true; }
    audio = new Audio(new URL("assets/thinking-hum.wav", ROOT).href);
    audio.volume = 0.35;
    sndBtn = document.createElement("div");
    // hidden until the mouse moves, so it never collides with a face's
    // chrome and never shows on camera or in an OBS source
    sndBtn.style.cssText =
      // bottom offset reads --av-bottom-inset, which a face sets when it
      // parks a panel along the bottom edge (the radial face's transcript
      // window was covering this button entirely). Unset = plain 14px.
      "position:fixed;left:64px;z-index:50;cursor:pointer;" +
      "bottom:calc(14px + var(--av-bottom-inset, 0px));" +
      "font:12px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.2em;" +
      "color:#5a6a72;opacity:0;transition:opacity .4s;user-select:none;" +
      "pointer-events:none";
    sndBtn.title = "thinking sound on/off";
    let hideT = null;
    addEventListener("mousemove", () => {
      sndBtn.style.opacity = ".65";
      sndBtn.style.pointerEvents = "auto";
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        sndBtn.style.opacity = "0";
        sndBtn.style.pointerEvents = "none";
      }, 3000);
    });
    sndBtn.onclick = () => {
      A._sndOn = !A._sndOn;
      try { localStorage.setItem("av_sound", A._sndOn ? "1" : "0"); }
      catch (e) {}
      if (!A._sndOn) stopSound();
      paintBtn();
    };
    paintBtn();
    document.body.appendChild(sndBtn);
  }
  function paintBtn() {
    if (sndBtn) sndBtn.textContent = A._sndOn ? "SND ON" : "SND OFF";
  }
  function stopSound() {
    if (audio && playing) { audio.pause(); audio.currentTime = 0; }
    playing = false;
  }
  function soundUpdate() {
    if (!audio || !A._sndWant) return;
    const want = A._sndOn && A.state === "thinking" && !raw.loading;
    if (want && !playing) {
      playing = true;
      audio.currentTime = 0;
      audio.play().catch(() => { playing = false; });
    } else if (!want && playing) {
      stopSound();
    }
  }


  /* ------------------------- typed input (our fork) ------------------------ */
  // An input box that exists only while the agent is actually asking for
  // something. No persistent chat bar: the faces are a performance surface,
  // and a text field parked on screen forever would show on stream and in
  // every OBS source for the 99% of the time nothing is being asked.
  //
  // The box is built on first need rather than at init, so a face that never
  // sees a prompt never gets the DOM at all.
  let promptBox = null, promptLabel = null, promptInput = null;
  let promptShown = "", promptSending = false;

  function promptBuild() {
    promptBox = document.createElement("div");
    promptBox.style.cssText =
      "position:fixed;left:50%;bottom:calc(72px + var(--av-bottom-inset,0px));" +
      "transform:translateX(-50%) translateY(14px);z-index:60;" +
      "min-width:min(620px,86vw);max-width:86vw;padding:14px 16px 12px;" +
      "background:rgba(8,10,12,.92);border:1px solid rgba(182,2,50,.55);" +
      "border-radius:10px;box-shadow:0 0 42px rgba(182,2,50,.28);" +
      "backdrop-filter:blur(6px);opacity:0;pointer-events:none;" +
      "transition:opacity .25s,transform .25s";

    promptLabel = document.createElement("div");
    promptLabel.style.cssText =
      "font:12px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.18em;" +
      "text-transform:uppercase;color:#b60232;margin-bottom:9px;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    promptBox.appendChild(promptLabel);

    promptInput = document.createElement("input");
    promptInput.type = "text";
    promptInput.autocomplete = "off";
    promptInput.spellcheck = false;
    promptInput.style.cssText =
      "width:100%;box-sizing:border-box;background:transparent;border:0;" +
      "border-bottom:1px solid rgba(182,2,50,.35);outline:none;" +
      "color:#e8eef0;font:17px 'SF Mono',Menlo,Consolas,monospace;" +
      "padding:4px 2px 7px";
    promptInput.addEventListener("keydown", e => {
      // Stop every key reaching the page: the faces bind single letters
      // (F for fullscreen, Space for the board flythrough), so typing a
      // sentence into an unguarded field would fire them mid-word.
      e.stopPropagation();
      if (e.key === "Enter") promptSend();
      else if (e.key === "Escape") promptHide();
    });
    promptBox.appendChild(promptInput);

    const hint = document.createElement("div");
    hint.style.cssText =
      "margin-top:8px;font:10px 'SF Mono',Menlo,Consolas,monospace;" +
      "letter-spacing:.16em;color:#5a6a72";
    hint.textContent = "ENTER TO SEND   ESC TO DISMISS";
    promptBox.appendChild(hint);

    document.body.appendChild(promptBox);
  }

  function promptHide() {
    promptShown = "";
    if (!promptBox) return;
    promptBox.style.opacity = "0";
    promptBox.style.pointerEvents = "none";
    promptBox.style.transform = "translateX(-50%) translateY(14px)";
    promptInput.blur();
  }

  async function promptSend() {
    const text = promptInput.value.trim();
    if (!text || promptSending) return;
    promptSending = true;
    const prev = promptInput.value;
    promptInput.value = "";
    try {
      const r = await fetch("/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error("rejected");
      promptHide();
    } catch (e) {
      // Put it back rather than swallow it. Losing a typed sentence to a
      // dropped request is the one failure here that actually costs the
      // person something.
      promptInput.value = prev;
      promptLabel.textContent = "COULD NOT SEND -- PRESS ENTER TO RETRY";
    } finally {
      promptSending = false;
    }
  }

  function promptUpdate() {
    const want = A.prompt || "";
    if (!want) { if (promptShown) promptHide(); return; }
    if (want === promptShown) return;
    if (!promptBox) promptBuild();
    promptShown = want;
    promptLabel.textContent = want;
    promptBox.style.opacity = "1";
    promptBox.style.pointerEvents = "auto";
    promptBox.style.transform = "translateX(-50%) translateY(0)";
    // Focus is the point: the person should be able to just type. Deferred a
    // frame because an element that was display-none a moment ago cannot
    // take focus reliably in Chrome.
    requestAnimationFrame(() => promptInput.focus());
  }

  // A face can raise its own prompt (used by the shot harness and anything
  // that wants to ask a question without going through the voice line).
  A.ask = (question) => { A.prompt = String(question || ""); promptUpdate(); };


  /* ------------------- take back the line (our fork) ---------------------- */
  // While a phone holds the voice line, the PC's open mic is paused -- so if
  // the remote end gets stuck (a closed window, a lost login) there is no way
  // to speak at the desk and ask for the line back. This button is that way
  // out, and it only exists while a remote session is actually live, so it
  // never shows on stream the rest of the time.
  //
  // It sends a phrase down /say, the same path as the typed box, rather than
  // inventing a second control channel: the voice console already owns what
  // "take back the line" means, and one place deciding is the whole point.
  let reclaimBtn = null, reclaimBusy = false;

  function reclaimBuild() {
    reclaimBtn = document.createElement("button");
    reclaimBtn.textContent = "TAKE BACK THE LINE";
    reclaimBtn.style.cssText =
      "position:fixed;left:50%;bottom:calc(20px + var(--av-bottom-inset,0px));" +
      "transform:translateX(-50%);z-index:61;cursor:pointer;" +
      "padding:11px 20px;background:rgba(8,10,12,.92);" +
      "border:1px solid rgba(182,2,50,.75);border-radius:999px;" +
      "box-shadow:0 0 34px rgba(182,2,50,.3);backdrop-filter:blur(6px);" +
      "color:#e8eef0;font:12px 'SF Mono',Menlo,Consolas,monospace;" +
      "letter-spacing:.18em;opacity:0;pointer-events:none;" +
      "transition:opacity .25s";
    reclaimBtn.addEventListener("click", reclaimSend);
    // The faces bind single letters, and a focused button would swallow a
    // Space or fire again on Enter. Click only.
    reclaimBtn.addEventListener("keydown", e => e.preventDefault());
    document.body.appendChild(reclaimBtn);
  }

  async function reclaimSend() {
    if (reclaimBusy) return;
    reclaimBusy = true;
    reclaimBtn.textContent = "TAKING IT BACK...";
    try {
      const r = await fetch("/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "take back the line" }),
      });
      if (!r.ok) throw new Error("rejected");
      // Do NOT hide it here. The button is driven by .voice_remote, so it
      // disappears when the session has ACTUALLY ended -- saying so before
      // it is true is exactly the lie worth avoiding on an escape hatch.
      reclaimBtn.textContent = "SENT";
    } catch (e) {
      reclaimBtn.textContent = "COULD NOT SEND -- TAP AGAIN";
    } finally {
      reclaimBusy = false;
      setTimeout(() => {
        if (!reclaimBusy) reclaimBtn.textContent = "TAKE BACK THE LINE";
      }, 2500);
    }
  }

  function reclaimUpdate() {
    if (!A.remote) {
      if (reclaimBtn) {
        reclaimBtn.style.opacity = "0";
        reclaimBtn.style.pointerEvents = "none";
      }
      return;
    }
    if (!reclaimBtn) reclaimBuild();
    reclaimBtn.style.opacity = "1";
    reclaimBtn.style.pointerEvents = "auto";
  }


  /* --------------------------- the stage (our fork) ------------------------ */
  // Cards shown on the face. DOM rather than canvas on purpose: text wrapping,
  // long bodies, scrolling and images all come free, and no face has to change
  // its draw loop to gain this. Independent of barehands by design -- the board
  // is for HANDLING things, the face is for SEEING them.
  //
  // Polled once a second, not 8x: a card appearing is a human-scale event, and
  // the face's frame budget belongs to the animation.
  let stageWrap = null, stageSig = "", stageHidden = false;

  function stageBuild() {
    stageWrap = document.createElement("div");
    stageWrap.style.cssText =
      "position:fixed;inset:0;z-index:55;pointer-events:none;" +
      "display:flex;flex-wrap:wrap;align-content:center;justify-content:center;" +
      "gap:18px;padding:6vh 5vw";
    document.body.appendChild(stageWrap);
    // One key to get the face back without clearing the stage: a presented
    // card can cover a lot of the animation, and wanting to look at the face
    // is not the same as being done with what is on it.
    addEventListener("keydown", e => {
      // Ignore both while typing an answer, or "clear the stage" typed into
      // the input box would wipe the screen a letter at a time.
      if (promptShown) return;
      if (e.key === "s" || e.key === "S") {
        stageHidden = !stageHidden;
        stageWrap.style.display = stageHidden ? "none" : "flex";
      } else if (e.key === "c" || e.key === "C") {
        // Clears the STAGE only. The standing lists are a separate route and
        // a separate file precisely so this key cannot take them with it.
        stageHidden = false;
        stageWrap.style.display = "flex";
        fetch("/stage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ a: "clear" }),
        }).catch(() => {});
      }
    });
  }

  // NOTHING ON THE FACE IS EVER DIMMED. Dimming is a focus cue borrowed from
  // the barehands board, where the user can reach out and grab a card to
  // bring it forward. The face has no hands: a dimmed card there is just
  // permanently unreadable, with no way back. (Mind, 2026-10-04.)
  //
  // So `present` still means "first and biggest", but every card stays at
  // full opacity, and a set of them is sized to fit the screen without
  // scrolling -- half-dimmed and half off-screen is worse than not showing
  // it at all.
  function stageCard(c, focused, peers, ts) {
    const el = document.createElement("div");
    el.style.cssText =
      "pointer-events:auto;box-sizing:border-box;" +
      "background:rgba(8,10,12,.93);border:1px solid rgba(182,2,50,.5);" +
      "border-radius:12px;backdrop-filter:blur(6px);" +
      "max-height:80vh;overflow:" + (peers > 1 ? "hidden" : "auto") + ";" +
      "width:" + (peers > 1 ? "min(900px," + (86 / peers).toFixed(1) + "vw)"
                            : "min(900px,78vw)") + ";" +
      "padding:22px 26px;" +
      "box-shadow:0 0 " + (focused ? "60px rgba(182,2,50,.34)"
                                   : "26px rgba(182,2,50,.16)") + ";" +
      "opacity:1";

    if (c.title) {
      const h = document.createElement("div");
      h.style.cssText =
        "font:600 20px" +
        " 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.12em;" +
        "text-transform:uppercase;color:#b60232;margin-bottom:10px";
      h.textContent = c.title;
      el.appendChild(h);
    }
    if (c.src) {
      const img = document.createElement("img");
      // Served from the visualizer's own folder, same as every other asset:
      // the server refuses anything outside it, so a stray path cannot be
      // used to read the rest of the disk.
      //
      // Resolved against ROOT, not the page. A face lives at
      // faces/<name>/index.html, so a bare relative path looked for the
      // image inside THAT folder and every image card rendered as
      // "[ missing ]" while the server was serving the file perfectly.
      //
      // ?v=<stage timestamp> so RESTAGING THE SAME FILENAME actually
      // refetches. Regenerating a card and putting it up again under the
      // same name showed the browser's cached copy forever, which looks
      // exactly like the render failing. (Mind caught it, 2026-10-04.)
      img.src = c.src.startsWith("http") ? c.src
                                         : new URL("stage-media/" + c.src, ROOT).href
                                           + "?v=" + (ts || 0);
      img.style.cssText =
        "display:block;width:100%;height:auto;border-radius:8px;" +
        // Fit the card, never overflow it: a 9:16 story card is taller than
        // the screen at full width.
        "max-height:" + (peers > 1 ? "62vh" : "70vh") +
        ";object-fit:contain;" +
        (c.body || c.title ? "margin-bottom:12px" : "");
      img.onerror = () => {
        img.replaceWith(Object.assign(document.createElement("div"), {
          textContent: "[ missing: " + c.src + " ]",
          style: "font:12px 'SF Mono',monospace;color:#8a3",
        }));
      };
      el.appendChild(img);
    }
    if (c.body) {
      const b = document.createElement("div");
      b.style.cssText =
        "white-space:pre-wrap;color:#dfe7ea;" +
        "font:" + (focused ? "15px/1.62" : "12px/1.55") +
        " 'SF Mono',Menlo,Consolas,monospace";
      b.textContent = c.body;
      el.appendChild(b);
    }
    return el;
  }

  function stageRender(stage) {
    const cards = stage.cards || [];
    const focus = stage.focus || "";
    // Signature so an unchanged stage costs nothing: rebuilding the DOM every
    // second would reset the scroll position of anything being read.
    // ts is in the signature: a restage of identical cards still bumps it,
    // which is the only way a re-rendered image under the same filename gets
    // picked up.
    const sig = JSON.stringify([cards, focus, stage.ts]);
    if (sig === stageSig) return;
    stageSig = sig;
    if (!stageWrap) stageBuild();
    stageWrap.textContent = "";
    if (!cards.length) return;
    const hasFocus = !!focus && cards.some(c => c.id === focus);
    // The focused card comes first and sets the order; none are dimmed.
    const ordered = hasFocus
      ? [cards.find(c => c.id === focus),
         ...cards.filter(c => c.id !== focus)]
      : cards;
    for (const c of ordered) {
      const focused = hasFocus && c.id === focus;
      stageWrap.appendChild(stageCard(c, focused, ordered.length,
                                     stage.ts));
    }
    A.stage = stage;
  }

  if (!DEMO) {
    const pollStage = async () => {
      try {
        const r = await fetch("/stage", { cache: "no-store" });
        stageRender(await r.json());
      } catch (e) { /* server gone: leave what is on screen */ }
    };
    pollStage();
    setInterval(pollStage, 1000);
  }


  /* ------------------------- the panels (our fork) ------------------------- */
  // Two standing lists in the top-right: what is being worked on RIGHT NOW
  // (often more than one thread) and the to-do list. Unlike the stage these
  // are meant to persist and be glanced at, so they are never auto-cleared.
  //
  // Top offset reads --av-top-inset, the mirror of the --av-bottom-inset
  // convention a face already sets: the radial face runs a full-width activity
  // strip along the top edge, and without this the lists would sit under it.
  let panelWrap = null, panelSig = "", panelsHidden = false;

  const PANEL_TITLES = { now: "WORKING ON NOW", todo: "TO DO" };

  function panelsBuild() {
    panelWrap = document.createElement("div");
    panelWrap.style.cssText =
      "position:fixed;right:18px;z-index:54;pointer-events:none;" +
      "top:calc(14px + var(--av-top-inset,0px));" +
      "width:min(300px,34vw);display:flex;flex-direction:column;gap:12px";
    document.body.appendChild(panelWrap);
    addEventListener("keydown", e => {
      if (e.key === "l" || e.key === "L") {
        panelsHidden = !panelsHidden;
        panelWrap.style.display = panelsHidden ? "none" : "flex";
      }
    });
  }

  function panelCard(key, items) {
    const el = document.createElement("div");
    el.style.cssText =
      "box-sizing:border-box;padding:10px 13px 11px;border-radius:10px;" +
      "background:linear-gradient(160deg,rgba(26,4,11,.96),rgba(9,4,6,.94));" +
      "border:1px solid rgba(182,2,50,.55);" +
      "box-shadow:0 0 22px rgba(182,2,50,.22)," +
      "inset 0 0 18px rgba(182,2,50,.10);backdrop-filter:blur(3px)";

    const h = document.createElement("div");
    h.style.cssText =
      "font:10px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.2em;" +
      "color:#b60232;margin-bottom:8px;display:flex;justify-content:space-between";
    const open = items.filter(i => !i.done).length;
    h.innerHTML = "";
    h.appendChild(Object.assign(document.createElement("span"),
      { textContent: PANEL_TITLES[key] || key.toUpperCase() }));
    // The count is the open items, not the total: a list of ten with nine
    // ticked off should read as one thing left, not ten.
    h.appendChild(Object.assign(document.createElement("span"),
      { textContent: String(open), style: "opacity:.6" }));
    el.appendChild(h);

    for (const it of items) {
      const row = document.createElement("div");
      row.style.cssText =
        "font:11.5px/1.5 'SF Mono',Menlo,Consolas,monospace;" +
        "display:flex;gap:7px;align-items:baseline;" +
        "padding:2px 0;color:" + (it.done ? "#6c7a80" : "rgb(255,190,205)") +
        ";" + (it.done ? "text-decoration:line-through;opacity:.75" : "");
      row.appendChild(Object.assign(document.createElement("span"), {
        textContent: it.done ? "\u2713" : "\u203a",
        style: "color:#b60232;flex:0 0 auto",
      }));
      row.appendChild(Object.assign(document.createElement("span"), {
        textContent: it.text,
        style: "white-space:pre-wrap;word-break:break-word",
      }));
      el.appendChild(row);
    }
    return el;
  }

  function panelsRender(data) {
    // Signature guard, same reason as the stage: rebuilding every poll would
    // fight anything the person is mid-scroll on.
    const sig = JSON.stringify([data.now || [], data.todo || []]);
    if (sig === panelSig) return;
    panelSig = sig;
    if (!panelWrap) panelsBuild();
    panelWrap.textContent = "";
    for (const key of ["now", "todo"]) {
      const items = data[key] || [];
      if (!items.length) continue;      // an empty list draws nothing at all
      panelWrap.appendChild(panelCard(key, items));
    }
    A.panels = data;
  }

  if (!DEMO) {
    const pollPanels = async () => {
      try {
        const r = await fetch("/panels", { cache: "no-store" });
        panelsRender(await r.json());
      } catch (e) { /* server gone: leave what is on screen */ }
    };
    pollPanels();
    setInterval(pollPanels, 1500);
  }

  /* ------------------------------ shot harness ----------------------------- */
  // Runs the face's frame() deterministically (a synchronous burst of t ms).
  // A headless browser resizes the window and finishes loading images AFTER
  // the first burst, so the burst re-runs on resize and on two late timers
  // (the last one flags "ready"), then keeps painting at frame pace so the
  // late capture always sees a fresh composite.
  A.shotRun = (frame) => {
    const burst = () => { for (let t = 0; t < SHOT_T; t += 16.6) frame(16.6); };
    burst();
    addEventListener("resize", burst);
    setTimeout(burst, 450);
    setTimeout(burst, 900);
    setTimeout(() => { burst(); document.title = "ready"; }, 3000);
    // fat 100ms steps: assets that finish loading after the last burst
    // still reach their steady state within a few paints
    const loop = () => { frame(100); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  };

  /* ---------------------------------- init --------------------------------- */
  A.init = (opts = {}) => {
    A._mic = !!opts.mic;
    if (A._mic && !DEMO) micStart();
    if (opts.sound !== false) soundInit(); else A._sndWant = false;
    if (DEMO) {
      applyConfig({ name: Q.get("name") || "JARVIS" });
    } else {
      fetch("/config", { cache: "no-store" })
        .then(r => r.json()).then(applyConfig)
        .catch(() => applyConfig({}));
    }
    return A;
  };

  A.tick = tick;

  /* ----------------------------- render helpers ---------------------------- */
  const U = {};
  U.dim = (c, f) => {
    f = Math.max(0, Math.min(1, f));
    return `rgb(${c[0] * f | 0},${c[1] * f | 0},${c[2] * f | 0})`;
  };
  U.rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // How long until a usage window resets, in the shortest honest unit.
  U.relTime = (ep) => {
    const d = ep - Date.now() / 1000;
    if (!(d > 0)) return "";
    if (d < 3600) return Math.round(d / 60) + "m";
    if (d < 86400) return Math.round(d / 3600) + "h";
    return Math.round(d / 86400) + "d";
  };

  // The plan-usage windows, formatted ONCE for every face that draws them.
  // Lives here rather than in each face because four copies of one format
  // drift apart silently, and the first symptom is two faces disagreeing
  // about the same number.
  //
  // Returns [] when the voice line publishes no usage, so a face can call
  // it unconditionally and simply draw nothing when there is nothing to say.
  // A window that is KNOWN but has no percentage yet still returns a row:
  // hiding it entirely was the original bug, and a row that says "no number
  // yet" is information where a missing row is just confusing.
  U.usageRows = () => {
    const rl = A.rateLimits || {};
    const out = [];
    for (const [label, w] of [["5H", rl.five_hour], ["7D", rl.seven_day]]) {
      if (!w) continue;
      const known = w.utilization != null;
      const pct = known ? Math.round(w.utilization * 100) : null;
      const rel = w.resets_at ? U.relTime(w.resets_at) : "";
      out.push({
        label, pct, known,
        hot: known && pct >= 80,
        text: (known ? pct + "%" : "\u2014") + (rel ? "  " + rel : "")
      });
    }
    return out;
  };
  U.mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t | 0,
                          c1[1] + (c2[1] - c1[1]) * t | 0,
                          c1[2] + (c2[2] - c1[2]) * t | 0];
  // soft additive glow sprite (canvas), cached by the caller
  U.makeGlow = (rgb, size) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(size / 2, size / 2, 0,
                                       size / 2, size / 2, size / 2);
    grd.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
    grd.addColorStop(.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.55)`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  };
  // the one-field bloom rule: draw everything luminous into one field
  // canvas, bloom the WHOLE field (two downscale taps), composite
  // additively — bloom applied per-element reads as pencil lines
  U.bloomBlit = (dst, field, w, h) => {
    if (!field._b4 || field._b4.width !== w >> 2) {
      field._b4 = document.createElement("canvas");
      field._b4.width = Math.max(1, w >> 2);
      field._b4.height = Math.max(1, h >> 2);
      field._b8 = document.createElement("canvas");
      field._b8.width = Math.max(1, w >> 3);
      field._b8.height = Math.max(1, h >> 3);
    }
    const g4 = field._b4.getContext("2d"), g8 = field._b8.getContext("2d");
    g4.clearRect(0, 0, field._b4.width, field._b4.height);
    g4.drawImage(field, 0, 0, field._b4.width, field._b4.height);
    g8.clearRect(0, 0, field._b8.width, field._b8.height);
    g8.drawImage(field, 0, 0, field._b8.width, field._b8.height);
    const prev = dst.globalCompositeOperation;
    dst.globalCompositeOperation = "lighter";
    dst.drawImage(field, 0, 0);
    dst.drawImage(field._b4, 0, 0, w, h);
    dst.drawImage(field._b8, 0, 0, w, h);
    dst.globalCompositeOperation = prev;
  };
  // text that resolves out of glyph noise, left to right
  U.Descrambler = class {
    constructor(text, perChar = 50, hold = null) {
      this.text = text; this.per = perChar; this.hold = hold;
      this.t = 0; this.done = false;
      this.chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";
    }
    render(dt) {
      this.t += dt;
      const n = this.t / this.per | 0;
      let out = "";
      for (let i = 0; i < this.text.length; i++) {
        const ch = this.text[i];
        out += (i < n || ch === " ") ? ch
          : this.chars[Math.random() * this.chars.length | 0];
      }
      if (this.hold != null && this.t > this.per * this.text.length + this.hold)
        this.done = true;
      return out;
    }
  };
  A.util = U;

  return A;
})();
