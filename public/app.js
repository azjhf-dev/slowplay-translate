const html = htm.bind(React.createElement);
const { useState, useRef, useEffect, useCallback } = React;

const LABEL = { queued: "waiting", downloading: "downloading", transcribing: "transcribing", translating: "translating", ready: "ready", error: "failed" };
const BUSY = ["queued", "downloading", "transcribing", "translating"];
const LS = "slowplay.playlist.v2";
const LEGACY_LS = "slowplay.playlist.v1";
const LEGACY_SEED_URLS = new Set([
  "https://www.instagram.com/reel/DaQMhqvsaUB/",
  "https://www.instagram.com/reel/DfcbWn-Sm2y/",
  "https://www.instagram.com/reel/Dfhk8hSBI_C/",
  "https://www.instagram.com/reel/DfmuhtaShBO/"
]);

function loadSaved() {
  try {
    const current = JSON.parse(localStorage.getItem(LS));
    if (current) return current;
    const legacy = JSON.parse(localStorage.getItem(LEGACY_LS)) || {};
    const previousItems = Array.isArray(legacy.items) ? legacy.items : [];
    const wasOldSeed = previousItems.length === 4 && previousItems.every(item => LEGACY_SEED_URLS.has(item.url));
    return previousItems.length && !wasOldSeed ? legacy : {};
  } catch { return {}; }
}

function App() {
  const saved = useRef(loadSaved()).current;
  const [items, setItems] = useState(saved.items || []);
  const [listName, setListName] = useState(saved.name || "");
  const [missingEpisodes, setMissingEpisodes] = useState(saved.missingEpisodes || []);
  const [idx, setIdx] = useState(Math.min(saved.idx || 0, Math.max(0, (saved.items || []).length - 1)));
  const [st, setSt] = useState({});            // url -> {id,status,error,title,language,cues,videoUrl}
  const [speed, setSpeed] = useState(0.7);
  const [cue, setCue] = useState(null);
  const [showSrc, setShowSrc] = useState(true);
  const [showEn, setShowEn] = useState(true);
  const [autoNext, setAutoNext] = useState(true);
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState("");
  const [addMsg, setAddMsg] = useState("");
  const vidRef = useRef(null);
  const cuesRef = useRef([]);
  const stRef = useRef(st); stRef.current = st;
  const autoplayRef = useRef(false);

  // load seed playlist on first visit
  useEffect(() => {
    if (items.length) return;
    fetch("/series.json").then(r => r.json()).then(d => { setItems(d.items); setListName(d.name); setMissingEpisodes(d.missingEpisodes || []); });
  }, []);
  useEffect(() => {
    localStorage.setItem(LS, JSON.stringify({ items, name: listName, idx, missingEpisodes }));
  }, [items, listName, idx, missingEpisodes]);

  const ensure = useCallback(async (url) => {
    const cur = stRef.current[url];
    if (cur && cur.status === "ready" && cur.videoUrl && !cur.stale) return;
    if (cur && BUSY.includes(cur.status)) return;
    setSt(s => ({ ...s, [url]: { status: "queued" } }));
    try {
      const r = await fetch("/api/process", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const d = await r.json().catch(() => null);
      if (!d) throw new Error("Server is waking up - try again in 30s");
      if (!r.ok) throw new Error(d.error || "failed");
      setSt(s => ({ ...s, [url]: { status: "queued", id: d.id } }));
    } catch (e) { setSt(s => ({ ...s, [url]: { status: "error", error: e.message } })); }
  }, []);

  // poll in-flight jobs
  useEffect(() => {
    const t = setInterval(async () => {
      const cur = stRef.current;
      for (const url of Object.keys(cur)) {
        const j = cur[url];
        if (!j.id || !BUSY.includes(j.status)) continue;
        try {
          const d = await (await fetch("/api/job/" + j.id)).json();
          if (d.status !== j.status || d.status === "ready") setSt(s => ({ ...s, [url]: { ...s[url], ...d, id: j.id } }));
        } catch {}
      }
    }, 2000);
    return () => clearInterval(t);
  }, []);

  // always process the current episode, and the next one while it plays
  useEffect(() => {
    if (!items[idx]) return;
    ensure(items[idx].url);
    if (items[idx + 1]) ensure(items[idx + 1].url);
  }, [idx, items]);
  // "process all" toggle: queue everything in order
  useEffect(() => {
    if (!all) return;
    (async () => { for (let i = idx; i < items.length; i++) await ensure(items[i].url); })();
  }, [all, items]);

  const item = items[idx];
  const cur = item && st[item.url];
  const ready = cur && cur.status === "ready";
  useEffect(() => { cuesRef.current = ready ? (cur.cues || []) : []; setCue(null); }, [ready, cur && cur.id]);
  useEffect(() => { if (vidRef.current) vidRef.current.playbackRate = speed; }, [speed, cur && cur.videoUrl]);

  // if a ready episode's video file expired on the server, refresh the job
  const onVideoError = () => { if (item) { setSt(s => ({ ...s, [item.url]: { status: "error", error: "video expired", stale: true } })); setTimeout(() => { setSt(s => { const n = { ...s }; delete n[item.url]; return n; }); setTimeout(() => ensure(item.url), 50); }, 50); } };

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

  const go = (i) => { if (i >= 0 && i < items.length) { autoplayRef.current = false; setIdx(i); } };
  const onEnded = () => {
    if (autoNext && idx < items.length - 1) { autoplayRef.current = true; setIdx(idx + 1); }
  };
  const onLoaded = (e) => {
    e.target.playbackRate = speed;
    if (autoplayRef.current) { e.target.play().catch(() => {}); }
  };

  const add = async () => {
    const text = adding.trim(); if (!text) return;
    const urls = (text.match(/https?:\/\/[^\s"'<>()]+/g) || []).map(u => u.replace(/[.,;!?)\]]+$/, ""));
    if (!urls.length) { setAddMsg("No links found."); return; }
    setAddMsg("Adding...");
    let added = [];
    for (const u of urls) {
      if (/[?&]list=|\/playlist|\/(playlists|videos|@[^/]+)\/?$/.test(u) && /youtu/.test(u)) {
        try {
          const r = await fetch("/api/expand", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u }) });
          const d = await r.json();
          if (r.ok) { added = added.concat(d.items); continue; }
          setAddMsg(d.error || "Could not read playlist");
        } catch {}
      }
      added.push({ url: u, title: u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48) });
    }
    const have = new Set(items.map(i => i.url));
    const fresh = added.filter(a => !have.has(a.url));
    setItems(items.concat(fresh)); setAdding(""); setAddMsg("Added " + fresh.length + " to the end of the queue.");
    if (!listName) setListName("My playlist");
  };
  const reset = () => { if (confirm("Reset to the Mastering I'rab series?")) { localStorage.removeItem(LS); localStorage.removeItem(LEGACY_LS); location.reload(); } };
  const remove = (i) => { const n = items.filter((_, k) => k !== i); setItems(n); if (i < idx) setIdx(idx - 1); else if (i === idx && idx >= n.length) setIdx(Math.max(0, n.length - 1)); };

  const nReady = items.filter(i => st[i.url] && st[i.url].status === "ready").length;

  return html`
  <div class="wrap">
    <h1>SlowPlay Translate</h1>
    <div class="sub">Playlist player with translated captions. Play it slow.</div>

    ${item && html`<div class="meta"><b>${idx + 1}/${items.length}</b> · ${item.title}</div>`}
    ${item && !ready && html`<div class="status">${cur && cur.status === "error"
      ? html`<span class="errtxt">Couldn't process this one: ${cur.error}</span> <button class="tog" onClick=${() => { setSt(s => { const n = { ...s }; delete n[item.url]; return n; }); setTimeout(() => ensure(item.url), 50); }}>Retry</button>`
      : html`<b>${(cur && LABEL[cur.status]) || "starting"}...</b> First time takes 1-3 minutes; after that it is instant.`}</div>`}

    ${ready && html`
      <div class="player">
        <video key=${cur.id} ref=${vidRef} src=${cur.videoUrl} controls playsinline preload="auto"
          onTimeUpdate=${onTime} onLoadedMetadata=${onLoaded} onEnded=${onEnded} onError=${onVideoError}></video>
        <div class="caps">
          ${cue && showSrc && html`<div class="cap-src">${cue.src}</div>`}
          ${cue && showEn && html`<div class="cap-en">${cue.en}</div>`}
        </div>
      </div>`}

    <div class="bar">
      <div class="speeds">
        <button class="speed" disabled=${idx <= 0} onClick=${() => go(idx - 1)}>⏮ Prev</button>
        <button class="speed" disabled=${idx >= items.length - 1} onClick=${() => go(idx + 1)}>Next ⏭</button>
      </div>
      <div class="speeds">
        ${[0.5, 0.7, 1].map(s => html`<button key=${s} class=${"speed" + (speed === s ? " on" : "")} onClick=${() => setSpeed(s)}>${s}x</button>`)}
      </div>
    </div>
    <div class="bar">
      <div class="speeds">
        <button class=${"tog" + (showSrc ? " on" : "")} onClick=${() => setShowSrc(v => !v)}>Original</button>
        <button class=${"tog" + (showEn ? " on" : "")} onClick=${() => setShowEn(v => !v)}>English</button>
      </div>
      <div class="speeds">
        <button class=${"tog" + (autoNext ? " on" : "")} onClick=${() => setAutoNext(v => !v)}>Auto-next</button>
        <button class=${"tog" + (all ? " on" : "")} onClick=${() => setAll(v => !v)}>Process all</button>
      </div>
    </div>

    <div class="meta mt"><b>${listName || "Playlist"}</b> · ${nReady}/${items.length} ready</div>
    ${missingEpisodes.length > 0 && html`<div class="status">Episode ${missingEpisodes.join(", ")} not found - skipped.</div>`}
    <div class="queue">
      ${items.map((it, i) => {
        const s = st[it.url]; const state = s ? s.status : "";
        return html`<div key=${it.url} class=${"qi" + (i === idx ? " cur" : "")} onClick=${() => go(i)}>
          <span class="qn">${i + 1}</span><span class="qt">${it.title}</span>
          <span class=${"qs " + state}>${state ? LABEL[state] : ""}</span>
          <span class="qx" onClick=${e => { e.stopPropagation(); remove(i); }}>×</span></div>`; })}
    </div>

    <div class="row mt2">
      <input type="url" placeholder="Add reel / YouTube video or playlist links" value=${adding}
        onInput=${e => setAdding(e.target.value)} onKeyDown=${e => e.key === "Enter" && add()} />
      <button onClick=${add} disabled=${!adding.trim()}>Add</button>
    </div>
    ${addMsg && html`<div class="status">${addMsg}</div>`}
    <div class="hint">Tip: 0.5x is best for shadowing. The next episode is processed while you watch this one.
    Captions are machine-transcribed and translated. <a href="#" onClick=${e => { e.preventDefault(); reset(); }} class="lnk">Reset playlist</a></div>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App}/>`);
