const html = htm.bind(React.createElement);
const { useState, useRef, useEffect, useCallback } = React;

const STAGE_LABEL = {
  queued: "In queue...",
  downloading: "Downloading video...",
  transcribing: "Listening & transcribing speech...",
  translating: "Translating captions...",
};

function App() {
  const [url, setUrl] = useState("");
  const [job, setJob] = useState(null);      // {id}
  const [state, setState] = useState(null);  // server payload
  const [speed, setSpeed] = useState(0.7);
  const [cue, setCue] = useState(null);
  const [showSrc, setShowSrc] = useState(true);
  const [showEn, setShowEn] = useState(true);
  const vidRef = useRef(null);
  const cuesRef = useRef([]);

  const start = async () => {
    if (!url.trim()) return;
    setState({ status: "queued" }); setCue(null); setJob(null);
    try {
      let r;
      try {
        r = await fetch("/api/process", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim() }) });
      } catch (netErr) {
        throw new Error("Can't reach the server - it may be waking up. Wait about 30 seconds and try again.");
      }
      const d = await r.json().catch(() => null);
      if (!d) throw new Error("The server is waking up - wait about 30 seconds, then hit Go again.");
      if (!r.ok) throw new Error(d.error || "failed");
      setJob(d);
    } catch (e) { setState({ status: "error", error: e.message }); }
  };

  useEffect(() => {
    if (!job || !job.id) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/job/" + job.id);
        const d = await r.json();
        if (stop) return;
        setState(d);
        if (d.status === "ready") { cuesRef.current = d.cues || []; return; }
        if (d.status === "error") return;
        setTimeout(tick, 1500);
      } catch (e) { if (!stop) setTimeout(tick, 3000); }
    };
    tick();
    return () => { stop = true; };
  }, [job]);

  useEffect(() => {
    if (vidRef.current) vidRef.current.playbackRate = speed;
  }, [speed, state && state.videoUrl]);

  const onTime = useCallback(() => {
    const t = vidRef.current ? vidRef.current.currentTime : 0;
    const cues = cuesRef.current;
    let found = null;
    for (let i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t <= cues[i].end + 0.15) { found = cues[i]; break; }
      if (cues[i].start > t) break;
    }
    setCue(found);
  }, []);

  const busy = state && ["queued","downloading","transcribing","translating"].includes(state.status);
  const ready = state && state.status === "ready";

  return html`
  <div class="wrap">
    <h1>SlowPlay Translate</h1>
    <div class="sub">Paste a reel / TikTok / YouTube link. Get translated captions. Play it slow.</div>
    <div class="row">
      <input type="url" placeholder="https://www.instagram.com/reel/..." value=${url}
        onInput=${e => setUrl(e.target.value)} onKeyDown=${e => e.key === "Enter" && start()} />
      <button onClick=${start} disabled=${busy || !url.trim()}>${busy ? "Working" : "Go"}</button>
    </div>

    ${busy && html`<div class="status"><b>${STAGE_LABEL[state.status] || state.status}</b><br/>
      Short videos take about 1-3 minutes. Keep this page open.</div>`}

    ${state && state.status === "error" && html`<div class="err">Couldn't process that link: ${state.error || ""}
Try a public Instagram reel, TikTok or YouTube video under 7 minutes.</div>`}

    ${ready && html`
      ${(state.title || state.creator) && html`<div class="meta">
        ${state.title && html`<b>${state.title}</b>`} ${state.creator && html` · ${state.creator}`}
        ${state.language && html` · detected: ${state.language.toUpperCase()} → EN`}</div>`}
      <div class="player">
        <video ref=${vidRef} src=${state.videoUrl} controls playsinline preload="auto"
          onTimeUpdate=${onTime} onLoadedMetadata=${e => { e.target.playbackRate = speed; }}></video>
        <div class="caps">
          ${cue && showSrc && html`<div class="cap-src">${cue.src}</div>`}
          ${cue && showEn && html`<div class="cap-en">${cue.en}</div>`}
        </div>
      </div>
      <div class="bar">
        <div class="speeds">
          ${[0.5, 0.7, 1].map(s => html`<button key=${s} class=${"speed" + (speed === s ? " on" : "")}
            onClick=${() => setSpeed(s)}>${s}x</button>`)}
        </div>
        <div class="speeds">
          <button class=${"tog" + (showSrc ? " on" : "")} onClick=${() => setShowSrc(v => !v)}>Original</button>
          <button class=${"tog" + (showEn ? " on" : "")} onClick=${() => setShowEn(v => !v)}>English</button>
        </div>
      </div>
    `}

    <div class="hint">Tip: 0.5x is best for shadowing practice - repeat each caption out loud with the speaker.
    Captions are machine-transcribed and machine-translated, so expect the odd wobble.</div>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App}/>`);
