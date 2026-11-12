const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 7860;
const JOBS_DIR = "/tmp/jobs";
const MAX_SECONDS = 420; // 7 min cap
fs.mkdirSync(JOBS_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const jobs = new Map();
let queue = Promise.resolve();

// Pull a usable URL out of whatever got pasted: strips invisible Unicode
// (zero-width spaces, BOM), finds the first http(s) link inside surrounding
// text, and drops trailing punctuation that rides along in chat messages.
function extractVideoUrl(raw) {
  if (!raw) return null;
  const clean = String(raw).replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  const m = clean.match(/https?:\/\/[^\s"'<>()]+/i);
  if (!m) return null;
  const url = m[0].replace(/[.,;!?)\]]+$/, "");
  return /^https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/|$)/i.test(url) ? url : null;
}

// Canonical cache key so every link form of the same video maps to one entry.
function canonicalKeySync(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const p = u.pathname;
  let m;
  if (/(^|\.)instagram\.com$/.test(host) && (m = p.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/))) return "ig:" + m[1];
  if (host === "youtu.be" && (m = p.match(/^\/([A-Za-z0-9_-]{6,})/))) return "yt:" + m[1];
  if (/(^|\.)youtube\.com$/.test(host)) {
    if (u.searchParams.get("v")) return "yt:" + u.searchParams.get("v");
    if ((m = p.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]+)/))) return "yt:" + m[1];
  }
  if (/(^|\.)tiktok\.com$/.test(host) && (m = p.match(/\/video\/(\d+)/))) return "tt:" + m[1];
  return null;
}

async function canonicalKey(url) {
  let k = canonicalKeySync(url);
  if (k) return k;
  // short links (vt./vm.tiktok.com etc.): follow redirects once to find the real URL
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" } });
    k = canonicalKeySync(r.url);
    if (k) return k;
  } catch {}
  return null;
}

const cache = new Map(); // canonical key -> job id

function cachedJobFor(key) {
  const id = cache.get(key);
  const job = id && jobs.get(id);
  if (!job || job.status === "error") { cache.delete(key); return null; }
  if (job.status === "ready") {
    if (!job.videoFile || !fs.existsSync(path.join(JOBS_DIR, id, job.videoFile))) { cache.delete(key); return null; }
  }
  return id;
}

function friendlyError(e) {
  const msg = String((e && e.message) || e).slice(0, 800);
  if (/rate.limit|\b429\b|too many requests/i.test(msg))
    return "The video site is rate-limiting the server right now - wait a few minutes and try again.";
  if (/login required|sign in|private|checkpoint|challenge|not authorized/i.test(msg))
    return "That video looks private or login-only - only fully public videos work.";
  if (/unsupported url|no video formats/i.test(msg))
    return "That link works in a browser but has no downloadable video - try the direct reel/video URL.";
  return msg.slice(0, 400);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 600000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(-800)));
      resolve(stdout);
    });
  });
}


// ---- Persistent cue store (private GitHub repo) -------------------------
// Cues (transcript + timings + English translation) are small JSON, so they
// are saved per canonical video ID and survive Render restarts. They do not
// expire (text only). Video files stay on /tmp with the 3h expiry and are
// simply re-downloaded after a restart. Any GitHub failure falls back to the
// normal full pipeline.
const STORE_REPO = process.env.CACHE_REPO || "azjhf-dev/slowplay-cache";
const STORE_TOKEN = process.env.CACHE_GITHUB_TOKEN || "";
function storePath(key) { return "cues/" + key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json"; }
async function ghFetch(p, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    return await fetch("https://api.github.com/repos/" + STORE_REPO + "/contents/" + p, {
      ...opts, signal: ctl.signal,
      headers: { "Authorization": "Bearer " + STORE_TOKEN, "Accept": "application/vnd.github+json",
        "User-Agent": "slowplay-translate", ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}
async function storeGet(key) {
  if (!STORE_TOKEN || !key) return null;
  try {
    const r = await ghFetch(storePath(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const data = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
    // v2 = cue splitter that breaks long punctuation-free segments;
    // older entries can contain 15-20s frozen captions, treat as miss
    return data && data.v === 3 && Array.isArray(data.cues) && data.cues.length ? data : null;
  } catch (e) { console.log("[store] get failed (falling back): " + e.message); return null; }
}
async function storePut(key, data) {
  if (!STORE_TOKEN || !key) return;
  try {
    const p = storePath(key);
    let sha;
    try { const r = await ghFetch(p); if (r.ok) sha = (await r.json()).sha; } catch {}
    const r = await ghFetch(p, { method: "PUT", body: JSON.stringify({
      message: "cache " + key, sha,
      content: Buffer.from(JSON.stringify(data)).toString("base64") }) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    console.log("[store] SAVED key=" + key);
  } catch (e) { console.log("[store] put failed (ignored): " + e.message); }
}

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const TRANSLATE_MODEL = "openai/gpt-oss-120b";

async function groqTranslate(lines, src) {
  const DELIM = "\n###\n";
  const srcName = { ar: "Arabic" }[src] || "the source language";
  const body = {
    model: TRANSLATE_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content:
        "You translate video caption lines from " + srcName + " to English. " +
        "Lines are separated by " + JSON.stringify(DELIM) + ". Output the translation of each line in the same order, " +
        "separated by exactly the same ### separator, with no numbering, no commentary, and no skipped lines. " +
        "Keep grammar terms precise (i'rab, nasb, raf', mubtada, khabar, ism, harf). Translate meaning naturally." },
      { role: "user", content: lines.join(DELIM) }
    ]
  };
  const r = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY,
               "Content-Type": "application/json", "User-Agent": "curl/8.5.0" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("groq translate http " + r.status + ": " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const text = (((data.choices || [])[0] || {}).message || {}).content || "";
  return text.split(/\s*###\s*/).map(s => s.trim());
}

async function translateBatch(texts, src, tl = "en") {
  // batch via Groq with sentinel, fall back to per-line
  const out = new Array(texts.length).fill("");
  let i = 0;
  while (i < texts.length) {
    let j = i, len = 0;
    while (j < texts.length && len + texts[j].length < 3000) { len += texts[j].length; j++; }
    const lines = texts.slice(i, j);
    try {
      const parts = await groqTranslate(lines, src);
      if (parts.length === lines.length) {
        for (let k = 0; k < parts.length; k++) out[i + k] = parts[k];
      } else { throw new Error("sentinel mismatch " + parts.length + " != " + lines.length); }
    } catch (e) {
      for (let k = 0; k < lines.length; k++) {
        for (let attempt = 0; attempt < 2 && !out[i + k]; attempt++) {
          try { out[i + k] = (await groqTranslate([lines[k]], src))[0] || ""; }
          catch (e2) { /* leave empty, retry once */ }
        }
      }
    }
    i = j;
  }
  return out;
}

async function processJob(id, url) {
  const job = jobs.get(id);
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    job.status = "downloading";
    const metaRaw = await run("yt-dlp", ["--no-playlist", "--no-warnings", "--skip-download",
      "--print", "%(title)s | %(uploader)s | %(channel)s | %(duration)s", url]);
    await run("yt-dlp", ["--no-playlist", "--no-warnings",
      "-f", "best[ext=mp4][height<=720]/best[ext=mp4]/best[height<=720]/best",
      "-o", path.join(dir, "video.%(ext)s"), url]);
    const [title, uploader, channel, duration] = metaRaw.trim().split("\n")[0].split(" | ");
    job.title = (title && title !== "NA") ? title : "";
    job.creator = [uploader, channel].find(x => x && x !== "NA") || "";
    const file = fs.readdirSync(dir).find(f => f.startsWith("video."));
    if (!file) throw new Error("download produced no file");
    const stat = fs.statSync(path.join(dir, file));
    if (stat.size > 300 * 1024 * 1024) throw new Error("video too large (300 MB max)");
    let dur = parseFloat(duration);
    if (!isFinite(dur)) {
      try {
        dur = parseFloat((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1", path.join(dir, file)])).trim());
      } catch {}
    }
    if (isFinite(dur) && dur > MAX_SECONDS) throw new Error("video is " + Math.round(dur / 60) + " min - max is " + (MAX_SECONDS / 60) + " min");
    job.videoFile = file;

    const stored = await storeGet(job.key);
    if (stored) {
      console.log("[store] HIT key=" + job.key + " cues=" + stored.cues.length + " (skipping transcription+translation)");
      job.language = stored.language;
      job.cues = stored.cues;
      job.status = "ready";
      return;
    }
    console.log("[store] MISS key=" + job.key);

    job.status = "transcribing";
    if (!process.env.GROQ_API_KEY) throw new Error("server is missing its transcription key (GROQ_API_KEY)");
    await run("ffmpeg", ["-y", "-v", "error", "-i", path.join(dir, file), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", path.join(dir, "audio.opus")]);
    const tOut = await run("python3", [path.join(__dirname, "transcribe_job.py"), path.join(dir, "audio.opus"), path.join(dir, "cues.json")], { timeout: 900000 });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "cues.json"), "utf8"));
    if (!parsed.cues.length) throw new Error("no speech detected in this video");
    job.language = parsed.language;

    job.status = "translating";
    const ens = await translateBatch(parsed.cues.map(c => c.text), parsed.language, "en");
    job.cues = parsed.cues.map((c, k) => ({ start: c.start, end: c.end, src: c.text, en: ens[k] || "" }));

    job.status = "ready";
    storePut(job.key, { v: 3, key: job.key, language: job.language, title: job.title, creator: job.creator, url: job.url, saved: new Date().toISOString(), cues: job.cues });
  } catch (e) {
    job.status = "error";
    job.error = friendlyError(e);
    console.log("[job " + id + "] error: " + String((e && e.message) || e).slice(0, 600));
  } finally {
    try { fs.unlinkSync(path.join(dir, "audio.opus")); } catch {}
  }
}

app.post("/api/process", async (req, res) => {
  const raw = String((req.body || {}).url || "");
  const url = extractVideoUrl(raw);
  console.log("[process] raw=" + JSON.stringify(raw.slice(0, 300)) + " -> url=" + url);
  if (!url) return res.status(400).json({ error: "That doesn't look like a video link - paste the full Instagram reel, TikTok or YouTube URL on its own." });
  const key = await canonicalKey(url);
  if (key) {
    const hit = cachedJobFor(key);
    if (hit) {
      console.log("[cache] " + (jobs.get(hit).status === "ready" ? "HIT" : "JOIN in-flight") + " key=" + key + " job=" + hit);
      return res.json({ id: hit, cached: true });
    }
  }
  const id = crypto.randomBytes(6).toString("hex");
  jobs.set(id, { status: "queued", url, key, created: Date.now() });
  if (key) cache.set(key, id);
  console.log("[cache] MISS key=" + key + " job=" + id);
  queue = queue.then(() => processJob(id, url)).catch(() => {});
  res.json({ id });
});

// Expand a YouTube playlist / channel-playlist link into its video URLs.
app.post("/api/expand", async (req, res) => {
  const url = extractVideoUrl(String((req.body || {}).url || ""));
  if (!url) return res.status(400).json({ error: "Not a link" });
  try {
    const out = await run("yt-dlp", ["--flat-playlist", "--no-warnings", "--playlist-end", "60",
      "--print", "%(id)s|%(title)s|%(url)s", url], { timeout: 60000 });
    const items = out.trim().split("\n").filter(Boolean).map(l => {
      const [id, title, u] = l.split("|");
      return { title: title && title !== "NA" ? title : id,
        url: /^https?:/.test(u || "") ? u : "https://www.youtube.com/watch?v=" + id };
    });
    res.json({ items });
  } catch (e) { res.status(400).json({ error: friendlyError(e) }); }
});

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  const { status, error, title, creator, language, cues, videoFile } = job;
  res.json({ status, error, title, creator, language,
    cues: status === "ready" ? cues : undefined,
    videoUrl: status === "ready" ? "/api/video/" + req.params.id : undefined });
});

app.get("/api/video/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.videoFile) return res.status(404).end();
  const fp = path.join(JOBS_DIR, req.params.id, job.videoFile);
  fs.stat(fp, (err, st) => {
    if (err) return res.status(404).end();
    const range = req.headers.range;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
      res.setHeader("Content-Length", end - start + 1);
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", st.size);
      fs.createReadStream(fp).pipe(res);
    }
  });
});

// cleanup jobs older than 3h
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.created > 3 * 3600 * 1000) {
      if (job.key && cache.get(job.key) === id) cache.delete(job.key);
      jobs.delete(id);
      fs.rmSync(path.join(JOBS_DIR, id), { recursive: true, force: true });
    }
  }
}, 1800000);

app.listen(PORT, () => console.log("listening on " + PORT));
