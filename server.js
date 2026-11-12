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

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 600000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(-800)));
      resolve(stdout);
    });
  });
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
  } catch (e) {
    job.status = "error";
    job.error = String(e.message || e).slice(0, 400);
  } finally {
    try { fs.unlinkSync(path.join(dir, "audio.opus")); } catch {}
  }
}

app.post("/api/process", (req, res) => {
  const url = String((req.body || {}).url || "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return res.status(400).json({ error: "Paste a valid video link." });
  const id = crypto.randomBytes(6).toString("hex");
  jobs.set(id, { status: "queued", url, created: Date.now() });
  queue = queue.then(() => processJob(id, url)).catch(() => {});
  res.json({ id });
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
      jobs.delete(id);
      fs.rmSync(path.join(JOBS_DIR, id), { recursive: true, force: true });
    }
  }
}, 1800000);

app.listen(PORT, () => console.log("listening on " + PORT));
