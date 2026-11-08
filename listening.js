import {
  ref, set, remove, onValue, query, orderByChild, push, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { bootTeacher, requireTeacher, showTeacherChip, withEmu, escapeHtml, $ } from "./common.js?v=0.11.0";
import { VOICES, SOUNDS, parseScript, makeAudio, encodeMp3 } from "./tts.js?v=0.11.0";

const { auth, db } = await bootTeacher();
const user = await requireTeacher(auth);
const uid = user.uid;
showTeacherChip(auth, user, $("#me"));
$("#toClass").href = withEmu("host.html");
$("#toHistory").href = withEmu("history.html");

const script = $("#script");
const langSel = $("#lang");
langSel.innerHTML = Object.entries(VOICES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("");

let currentId = null;      // id of the saved script being edited (null = not saved yet)
let busy = false;
let audioUrl = null;

// ── Examples (the same structure as a real listening test) ───────────
const EXAMPLES = {
  zh: `欢迎参加听力考试
*2*
A: 今天的天气真不错
B: 是啊，太阳阳光明媚
问题：今天的天气怎么样？ *p1* *d*
*2*`,
  en: `Welcome to the listening test.
*2*
A: What's the weather like today?
B: It's sunny and warm.
Question: What's the weather like today? *p1* *d*
*2*`,
  fr: `Bienvenue à l'examen d'écoute.
*2*
A : Quel temps fait-il aujourd'hui ?
B : Il fait beau et chaud.
Question : Quel temps fait-il aujourd'hui ? *p1* *d*
*2*`,
};

// ── Editing helpers ──────────────────────────────────────────────────
function replaceRange(start, end, text, caret) {
  script.focus();
  script.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, text)) script.setRangeText(text, start, end, "end");   // execCommand keeps Undo working
  const pos = caret ?? start + text.length;
  script.setSelectionRange(pos, pos);
  onEdit();
}

/** Insert a tag at the cursor, with a space on each side if it would touch text. */
function insertTag(tag) {
  const v = script.value, s = script.selectionStart, e = script.selectionEnd;
  const before = v[s - 1], after = v[e];
  const pre = s > 0 && !/\s/.test(before) ? " " : "";
  const post = e < v.length && !/\s/.test(after) ? " " : "";
  replaceRange(s, e, pre + tag + post);
}

const lineStart = (v, i) => v.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (v, i) => { const n = v.indexOf("\n", i); return n < 0 ? v.length : n; };

/** Put *2* before and after the selected lines (or the current line). */
function readTwice() {
  const v = script.value;
  let s = script.selectionStart, e = script.selectionEnd;
  const a = lineStart(v, s);
  const b = lineEnd(v, e > s && v[e - 1] === "\n" ? e - 1 : e);
  const block = v.slice(a, b);
  const text = `*2*\n${block}${block && !block.endsWith("\n") ? "\n" : ""}*2*`;
  replaceRange(a, b, text, block ? a + text.length : a + 3);
}

/** Start the current line with "A: " or "B: " (replacing an existing label). */
function setVoice(label) {
  const v = script.value, s = script.selectionStart;
  const a = lineStart(v, s), b = lineEnd(v, s);
  const line = v.slice(a, b);
  const m = line.match(/^\s*(A|B|女|男)\s*[:：]\s*/i);
  const cleaned = m ? line.slice(m[0].length) : line;
  replaceRange(a, b, `${label}: ${cleaned}`);
}

$("#tools").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "pause") insertTag(`*p${$("#pauseSel").value}*`);
  else if (act === "sfx") insertTag(`*${b.dataset.s}*`);
  else if (act === "twice") readTwice();
  else if (act === "voice") setVoice(b.dataset.v);
  else if (act === "example") {
    if (script.value.trim() && !confirm("Replace the script with the example?")) return;
    script.value = EXAMPLES[langSel.value] || EXAMPLES.zh;
    if (!$("#title").value.trim()) $("#title").value = ({ zh: "Example – weather", en: "Example – weather", fr: "Exemple – la météo" })[langSel.value];
    onEdit();
  } else if (act === "new") {
    if (script.value.trim() && !confirm("Start a new script? Anything not saved will be cleared.")) return;
    newScript();
  }
};

function newScript() {
  currentId = null;
  $("#title").value = "";
  script.value = "";
  hideResult();
  renderSaved();
  onEdit();
}

// ── Live summary and outline ─────────────────────────────────────────
function onEdit() {
  const p = parseScript(script.value);
  const st = p.stats;
  const bits = [`${st.lines} line${st.lines === 1 ? "" : "s"}`];
  if (st.repeats) bits.push(`${st.repeats} repeated section${st.repeats === 1 ? "" : "s"}`);
  if (st.pauses) bits.push(`${st.pauses} pause${st.pauses === 1 ? "" : "s"}`);
  if (st.sounds) bits.push(`${st.sounds} sound${st.sounds === 1 ? "" : "s"}`);
  $("#summary").textContent = st.lines || st.pauses || st.sounds ? bits.join(" · ") : "";
  const w = $("#warnings");
  w.classList.toggle("hidden", !p.warnings.length);
  w.innerHTML = p.warnings.map((x) => `⚠️ ${escapeHtml(x)}`).join("<br>");
  $("#outline").innerHTML = outline(p.items) || `<span class="muted">Nothing yet.</span>`;
  $("#bLabel").textContent = ((VOICES[langSel.value] || VOICES.zh).b.label || "man").toLowerCase().replace(/\s*\(.*\)/, "");
}

function outline(items) {
  return items.map((it) => {
    if (it.t === "say") return `<div class="o-say ${it.voice}"><b>${it.voice.toUpperCase()}</b> ${escapeHtml(it.text)}</div>`;
    if (it.t === "pause") return `<div class="o-fx">⏸ pause ${it.sec} s</div>`;
    if (it.t === "sfx") return `<div class="o-fx">🔔 ${SOUNDS[it.name] || it.name}</div>`;
    return `<div class="o-rep"><div class="o-fx">🔁 read ${it.n} times</div>${outline(it.items)}</div>`;
  }).join("");
}

script.addEventListener("input", onEdit);
langSel.addEventListener("change", onEdit);
script.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); make(); } });

// ── Making the audio ─────────────────────────────────────────────────
function hideResult() {
  $("#result").classList.add("hidden");
  $("#player").pause();
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
}
function setBusy(on) {
  busy = on;
  $("#make").disabled = on;
  $("#make").textContent = on ? "Making…" : "🎧 Make audio";
}
function showProgress(text, pct) {
  $("#progress").classList.remove("hidden");
  $("#progressText").textContent = text;
  $("#bar").style.width = (pct == null ? 100 : pct) + "%";
  $("#bar").classList.toggle("indeterminate", pct == null);
}

const safeName = () => ($("#title").value.trim() || "listening").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

async function make() {
  if (busy) return;
  $("#error").classList.add("hidden");
  hideResult();
  const parsed = parseScript(script.value);
  setBusy(true);
  showProgress("Getting ready…", null);
  try {
    const voiceNames = { a: "woman", b: "man" };
    const audio = await makeAudio(parsed, {
      lang: langSel.value,
      speed: +$("#speed").value || 1,
      lineGap: Math.max(0, +$("#lineGap").value || 0),
      repeatGap: Math.max(0, +$("#repeatGap").value || 0),
    }, (p) => {
      if (p.phase === "voice") showProgress(`Downloading the voice… ${p.pct}% (first time only)`, p.pct);
      else if (p.phase === "speak") showProgress(`Reading line ${p.done} of ${p.total}…`, Math.round((p.done / p.total) * 100));
      else if (p.phase === "mix") showProgress("Putting the audio together…", null);
    });
    showProgress("Making the MP3 file…", null);
    const blob = await encodeMp3(audio.pcm, audio.sr);
    audioUrl = URL.createObjectURL(blob);
    $("#player").src = audioUrl;
    const dl = $("#download");
    dl.href = audioUrl;
    dl.download = safeName() + ".mp3";
    $("#resInfo").textContent = `${fmtTime(audio.seconds)} · ${(blob.size / 1048576).toFixed(2)} MB · MP3`;
    $("#result").classList.remove("hidden");
    $("#progress").classList.add("hidden");
    $("#result").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    console.error(e);
    $("#progress").classList.add("hidden");
    $("#error").textContent = /empty/i.test(e.message) ? e.message
      : "Couldn't make the audio: " + (e.message || "something went wrong") + ". Check your internet connection and try again.";
    $("#error").classList.remove("hidden");
  } finally { setBusy(false); }
}
$("#make").onclick = make;

// ── Saved scripts (kept on the teacher's account) ────────────────────
let saved = {};

onValue(query(ref(db, `teachers/${uid}/listening`), orderByChild("updatedAt")), (s) => {
  saved = s.val() || {};
  renderSaved();
});

const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

function renderSaved() {
  const ids = Object.keys(saved).sort((a, b) => (saved[b].updatedAt || 0) - (saved[a].updatedAt || 0));
  $("#saved").innerHTML = ids.length ? ids.map((id) => {
    const s = saved[id];
    return `<li class="${id === currentId ? "on" : ""}" data-id="${escapeHtml(id)}">
      <button class="ls-open" data-act="open"><span class="ls-t hanzi">${escapeHtml(s.title || "Untitled")}</span>
        <span class="muted">${escapeHtml(VOICES[s.lang]?.name.split(" ")[0] || "")} · ${fmtDate(s.updatedAt)}</span></button>
      <button class="ls-del" data-act="del" title="Delete this script">🗑</button></li>`;
  }).join("") : `<li class="muted">No saved scripts yet. Write one and click <b>Save script</b>.</li>`;
}

$("#saved").onclick = (e) => {
  const li = e.target.closest("li[data-id]");
  const act = e.target.closest("button")?.dataset.act;
  if (!li || !act) return;
  const id = li.dataset.id, s = saved[id];
  if (!s) return;
  if (act === "del") {
    if (!confirm(`Delete “${s.title || "Untitled"}”? This can't be undone.`)) return;
    remove(ref(db, `teachers/${uid}/listening/${id}`));
    if (currentId === id) currentId = null;
    return;
  }
  if (script.value.trim() && id !== currentId && !confirm("Open this script? Anything not saved will be replaced.")) return;
  currentId = id;
  $("#title").value = s.title || "";
  script.value = s.script || "";
  langSel.value = VOICES[s.lang] ? s.lang : "zh";
  $("#speed").value = String(s.speed ?? 1);
  if (![...$("#speed").options].some((o) => o.value === $("#speed").value)) $("#speed").value = "1";
  $("#lineGap").value = s.lineGap ?? 0.7;
  $("#repeatGap").value = s.repeatGap ?? 2;
  hideResult();
  renderSaved();
  onEdit();
};

$("#save").onclick = async () => {
  const text = script.value;
  if (!text.trim()) { $("#saveNote").textContent = "Write a script first."; return; }
  const title = $("#title").value.trim() || "Untitled";
  const id = currentId || push(ref(db, `teachers/${uid}/listening`)).key;
  $("#save").disabled = true;
  try {
    await set(ref(db, `teachers/${uid}/listening/${id}`), {
      title: title.slice(0, 100), script: text.slice(0, 20000), lang: langSel.value,
      speed: +$("#speed").value || 1, lineGap: Math.max(0, +$("#lineGap").value || 0), repeatGap: Math.max(0, +$("#repeatGap").value || 0),
      updatedAt: serverTimestamp(),
    });
    currentId = id;
    $("#saveNote").textContent = "Saved ✓";
    setTimeout(() => { $("#saveNote").textContent = ""; }, 2500);
  } catch (e) {
    console.error(e);
    $("#saveNote").textContent = "Couldn't save. Check your internet and try again.";
  } finally { $("#save").disabled = false; }
};

onEdit();
