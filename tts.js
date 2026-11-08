// Listening audio maker: script → speech + pauses + sounds → MP3.
//
// Everything runs in the teacher's browser. The voices are open-source Piper models
// (downloaded once per browser, then cached), sound effects are generated here, and
// the MP3 is encoded with lamejs. Nothing is sent to a server.

const PIPER_URL = "https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/+esm";
const PIPER_WASM = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const ORT_FALLBACK = "1.27.0";
const LAME_URL = "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js";

/** All audio is mixed at this sample rate (mono). */
export const SR = 22050;

/**
 * Voices. "a" is the default voice; "b" is the second speaker.
 * Chinese has one open voice, so "b" is the same voice lowered in pitch.
 */
export const VOICES = {
  zh: {
    name: "中文 Chinese",
    a: { id: "zh_CN-huayan-medium", label: "Woman" },
    b: { id: "zh_CN-huayan-medium", label: "Man (lower voice)", pitch: 0.7 },
  },
  en: {
    name: "English",
    a: { id: "en_US-hfc_female-medium", label: "Woman" },
    b: { id: "en_US-hfc_male-medium", label: "Man" },
  },
  fr: {
    name: "Français French",
    a: { id: "fr_FR-siwis-medium", label: "Woman" },
    b: { id: "fr_FR-tom-medium", label: "Man" },
  },
};

export const SOUNDS = {
  d: "Ding",
  dd: "Ding-dong",
  b: "Beep",
  c: "Chime",
};

// ── Script ──────────────────────────────────────────────────────────
//   Plain lines are read aloud. Tags can be on their own line or inside a line:
//     *2* … *2*   read what's between twice (also *3*, *4* …)
//     *p1*        pause 1 second (*p0.5*, *p2* …)
//     *d* *dd* *b* *c*   ding · ding-dong · beep · chime
//   A line can start with  A:  B:  女：  男：  to choose the voice (A is the default).

const TAG = /\*(p\d*\.?\d*|dd|d|b|c|\d)\*/gi;
const SPEAKER = /^\s*(A|B|女|男)\s*[:：]\s*/i;

/**
 * Turn the script text into a list of items:
 *   { t: "say", text, voice: "a"|"b", line }
 *   { t: "pause", sec }   { t: "sfx", name }   { t: "rep", n, items: [...] }
 */
export function parseScript(text) {
  const root = [];
  const stack = [{ n: 0, items: root }];
  const warnings = [];
  const top = () => stack[stack.length - 1];
  const stats = { lines: 0, pauses: 0, sounds: 0, repeats: 0 };

  String(text || "").split(/\r?\n/).forEach((raw, li) => {
    let voice = "a";
    let first = true;
    let last = 0;
    const say = (piece) => {
      let t = piece.trim();
      if (first && t) {
        const m = SPEAKER.exec(t);
        if (m) { voice = /^(B|男)$/i.test(m[1]) ? "b" : "a"; t = t.slice(m[0].length); }
        first = false;
      }
      t = t.replace(/\*/g, "").trim();
      // only speak pieces that contain something readable
      if (t && /[\p{L}\p{N}]/u.test(t)) { top().items.push({ t: "say", text: t, voice, line: li + 1 }); stats.lines++; }
    };

    for (const m of raw.matchAll(TAG)) {
      say(raw.slice(last, m.index));
      last = m.index + m[0].length;
      const tag = m[1].toLowerCase();
      if (/^\d$/.test(tag)) {
        const n = +tag;
        if (n < 2) { warnings.push(`Line ${li + 1}: *${tag}* does nothing. Use *2* to read twice.`); continue; }
        if (stack.length > 1 && top().n === n) { stack.pop(); }
        else {
          const item = { t: "rep", n, items: [] };
          top().items.push(item);
          stack.push({ n, items: item.items });
          stats.repeats++;
        }
      } else if (tag[0] === "p" && !SOUNDS[tag]) {
        const sec = Math.min(30, Math.max(0.1, parseFloat(tag.slice(1)) || 1));
        top().items.push({ t: "pause", sec });
        stats.pauses++;
      } else {
        top().items.push({ t: "sfx", name: tag });
        stats.sounds++;
      }
    }
    say(raw.slice(last));
  });

  if (stack.length > 1) {
    warnings.push(`*${top().n}* was opened but never closed. It repeats everything after it. Add another *${top().n}* where it should stop.`);
  }
  return { items: root, warnings, stats };
}

/** All distinct lines that need to be spoken: [{ voice, text }] */
function sayings(items, out = new Map()) {
  for (const it of items) {
    if (it.t === "say") out.set(it.voice + "|" + it.text, { voice: it.voice, text: it.text });
    else if (it.t === "rep") sayings(it.items, out);
  }
  return [...out.values()];
}

// ── Loading the speech engine ───────────────────────────────────────
let piper = null;
let ortVersion = ORT_FALLBACK;
let current = null;          // { voiceId, session }

async function loadPiper() {
  if (piper) return piper;
  piper = await import(PIPER_URL);
  // Piper's bundle pulls a specific onnxruntime-web version; its runtime files must match.
  try {
    const src = await (await fetch(PIPER_URL)).text();
    const m = src.match(/onnxruntime-web@(\d+\.\d+\.\d+)\//);
    if (m) ortVersion = m[1];
  } catch { /* use the fallback version */ }
  return piper;
}

/** Make `voiceId` the active voice (loads the model; a few seconds, or a 63 MB download the first time). */
async function useVoice(voiceId, onProgress) {
  if (current?.voiceId === voiceId) return current.session;
  const { TtsSession } = await loadPiper();
  TtsSession._instance = null;       // Piper keeps one shared session; reset it to switch voice
  const session = new TtsSession({
    voiceId,
    progress: (p) => { if (p?.total) onProgress?.({ phase: "voice", voiceId, pct: Math.round((p.loaded / p.total) * 100) }); },
    wasmPaths: {
      onnxWasm: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVersion}/dist/`,
      piperData: `${PIPER_WASM}.data`,
      piperWasm: `${PIPER_WASM}.wasm`,
    },
  });
  await session.waitReady;
  current = { voiceId, session };
  return session;
}

/** Read a WAV blob (16-bit or float) into { pcm: Float32Array, sr }. */
async function readWav(blob) {
  const buf = await blob.arrayBuffer();
  const v = new DataView(buf);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(pos), v.getUint8(pos + 1), v.getUint8(pos + 2), v.getUint8(pos + 3));
    const size = v.getUint32(pos + 4, true);
    if (id === "fmt ") fmt = { code: v.getUint16(pos + 8, true), ch: v.getUint16(pos + 10, true), sr: v.getUint32(pos + 12, true), bits: v.getUint16(pos + 22, true) };
    if (id === "data") { data = { start: pos + 8, size: Math.min(size, v.byteLength - pos - 8) }; break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("Unreadable audio from the voice");
  const bytes = fmt.bits / 8;
  const n = Math.floor(data.size / bytes / fmt.ch);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = data.start + i * fmt.ch * bytes;    // first channel only
    pcm[i] = fmt.code === 3 ? v.getFloat32(o, true)
      : fmt.bits === 16 ? v.getInt16(o, true) / 32768
      : (v.getUint8(o) - 128) / 128;
  }
  return { pcm, sr: fmt.sr };
}

// ── Sound processing ────────────────────────────────────────────────
/** Play-rate change: ratio < 1 → lower pitch and longer. */
function resample(x, ratio) {
  if (Math.abs(ratio - 1) < 0.001) return x;
  const n = Math.max(1, Math.floor(x.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, k = Math.floor(p), f = p - k;
    out[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f;
  }
  return out;
}

/** Change speed without changing pitch (WSOLA). factor > 1 is faster. */
function tempo(x, factor) {
  if (Math.abs(factor - 1) < 0.02 || x.length < 4096) return x;
  const N = 1024, H = 512, tol = 384, stride = 3;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);   // Hann, 50% overlap sums to 1
  const out = new Float32Array(Math.ceil(x.length / factor) + N * 2);
  for (let i = 0; i < N; i++) out[i] += x[i] * win[i];
  let prev = 0, k = 1;
  for (;;) {
    const ideal = Math.round(k * H * factor);
    const target = prev + H;                       // where the previous frame would naturally continue
    if (ideal >= x.length - N || target + H > x.length) break;
    let best = ideal, bestScore = -Infinity;
    const lo = Math.max(0, ideal - tol), hi = Math.min(x.length - N, ideal + tol);
    for (let s = lo; s <= hi; s += 2) {            // pick the position that lines up best
      let c = 0;
      for (let i = 0; i < H; i += stride) c += x[s + i] * x[target + i];
      if (c > bestScore) { bestScore = c; best = s; }
    }
    const o = k * H;
    for (let i = 0; i < N; i++) out[o + i] += x[best + i] * win[i];
    prev = best;
    k++;
  }
  return out.subarray(0, Math.min(out.length, k * H + N));
}

/** Scale to a steady loudness and soften the very start/end so clips don't click. */
function finish(x, peak = 0.85) {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  const g = m > 0 ? peak / m : 1;
  const out = new Float32Array(x.length);
  const fade = Math.min(Math.floor(SR * 0.008), x.length >> 1);
  for (let i = 0; i < x.length; i++) {
    let s = x[i] * g;
    if (i < fade) s *= i / fade;
    else if (i >= x.length - fade) s *= (x.length - 1 - i) / fade;
    out[i] = s;
  }
  return out;
}

const silence = (sec) => new Float32Array(Math.round(Math.max(0, sec) * SR));

// ── Sound effects (generated, so there are no files and no copyright) ──
function tone(freq, sec, { decay = 0.25, vol = 0.5, harmonics = [[1, 1], [2, 0.3], [3, 0.1]] } = {}) {
  const n = Math.round(sec * SR), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (const [h, a] of harmonics) s += a * Math.sin(2 * Math.PI * freq * h * t);
    const env = Math.min(1, t / 0.004) * Math.exp(-t / decay);
    out[i] = s * env * vol;
  }
  return out;
}
function mixAt(parts) {            // [[startSec, Float32Array], ...]
  const total = Math.max(...parts.map(([s, a]) => Math.round(s * SR) + a.length));
  const out = new Float32Array(total);
  for (const [s, a] of parts) { const o = Math.round(s * SR); for (let i = 0; i < a.length; i++) out[o + i] += a[i]; }
  return out;
}
export function soundEffect(name) {
  switch (name) {
    case "dd": return mixAt([[0, tone(1318.5, 1.0, { decay: 0.3 })], [0.55, tone(987.8, 1.3, { decay: 0.4 })]]);
    case "b": {
      const x = tone(1000, 0.4, { decay: 10, vol: 0.45, harmonics: [[1, 1]] });
      const f = Math.floor(SR * 0.01);
      for (let i = 0; i < f; i++) { x[x.length - 1 - i] *= i / f; }
      return x;
    }
    case "c": return mixAt([[0, tone(1046.5, 0.9, { decay: 0.25 })], [0.22, tone(1318.5, 0.9, { decay: 0.25 })], [0.44, tone(1568, 1.3, { decay: 0.35 })]]);
    case "d":
    default: return tone(1318.5, 1.3, { decay: 0.28 });
  }
}

// ── Making the audio ────────────────────────────────────────────────
const spoken = new Map();   // cache: model|text → { pcm, sr } straight from the voice

/**
 * Build the whole recording.
 * opts: { lang, speed (1 = normal), lineGap (seconds after each line), repeatGap (seconds between repeats) }
 * onProgress({ phase: "voice" | "speak" | "mix", ... })
 * Returns { pcm: Float32Array, sr, seconds }.
 */
export async function makeAudio(parsed, opts, onProgress) {
  const { lang = "zh", speed = 1, lineGap = 0.7, repeatGap = 2 } = opts || {};
  const voices = VOICES[lang] || VOICES.zh;
  const items = parsed.items;
  const lines = sayings(items);
  if (!lines.length && !JSON.stringify(items).includes('"sfx"') && !JSON.stringify(items).includes('"pause"')) {
    throw new Error("The script is empty. Type something to say first.");
  }

  // 1. Speak every distinct line once, one voice model at a time.
  const byModel = new Map();
  for (const l of lines) {
    const v = voices[l.voice] || voices.a;
    if (!byModel.has(v.id)) byModel.set(v.id, []);
    byModel.get(v.id).push(l);
  }
  const total = lines.length;
  let done = 0;
  for (const [modelId, list] of byModel) {
    if (list.every((l) => spoken.has(modelId + "|" + l.text))) { done += list.length; continue; }
    const session = await useVoice(modelId, onProgress);
    for (const l of list) {
      const key = modelId + "|" + l.text;
      if (!spoken.has(key)) spoken.set(key, await readWav(await session.predict(l.text)));
      onProgress?.({ phase: "speak", done: ++done, total });
      await new Promise((r) => setTimeout(r));   // let the page repaint
    }
  }

  // 2. Shape each line for its voice and speed.
  onProgress?.({ phase: "mix" });
  const shaped = new Map();
  const clip = (l) => {
    const v = voices[l.voice] || voices.a;
    const key = `${v.id}|${v.pitch || 1}|${speed}|${l.text}`;
    if (!shaped.has(key)) {
      const raw = spoken.get(v.id + "|" + l.text);
      let x = raw.sr === SR ? raw.pcm : resample(raw.pcm, raw.sr / SR);
      const pitch = v.pitch || 1;
      x = resample(x, pitch);                       // lower the voice (also makes it slower…)
      x = tempo(x, speed / pitch);                  // …so bring the speed back, plus the chosen speed
      shaped.set(key, finish(x));
    }
    return shaped.get(key);
  };

  // 3. Lay everything out in order.
  const parts = [];
  const walk = (list) => {
    for (const it of list) {
      if (it.t === "say") { parts.push(clip(it), silence(lineGap)); }
      else if (it.t === "pause") parts.push(silence(it.sec));
      else if (it.t === "sfx") parts.push(finish(soundEffect(it.name), 0.7), silence(0.3));
      else if (it.t === "rep") {
        for (let r = 0; r < it.n; r++) { walk(it.items); if (r < it.n - 1) parts.push(silence(repeatGap)); }
      }
    }
  };
  walk(items);
  parts.push(silence(0.3));

  const len = parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Float32Array(len);
  let o = 0;
  for (const p of parts) { pcm.set(p, o); o += p.length; }
  return { pcm, sr: SR, seconds: len / SR };
}

// ── MP3 ─────────────────────────────────────────────────────────────
let lamePromise = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  if (!lamePromise) {
    lamePromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LAME_URL;
      s.onload = () => (window.lamejs ? resolve() : reject(new Error("MP3 encoder didn't load")));
      s.onerror = () => { lamePromise = null; reject(new Error("Couldn't load the MP3 encoder. Check your internet.")); };
      document.head.appendChild(s);
    });
  }
  return lamePromise;
}

/** Encode mono audio as an MP3 file (Blob). */
export async function encodeMp3(pcm, sr = SR, kbps = 64) {
  await loadLame();
  const enc = new window.lamejs.Mp3Encoder(1, sr, kbps);
  const i16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-1, Math.min(1, pcm[i])) * 32767;
  const parts = [];
  const step = 1152 * 8;
  for (let i = 0; i < i16.length; i += step) {
    const b = enc.encodeBuffer(i16.subarray(i, i + step));
    if (b.length) parts.push(new Uint8Array(b));
    if ((i / step) % 20 === 0) await new Promise((r) => setTimeout(r));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: "audio/mpeg" });
}
