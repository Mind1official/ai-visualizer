/* THE HUD AROUND A FACE -- shared. See hud.css for why this exists.
 *
 * Lifted from the Radial face. It is a dumb reader: every panel polls a
 * file that server.py serves, holds no state of its own, and hides
 * itself when the signal behind it is absent -- so a face with no voice
 * line looks deliberate rather than broken.
 *
 * It expects the markup listed in hud.css, and it publishes the top and
 * bottom insets that core.js uses to park the NOW / TO DO cards clear of
 * the strip and the transcript.
 */

function chromeInset(){
  const p=document.getElementById("transcript-panel");
  return p?p.offsetHeight+10:0;
}

function topInset(){
  const p=document.getElementById("activity-panel");
  return p?p.offsetHeight:0;
}

/* ---------------- activity + transcript panels ----------------
   Top: a live readout of what Janus is doing (one line per tool call,
   from a Claude Code PreToolUse hook). Bottom: the conversation itself
   (UserPromptSubmit + Stop hooks). Both are plain log tails served by
   server.py from files the hooks append to -- polled, not pushed, so
   this stays a dumb reader with no state of its own. */
const esc=s=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;");
const activityPanel=document.getElementById("activity-panel");
const transcriptPanel=document.getElementById("transcript-panel");
let actTs=0,actText="";
function fmtElapsed(ms){
  const s=Math.max(0,Math.floor(ms/1000));
  const m=Math.floor(s/60),r=s%60;
  return m>0?`${m}:${String(r).padStart(2,"0")}`:`${r}s`;
}
function renderActivity(){
  if(!actText){activityPanel.innerHTML="";return}
  const t=fmtElapsed(Date.now()-actTs);
  activityPanel.innerHTML=`<div class="line">${esc(actText)} <span class="t">${t}</span></div>`;
}
async function pollLog(url,el,isTranscript){
  let lines;
  try{
    const r=await fetch(url,{cache:"no-store"});
    lines=(await r.json()).lines||[];
  }catch(e){return}
  if(!isTranscript){
    const last=lines[lines.length-1]||"";
    const bar=last.indexOf("|");
    if(bar<0){actTs=0;actText=last}
    else{
      const ts=parseInt(last.slice(0,bar),10);
      const text=last.slice(bar+1);
      if(text==="__IDLE__"){actTs=0;actText=""}
      else if(ts!==actTs){actTs=ts;actText=text}
    }
    renderActivity();
    return;
  }
  const atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-4;
  el.innerHTML=lines.map(l=>{
    let cls="line";
    /* Speaker-agnostic: the assistant's tag is its CONFIGURED name
       (backtalk's `name`), not the literal "JANUS" this used to match --
       so a renamed agent's lines simply lost their styling. Anything
       tagged and not the user is the assistant; there are only two. */
    if(l.startsWith("YOU: "))cls="line you";
    else if(/^[^:]{1,24}: /.test(l))cls="line janus";
    return `<div class="${cls}">${esc(l)}</div>`;
  }).join("");
  if(atBottom)el.scrollTop=el.scrollHeight;
}
/* ---------------- context gauge ----------------
   How full Janus's context window is, served by server.py from the
   voice line's .voice_context signal. A semicircle arc for the fill,
   the real token counts under it, and a stacked bar showing where the
   window actually went. Polled every 5s, not every second: the numbers
   only change when a turn completes. Absent signal = panel stays
   hidden, so a face with no voice line behind it looks deliberate
   rather than broken. */
const cgEl=document.getElementById("context-gauge");
const CG_R=46,CG_LEN=Math.PI*CG_R;          /* semicircle arc length */
const CG_COLORS=["#B60232","#E0144C","#FF4D74","#FF8AA6","#FFC2D1"];
function cgTok(n){
  if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1).replace(/\.0$/,"")+"M";
  if(n>=1e3)return (n/1e3).toFixed(n>=1e5?0:1).replace(/\.0$/,"")+"k";
  return String(n);
}
function cgPlace(){
  /* A panel the user has DRAGGED owns its own position -- re-pinning its
     bottom edge here would set top and bottom at once and stretch the box.
     core.js sets this flag when it parks one, and clears it on reset. */
  if(cgEl.dataset.avParked){ugPlace();return}
  /* ride directly on top of the transcript panel, whatever its height */
  cgEl.style.bottom=(transcriptPanel.offsetHeight+20)+"px";
  ugPlace();
}

/* ---------------- plan usage ----------------
   The 5h and 7d rate-limit windows, stacked directly above the context
   gauge. Same source as every other face (AV.util.usageRows), so they
   cannot disagree about the same number, and hidden entirely when the
   voice line publishes no usage. */
const ugEl=document.getElementById("usage-gauge");
function ugPlace(){
  if(ugEl.dataset.avParked)return;
  /* sit on the gauge when it is up, on the transcript when it is not */
  const base=transcriptPanel.offsetHeight+20;
  ugEl.style.bottom=(cgEl.classList.contains("on")
    ? base+cgEl.offsetHeight+8 : base)+"px";
}
function ugRender(){
  const rows=AV.util.usageRows();
  if(!rows.length){ugEl.classList.remove("on");return}
  ugEl.innerHTML='<div class="ug-head">Plan usage</div>'+rows.map(r=>{
    /* usageRows packs "42%  resets in 3h" into one string; the bar wants
       the number and the row wants the reset separately. */
    const rel=r.text.split("  ").slice(1).join(" ").trim();
    const w=r.known?Math.max(2,Math.min(100,r.pct)):0;
    return `<div class="ug-row${r.hot?" hot":""}">`
      +`<b>${esc(r.label)}</b>`
      +`<span class="ug-track"><i style="width:${w}%"></i></span>`
      +`<em>${r.known?r.pct+"%":"—"}</em></div>`
      +(rel?`<div class="ug-reset">${esc(rel)}</div>`:"");
  }).join("");
  ugEl.classList.add("on");
  ugPlace();
}
function cgRender(d){
  if(!d||!d.total){cgEl.classList.remove("on");return}
  const pct=Math.max(0,Math.min(1,d.pct||0));
  const dash=(pct*CG_LEN).toFixed(1);
  const cats=(d.categories||[])
    .filter(c=>!/free|buffer/i.test(c.name)&&c.tokens>0)
    .sort((a,b)=>b.tokens-a.tokens).slice(0,5);
  const catTotal=cats.reduce((a,c)=>a+c.tokens,0)||1;
  const bar=cats.map((c,i)=>
    `<i style="width:${(c.tokens/catTotal*100).toFixed(2)}%;`
    +`background:${CG_COLORS[i%CG_COLORS.length]}"></i>`).join("");
  const legend=cats.slice(0,3).map((c,i)=>
    `<div><s style="background:${CG_COLORS[i%CG_COLORS.length]}"></s>`
    +`${esc(c.name)}<em>${cgTok(c.tokens)}</em></div>`).join("");
  cgEl.innerHTML=
    `<div class="cg-head"><span>Context</span><b>${cgTok(d.free)} free</b></div>`
    +`<svg class="cg-arc" width="110" height="62" viewBox="0 0 110 62">`
    +`<defs><linearGradient id="cgG" x1="0" y1="0" x2="1" y2="0">`
    +`<stop offset="0" stop-color="#FF8AA6"/>`
    +`<stop offset="1" stop-color="#B60232"/></linearGradient>`
    +`<filter id="cgGlow" x="-50%" y="-50%" width="200%" height="200%">`
    +`<feGaussianBlur stdDeviation="2.6" result="b"/>`
    +`<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/>`
    +`</feMerge></filter></defs>`
    +`<path d="M9 55 A ${CG_R} ${CG_R} 0 0 1 101 55" fill="none"`
    +` stroke="rgba(255,190,205,.16)" stroke-width="8"`
    +` stroke-linecap="round"/>`
    +`<path d="M9 55 A ${CG_R} ${CG_R} 0 0 1 101 55" fill="none"`
    +` stroke="url(#cgG)" stroke-width="8" stroke-linecap="round"`
    +` filter="url(#cgGlow)"`
    +` stroke-dasharray="${dash} ${CG_LEN.toFixed(1)}"/>`
    +`<text class="cg-pct" x="55" y="50" text-anchor="middle">`
    +`${Math.round(pct*100)}<tspan class="cg-pct-u" dx="1">%</tspan></text>`
    +`</svg>`
    +`<div class="cg-nums"><span>${cgTok(d.used)} used</span>`
    +`<span class="sep">/</span><span>${cgTok(d.total)} window</span></div>`
    +(bar?`<div class="cg-bar">${bar}</div>`:"")
    +(legend?`<div class="cg-legend">${legend}</div>`:"");
  cgEl.classList.add("on");
  cgPlace();
}
/* ---------------- stack health ----------------
   tools/health.py writes .health every run; server.py serves it on /state
   as AV.health and sends NULL once it has missed two runs, so this panel
   vanishes rather than freezing at OK.

   Placement: bottom-left, sitting directly on top of the MIC IN meter,
   which is canvas chrome at a known offset rather than a DOM element --
   hence the constant instead of a measured height. */
const hgEl=document.getElementById("health-gauge");
const HG_MIC_H=74;      /* MIC IN label + bars + breathing room */
function hgPlace(){
  if(hgEl.dataset.avParked)return;
  hgEl.style.bottom=(chromeInset()+HG_MIC_H)+"px";
}
let hgSig="";
function hgRender(){
  const h=AV.health;
  if(!h){ hgEl.classList.remove("on"); hgSig=""; hgPlace(); return }
  /* Signature so the DOM is only rebuilt when something actually changed:
     this runs on a timer and the panel is mostly static. */
  const sig=JSON.stringify([h.verdict,h.up,h.total,h.idle,h.down,
                            Math.floor((h.age_s||0)/60),h.hist]);
  if(sig!==hgSig){
    hgSig=sig;
    const hist=Array.isArray(h.hist)?h.hist:[];
    /* The sparkline wants a fixed number of cells so the panel never
       resizes: pad the left with empty ones until history fills in. */
    const CELLS=24;
    const tail=hist.slice(-CELLS);
    const pad=CELLS-tail.length;
    let spark="";
    for(let i=0;i<pad;i++) spark+='<i class="gap" style="height:3px"></i>';
    for(const d of tail){
      /* Full height is clean. Each required thing missing takes a bite,
         floored so a bad run is still visible rather than a hairline. */
      const pct=Math.max(18,100-d*34);
      spark+=`<i class="${d?"bad":""}" style="height:${pct}%"></i>`;
    }
    const bad=h.verdict!=="ok";
    const word=bad?(h.down&&h.down.length?"DEGRADED":h.verdict.toUpperCase())
                  :"STACK OK";
    const mins=Math.floor((h.age_s||0)/60);
    const when=mins<1?"checked just now":`checked ${mins} min ago`;
    hgEl.innerHTML=
      `<div class="hg-head"><span>Stack health</span>`
      +`<b>${h.up}/${h.total}</b></div>`
      +`<div class="hg-spark">${spark}</div>`
      +`<div class="hg-word${bad?" bad":""}">${word}</div>`
      +`<div class="hg-sub">${when}${h.idle?` - ${h.idle} idle`:""}</div>`
      +(h.down&&h.down.length
        ? `<div class="hg-down">${h.down.join(", ")} down</div>` : "");
  }
  hgEl.classList.add("on");
  hgPlace();
}

async function pollContext(){
  try{
    const r=await fetch("/context",{cache:"no-store"});
    cgRender(await r.json());
  }catch(e){}
}

if(!AV.demo){
  setInterval(()=>pollLog("/activity",activityPanel,false),1000);
  setInterval(()=>pollLog("/transcript",transcriptPanel,true),1000);
  setInterval(renderActivity,250);
}
/* Outside the demo guard on purpose: the activity and transcript tails
   are real logs and would be meaningless in a demo, but the gauge reads
   an endpoint that answers with sample numbers under --mock -- so it
   belongs in demos and screenshots too. With no server at all the fetch
   just fails and the panel stays hidden. */
pollContext();
setInterval(pollContext,5000);
setInterval(cgPlace,1000);
ugRender();
setInterval(ugRender,5000);
addEventListener("resize",ugPlace);
hgRender();
setInterval(hgRender,2000);
addEventListener("resize",hgPlace);
/* core.js parks the thinking-sound toggle at the bottom-left edge, which
   the transcript panel also covers. Publish the inset so it can lift. */
function publishInset(){
  document.documentElement.style.setProperty(
    "--av-bottom-inset",chromeInset()+"px");
  /* And the top edge, for the same reason: core.js parks the NOW / TO DO
     lists in the top-right, and the activity strip runs the full width of
     the top. Its height changes with its content, so this is republished
     rather than measured once. */
  document.documentElement.style.setProperty(
    "--av-top-inset",(activityPanel.offsetHeight||0)+"px");
}
publishInset();
setInterval(publishInset,1000);
addEventListener("resize",publishInset);
addEventListener("resize",cgPlace);

