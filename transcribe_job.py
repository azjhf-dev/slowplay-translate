import json, sys
from faster_whisper import WhisperModel

wav, out_path = sys.argv[1], sys.argv[2]
model = WhisperModel("small", device="cpu", compute_type="int8")
segments, info = model.transcribe(
    wav, beam_size=5, word_timestamps=True, vad_filter=False,
    condition_on_previous_text=True, temperature=0.0,
)
words, language = [], info.language
for s in segments:
    for w in (s.words or []):
        words.append({"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word})

# drop consecutive-duplicate hallucination loops
clean = []
for w in words:
    if len(clean) >= 6 and all(c["word"] == w["word"] for c in clean[-6:]):
        continue
    clean.append(w)

# chunk words into caption cues: break at punctuation, ~7 words, ~6s
cues, cur = [], []
def flush():
    if cur:
        cues.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                     "text": "".join(c["word"] for c in cur).strip()})
for w in clean:
    cur.append(w)
    txt = "".join(c["word"] for c in cur)
    if len(cur) >= 8 or (w["end"] - cur[0]["start"]) > 6 or txt.rstrip().endswith((".","?","!","،","؛",".")):
        flush(); cur = []
flush()
json.dump({"language": language, "cues": cues}, open(out_path, "w"), ensure_ascii=False)
print(json.dumps({"language": language, "n_cues": len(cues)}))
