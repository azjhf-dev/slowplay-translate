import json, os, sys, time, urllib.request, urllib.error, uuid

audio_path, out_path = sys.argv[1], sys.argv[2]
api_key = os.environ.get("GROQ_API_KEY", "").strip()
if not api_key:
    print(json.dumps({"error": "GROQ_API_KEY is not set on the server"}), file=sys.stderr)
    sys.exit(1)

API_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3-turbo"


def build_multipart(fields, file_field, file_path, file_name):
    boundary = "----slowplay" + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields:
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                 % (boundary, name, value)).encode()
    body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
             "Content-Type: application/octet-stream\r\n\r\n" % (boundary, file_field, file_name)).encode()
    with open(file_path, "rb") as f:
        body += f.read()
    body += ("\r\n--%s--\r\n" % boundary).encode()
    return bytes(body), boundary


def transcribe(path=None):
    path = path or audio_path
    fields = [
        ("model", MODEL),
        ("response_format", "verbose_json"),
        ("temperature", "0"),
    ]
    body, boundary = build_multipart(fields, "file", path, "audio.opus")
    req = urllib.request.Request(API_URL, data=body, method="POST")
    req.add_header("Authorization", "Bearer " + api_key)
    req.add_header("User-Agent", "curl/8.5.0")
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    last_err = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode()[:300]
            except Exception:
                pass
            last_err = "groq http %s: %s" % (e.code, detail)
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                wait = int(e.headers.get("Retry-After") or (2 ** attempt) * 5)
                time.sleep(min(wait, 60))
                continue
            break
        except Exception as e:
            last_err = "groq request failed: %s" % e
            if attempt < 3:
                time.sleep((2 ** attempt) * 5)
                continue
            break
    print(json.dumps({"error": last_err}), file=sys.stderr)
    sys.exit(1)


data = transcribe()
# Groq returns a full language name ("Arabic"); gtx needs ISO 639-1 ("ar")
LANG_CODES = {
    "arabic": "ar", "english": "en", "malay": "ms", "indonesian": "id",
    "urdu": "ur", "hindi": "hi", "turkish": "tr", "persian": "fa",
    "farsi": "fa", "french": "fr", "spanish": "es", "german": "de",
    "chinese": "zh-CN", "japanese": "ja", "korean": "ko", "russian": "ru",
    "bengali": "bn", "tamil": "ta", "punjabi": "pa", "pashto": "ps",
    "swahili": "sw", "somali": "so", "hausa": "ha", "amharic": "am",
    "portuguese": "pt", "italian": "it", "dutch": "nl", "thai": "th",
    "vietnamese": "vi", "tagalog": "tl", "hebrew": "he", "greek": "el",
}
language = LANG_CODES.get((data.get("language") or "").strip().lower(), "auto")
segments = data.get("segments") or []

# Whisper sometimes returns an empty-text segment (or no segment) spanning
# real speech - those stretches used to vanish from the captions entirely.
# Find stretches over GAP_SECS with no transcribed text and re-transcribe
# just that audio slice (one extra call per gap), then merge the results.
import subprocess, tempfile
GAP_SECS = 2.5

def find_gaps(segs):
    gaps = []
    prev_end = 0.0
    for s in sorted(segs, key=lambda x: float(x.get("start", 0))):
        st, en = float(s.get("start", 0)), float(s.get("end", 0))
        text = (s.get("text") or "").strip()
        if text:
            if st - prev_end > GAP_SECS:
                gaps.append((prev_end, st))
            prev_end = max(prev_end, en)
        else:
            if en - st > GAP_SECS:
                gaps.append((st, en))
            prev_end = max(prev_end, en)
    return gaps

def transcribe_slice(start, end):
    pad = 0.3
    with tempfile.NamedTemporaryFile(suffix=".opus", delete=False) as tmp:
        slice_path = tmp.name
    try:
        subprocess.run(["ffmpeg", "-y", "-v", "error",
                        "-ss", str(max(0, start - pad)), "-to", str(end + pad),
                        "-i", audio_path, "-ac", "1", "-ar", "16000",
                        "-c:a", "libopus", "-b:a", "32k", slice_path], check=True)
        d = transcribe(slice_path)
        off = max(0, start - pad)
        out = []
        for s in d.get("segments") or []:
            text = (s.get("text") or "").strip()
            if not text:
                continue
            out.append({"start": float(s.get("start", 0)) + off,
                        "end": float(s.get("end", 0)) + off, "text": text})
        return out
    except Exception as e:
        print(json.dumps({"gap_retry_failed": str(e)[:200], "start": start, "end": end}), file=sys.stderr)
        return []
    finally:
        try:
            os.unlink(slice_path)
        except Exception:
            pass

gaps = find_gaps(segments)
for g_start, g_end in gaps:
    segments.extend(transcribe_slice(g_start, g_end))
if gaps:
    segments.sort(key=lambda x: float(x.get("start", 0)))
    print(json.dumps({"gaps_retried": len(gaps)}), file=sys.stderr)

# flatten to word-ish units: use segments, split long ones at punctuation
units = []
for s in segments:
    text = (s.get("text") or "").strip()
    if not text:
        continue
    units.append({"start": round(float(s.get("start", 0)), 2),
                  "end": round(float(s.get("end", 0)), 2),
                  "text": text})

# drop consecutive-duplicate hallucination loops
clean = []
for u in units:
    if len(clean) >= 4 and all(c["text"] == u["text"] for c in clean[-4:]):
        continue
    clean.append(u)

# split overlong units so no caption freezes on screen: recurse at
# punctuation first, else split at the middle word; time is distributed
# by character share. Whisper often returns 15-20s punctuation-free
# segments (common in Arabic speech), which must not become one cue.
import re
def split_unit(u):
    dur = u["end"] - u["start"]
    if dur <= 8:
        return [u]
    parts = [p.strip() for p in re.split(r"(?<=[.?!؟،؛…])\s+", u["text"]) if p.strip()]
    if len(parts) < 2:
        words = u["text"].split()
        if len(words) < 4:
            return [u]
        mid = len(words) // 2
        parts = [" ".join(words[:mid]), " ".join(words[mid:])]
    total = sum(len(p) for p in parts)
    out, t = [], u["start"]
    for p in parts:
        share = dur * len(p) / total
        out.extend(split_unit({"start": round(t, 2), "end": round(t + share, 2), "text": p}))
        t += share
    return out
expanded = []
for u in clean:
    expanded.extend(split_unit(u))
clean = expanded

# chunk into caption cues: break at punctuation, ~9 words, ~6s
cues, cur = [], []
def flush():
    if cur:
        cues.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                     "text": " ".join(c["text"] for c in cur).strip()})
for u in clean:
    # never glue a cue across a silence/untranscribed gap: that used to
    # stretch one caption over the whole gap (a "frozen" caption)
    if cur and (u["start"] - cur[-1]["end"]) > 1.0:
        flush(); cur = []
    # flush BEFORE appending once the span would pass ~6.5s, so no cue
    # can grow to 6.5s + a whole extra unit (up to ~14s frozen on screen)
    if cur and (u["end"] - cur[0]["start"]) > 6.5:
        flush(); cur = []
    cur.append(u)
    txt = " ".join(c["text"] for c in cur)
    words = txt.split()
    if (len(words) >= 10
            or txt.rstrip().endswith((".", "?", "!", "؟", "،", "؛", "…"))):
        flush(); cur = []
flush()

json.dump({"language": language, "cues": cues}, open(out_path, "w"), ensure_ascii=False)
print(json.dumps({"language": language, "n_cues": len(cues)}))
