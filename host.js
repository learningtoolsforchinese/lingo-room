import {
  ref, get, set, update, remove, push, onValue, onChildAdded, onChildChanged, onChildRemoved,
  serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  bootTeacher, requireTeacher, showTeacherChip, withEmu, escapeHtml, toPinyin, LANGS, $,
  parseInk, inkSvg, inputsOf, isInkOnly,
} from "./common.js?v=0.10.0";

const POINTS = 1000; // points for each word the teacher marks correct

const LS = { pin: "lingoroom.hostPin", list: "lingoroom.wordList", idx: "lingoroom.wordIdx", py: "lingoroom.boardPinyin" };
const ls = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ── Teacher sign-in (Google) ─────────────────────────────────────────
const { auth, db } = await bootTeacher();
const user = await requireTeacher(auth);
const uid = user.uid;
showTeacherChip(auth, user, $("#me"));

// ── Room: resume the teacher's last room, or create a new one ──────────
function defaultMeta() {
  return {
    lang: "zh-CN", prompt: "", promptPinyin: "", open: true, showPinyin: true,
    inputs: { speak: true, type: false, write: false }, createdAt: serverTimestamp(),
  };
}

async function resumeOrCreate() {
  // The teacher's current room is saved on their account, so it also comes back on another computer.
  const saved = (await get(ref(db, `teachers/${uid}/room`)).catch(() => null))?.val() || ls.get(LS.pin);
  if (saved) {
    try {
      const s = await get(ref(db, `rooms/${saved}/hostUid`));
      if (s.val() === uid) return saved;
    } catch { /* not ours / gone */ }
  }
  for (let i = 0; i < 15; i++) {
    const p = String(Math.floor(100000 + Math.random() * 900000));
    if ((await get(ref(db, `rooms/${p}/meta`))).exists()) continue;
    try {
      await set(ref(db, `rooms/${p}`), { hostUid: uid, meta: defaultMeta() });
      await set(ref(db, `teachers/${uid}/room`), p).catch((e) => console.warn(e));
      ls.set(LS.pin, p);
      return p;
    } catch (e) { console.warn("PIN taken, retrying", e); }
  }
  throw new Error("Could not create a room");
}

const pin = await resumeOrCreate();
const roomRef = ref(db, `rooms/${pin}`);
const r = (path) => ref(db, `rooms/${pin}/${path}`);

// ── State ────────────────────────────────────────────────────────────
let meta = defaultMeta();
const players = new Map();   // uid → { name, joinedAt, online }
const said = new Map();      // uid → [{ id, text }] newest first
const live = new Map();      // uid → text the student is saying right now
const marks = new Map();     // uid → { wordId: true (correct) | false (incorrect) }
let scores = {};             // uid → points
let boardPinyin = ls.get(LS.py, "1") === "1";

const grid = $("#grid");

// ── Join screen ──────────────────────────────────────────────────────
const joinBase = withEmu(new URL("./", location.href).toString());
const joinWithPin = new URL(joinBase); joinWithPin.searchParams.set("pin", pin);
$("#joinUrl").textContent = joinBase.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/\?emu=1$/, " (emulator)");
$("#pinBig").textContent = pin;
$("#pinMini").textContent = pin;
{
  const qr = qrcode(0, "M");
  qr.addData(joinWithPin.toString());
  qr.make();
  $("#qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
}
$("#hideJoin").onclick = () => $("#joinOverlay").classList.add("hidden");
$("#showJoin").onclick = () => $("#joinOverlay").classList.remove("hidden");

function renderJoinNames() {
  const list = [...players.values()].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  $("#joinNames").innerHTML = list.map((p) => `<span>${escapeHtml(p.name)}</span>`).join("");
}

// ── Controls ─────────────────────────────────────────────────────────
const langSel = $("#lang");
langSel.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");

function saveMeta(patch) {
  Object.assign(meta, patch);
  renderControls(); renderBanner(); renderSpot();
  return update(r("meta"), patch);
}

function showPrompt(word) {
  word = (word || "").trim();
  $("#promptInput").value = word;
  saveMeta({ prompt: word, promptPinyin: word ? toPinyin(word) : "" });
}
$("#showPrompt").onclick = () => showPrompt($("#promptInput").value);
$("#promptInput").onkeydown = (e) => { if (e.key === "Enter") showPrompt(e.target.value); };
$("#clearPrompt").onclick = () => showPrompt("");

function wordList() {
  return (ls.get(LS.list, "") || "").split("\n").map((s) => s.trim()).filter(Boolean);
}
$("#nextWord").onclick = () => {
  const list = wordList();
  if (!list.length) { openList(); return; }
  let i = parseInt(ls.get(LS.idx, "0"), 10) || 0;
  if (i >= list.length) i = 0;
  ls.set(LS.idx, String(i + 1));
  showPrompt(list[i]);
};
function openList() { $("#listText").value = ls.get(LS.list, ""); $("#listDlg").showModal(); }
$("#editList").onclick = openList;
$("#listCancel").onclick = () => $("#listDlg").close();
$("#listSave").onclick = () => { ls.set(LS.list, $("#listText").value); ls.set(LS.idx, "0"); $("#listDlg").close(); };

$("#openMic").onchange = (e) => saveMeta({ open: e.target.checked });
// One answer type at a time; students' screens switch to it straight away.
$("#inputSeg").onclick = (e) => {
  const k = e.target.closest("button")?.dataset.k;
  if (k) saveMeta({ inputs: { speak: k === "speak", type: k === "type", write: k === "write" } });
};
$("#stuPy").onchange = (e) => saveMeta({ showPinyin: e.target.checked });
langSel.onchange = (e) => saveMeta({ lang: e.target.value });
$("#showPy").onchange = (e) => { boardPinyin = e.target.checked; ls.set(LS.py, boardPinyin ? "1" : "0"); renderAll(); };

$("#clearBoard").onclick = () => {
  if (!confirm("Clear everyone's words from the board? Scores are kept.")) return;
  update(roomRef, { said: null, answers: null, marks: null });
  said.clear(); live.clear(); marks.clear();
  renderAll();
};
$("#resetScores").onclick = () => {
  if (!confirm("Reset everyone's score to 0? The ✓/✗ marks are removed too.")) return;
  update(roomRef, { scores: null, marks: null });
  scores = {}; marks.clear();
  renderAll();
};
$("#fullscreen").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
};
$("#historyLink").href = withEmu("history.html");
$("#listeningLink").href = withEmu("listening.html");

// ── End class: save to history, then close the room ──────────────────
function defaultClassName() {
  const d = new Date();
  return "Class · " + d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Everything worth keeping about this class, from what the teacher's screen already has. */
function classSnapshot(name) {
  const students = {};
  let words = 0;
  for (const [id, p] of players) {
    const m = marks.get(id) || {};
    const list = {};
    let correct = 0, incorrect = 0;
    for (const it of said.get(id) || []) {
      const w = { text: it.text };
      if (it.ink?.length) w.ink = JSON.stringify(it.ink);
      if (m[it.id] === true) { w.mark = true; correct++; }
      if (m[it.id] === false) { w.mark = false; incorrect++; }
      list[it.id] = w;
      words++;
    }
    students[id] = { name: p.name, score: scores[id] || 0, correct, incorrect, words: list };
  }
  const ranked = Object.values(students).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const summary = {
    name: name.slice(0, 80), pin,
    startedAt: typeof meta.createdAt === "number" ? meta.createdAt : Date.now(),
    endedAt: serverTimestamp(),
    students: ranked.length, words,
    top: ranked.filter((s) => s.score > 0).slice(0, 3).map((s) => ({ name: s.name, score: s.score })),
  };
  return { summary, detail: { students } };
}

$("#endRoom").onclick = () => {
  $("#className").value = defaultClassName();
  $("#endErr").textContent = "";
  $("#endDlg").showModal();
  $("#className").select();
};
$("#endCancel").onclick = () => $("#endDlg").close();
$("#endConfirm").onclick = async () => {
  const btn = $("#endConfirm");
  btn.disabled = true;
  try {
    const name = $("#className").value.trim() || defaultClassName();
    const { summary, detail } = classSnapshot(name);
    const classId = push(ref(db, `teachers/${uid}/classes`)).key;
    await update(ref(db, `teachers/${uid}`), { [`classes/${classId}`]: summary, [`classDetails/${classId}`]: detail, room: null });
    await remove(roomRef);
    ls.del(LS.pin);
    $("#endDlg").close();
    document.body.innerHTML = `
      <div class="stu"><div class="stu-center" style="text-align:center">
        <h1>Class ended 再见！</h1>
        <p class="muted">“${escapeHtml(name)}” was saved to your history.</p>
        <a class="btn wide" style="text-align:center;text-decoration:none" href="${withEmu("history.html")}#${classId}">📚 View this class in History</a>
        <button class="btn primary wide" onclick="location.reload()">Start a new class</button>
      </div></div>`;
  } catch (e) {
    console.error(e);
    $("#endErr").textContent = "Couldn't save the class. Check your internet and try again.";
  } finally { btn.disabled = false; }
};

function renderControls() {
  $("#openMic").checked = !!meta.open;
  const current = inputsOf(meta)[0];
  document.querySelectorAll("#inputSeg button").forEach((b) => b.classList.toggle("on", b.dataset.k === current));
  $("#stuPy").checked = !!meta.showPinyin;
  $("#showPy").checked = boardPinyin;
  langSel.value = meta.lang || "zh-CN";
  if (meta.prompt && document.activeElement !== $("#promptInput")) $("#promptInput").value = meta.prompt;
}

// ── Marking ✓ / ✗ ────────────────────────────────────────────────────
/** Mark a word correct (true) or incorrect (false). Clicking the same mark again removes it. */
function mark(id, wordId, value) {
  if (!id || !wordId) return;
  const m = { ...(marks.get(id) || {}) };
  const before = m[wordId];
  const after = before === value ? null : value;
  const delta = (after === true ? 1 : 0) - (before === true ? 1 : 0);
  if (after === null) delete m[wordId]; else m[wordId] = after;
  marks.set(id, m);
  const upd = { [`marks/${id}/${wordId}`]: after };
  if (delta) {
    upd[`scores/${id}`] = increment(delta * POINTS);
    scores[id] = (scores[id] || 0) + delta * POINTS;
  }
  update(roomRef, upd);
  renderCard(id); renderLeaders();
}

grid.addEventListener("click", (e) => {
  const mk = e.target.closest(".mk");
  if (mk) {
    const li = mk.closest(".item");
    mark(li.dataset.uid, li.dataset.id, mk.dataset.v === "1");
    return;
  }
  if (e.target.closest(".kick")) return;
  const card = e.target.closest(".card");
  if (card) openSpot(card.id.slice(2), false);
});

// ── Rendering ────────────────────────────────────────────────────────
function cardEl(id) {
  let el = document.getElementById("c-" + id);
  if (el) return el;
  el = document.createElement("div");
  el.className = "card";
  el.id = "c-" + id;
  el.innerHTML = `<div class="card-head"><span class="dot"></span><span class="nm"></span><span class="score"></span></div>
    <ul class="list"></ul>
    <button class="kick" title="Remove student">✕ remove</button>`;
  el.querySelector(".kick").onclick = () => {
    const p = players.get(id);
    if (!confirm(`Remove ${p?.name || "this student"} from the room?`)) return;
    update(roomRef, {
      [`players/${id}`]: null, [`answers/${id}`]: null, [`said/${id}`]: null, [`marks/${id}`]: null, [`scores/${id}`]: null,
    });
  };
  // keep cards ordered by join time
  const mine = players.get(id)?.joinedAt || 0;
  const after = [...grid.querySelectorAll(".card")].find((c) => (players.get(c.id.slice(2))?.joinedAt || 0) > mine);
  grid.insertBefore(el, after || null);
  return el;
}

const pyHtml = (text) => boardPinyin && text ? `<div class="it-py">${escapeHtml(toPinyin(text))}</div>` : "";

function renderCard(id, flash = false) {
  const p = players.get(id);
  if (!p) { document.getElementById("c-" + id)?.remove(); return; }
  grid.querySelector(".empty")?.remove();
  const el = cardEl(id);
  const liveText = live.get(id) || "";
  const items = said.get(id) || [];
  const m = marks.get(id) || {};

  el.querySelector(".nm").textContent = p.name;
  el.querySelector(".score").textContent = scores[id] ? `⭐ ${scores[id]}` : "";
  el.classList.toggle("offline", p.online === false);
  el.classList.toggle("speaking", !!liveText);

  let html = liveText
    ? `<li class="item live"><div class="it-main"><div class="it-text hanzi">${liveText === "✍" ? "✍️ writing…" : escapeHtml(liveText)}</div>${liveText === "✍" ? "" : pyHtml(liveText)}</div><span class="typing">●●●</span></li>`
    : "";
  html += items.map((it) => {
    const st = m[it.id];
    return `<li class="item ${st === true ? "ok" : st === false ? "no" : ""}" data-uid="${escapeHtml(id)}" data-id="${escapeHtml(it.id)}">
      <div class="it-main">${isInkOnly(it)
        ? `<div class="it-ink">${inkSvg(it.ink, 120)}</div>`
        : `${it.ink.length ? `<div class="it-ink">${inkSvg(it.ink, 52)}</div>` : ""}<div class="it-text hanzi">${escapeHtml(it.text)}</div>${pyHtml(it.text)}`}</div>
      <div class="it-btns"><button class="mk ok" data-v="1" title="Correct (+${POINTS})">✓</button><button class="mk no" data-v="0" title="Incorrect">✗</button></div>
    </li>`;
  }).join("");
  el.querySelector(".list").innerHTML = html || `<li class="item empty-item">No words yet</li>`;

  if (flash) { el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 180); }
  if (id === spotId || spotMode === "cloud") renderSpot();
}

function renderBanner() {
  $("#bLbl").textContent = { speak: "Say this", type: "Type this", write: "Write this" }[inputsOf(meta)[0]];
  $("#banner").classList.toggle("hidden", !meta.prompt);
  $("#bWord").textContent = meta.prompt || "";
  $("#bPy").textContent = boardPinyin && meta.prompt ? meta.promptPinyin || toPinyin(meta.prompt) : "";
}

function renderLeaders() {
  const rows = Object.entries(scores)
    .filter(([id, pts]) => players.has(id) && pts > 0)
    .sort((a, b) => b[1] - a[1] || players.get(a[0]).name.localeCompare(players.get(b[0]).name));
  const medal = ["🥇", "🥈", "🥉"];
  $("#leaders").innerHTML = rows.length
    ? rows.map(([id, pts], i) => `<li><span class="rank">${medal[i] || i + 1}</span>
        <span class="lname">${escapeHtml(players.get(id).name)}</span>
        <span class="lcount">✓ ${Math.round(pts / POINTS)}</span><b>${pts}</b></li>`).join("")
    : `<li class="muted">Mark words ✓ to give points</li>`;
}

function renderCount() {
  $("#count").textContent = [...players.values()].filter((p) => p.online !== false).length;
}

function renderAll() {
  for (const id of players.keys()) renderCard(id);
  if (!players.size && !grid.querySelector(".empty")) grid.innerHTML = `<div class="empty">Waiting for students to join…</div>`;
  renderBanner(); renderLeaders(); renderCount(); renderJoinNames(); renderSpot();
}

// ── Spotlight: one student's words, full screen ──────────────────────
let spotId = null;         // student shown in the spotlight (null = closed)
let spotFollow = true;     // jump to whoever spoke last
let lastSpeaker = null;
let spotEnteredFs = false;
let spotMode = "cloud";    // "cloud" = all students' words, "student" = one student
const spot = $("#spot");

const orderedIds = () => [...players.entries()]
  .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0)).map(([id]) => id);

function openSpot(id, follow) {
  spotMode = id ? "student" : "cloud";
  spotFollow = follow;
  spotId = id || lastSpeaker || orderedIds()[0] || "";
  spot.classList.remove("hidden");
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().then(() => { spotEnteredFs = true; }).catch(() => {});
  }
  renderSpot();
}
function closeSpot() {
  spotId = null;
  spot.classList.add("hidden");
  if (spotEnteredFs && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  spotEnteredFs = false;
}
function setSpotMode(mode) {
  spotMode = mode;
  if (mode === "student" && !players.has(spotId)) spotId = lastSpeaker || orderedIds()[0] || "";
  renderSpot();
}
function stepSpot(dir) {
  const ids = orderedIds();
  if (!ids.length) return;
  spotMode = "student";
  spotFollow = false;
  const i = ids.indexOf(spotId);
  spotId = ids[(i + dir + ids.length) % ids.length];
  renderSpot();
}

/** Biggest font size that fits the text in the middle of the screen, trying 1–8 lines. */
function fitSize(text) {
  // Chinese/Japanese characters are about 1em wide, Latin letters and spaces about 0.6em.
  const units = [...text].reduce((n, c) => n + (/[⺀-鿿豈-﫿＀-￯]/.test(c) ? 1 : 0.6), 0) || 1;
  const W = window.innerWidth * 0.9, H = window.innerHeight * 0.45;
  let best = 28;
  for (let lines = 1; lines <= 8; lines++) {
    const size = Math.min((W / Math.ceil(units / lines)) * 0.92, H / (lines * 1.18));
    best = Math.max(best, size);
  }
  return Math.floor(best);
}

function renderSpot() {
  if (spotId === null || spot.classList.contains("hidden")) return;
  spot.dataset.mode = spotMode;
  document.querySelectorAll("#spotModeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === spotMode));
  if (spotMode === "cloud") {
    spot.classList.remove("correct", "wrong", "offline");
    renderCloud();
    return;
  }
  $("#spotFollow").checked = spotFollow;
  const p = players.get(spotId);
  const liveText = live.get(spotId) || "";
  const items = said.get(spotId) || [];
  const m = marks.get(spotId) || {};
  const latest = items[0];
  const text = liveText || latest?.text || "";
  const st = !liveText && latest ? m[latest.id] : undefined;

  $("#spotName").textContent = p ? p.name : (players.size ? "—" : "Waiting for students…");
  $("#spotScore").textContent = p && scores[spotId] ? `⭐ ${scores[spotId]}` : "";
  $("#spotPrompt").innerHTML = meta.prompt ? `Task: <b>${escapeHtml(meta.prompt)}</b>` : "";
  spot.classList.toggle("offline", p?.online === false);
  spot.classList.toggle("correct", st === true);
  spot.classList.toggle("wrong", st === false);

  const ink = !liveText && latest?.ink?.length ? latest.ink : [];
  const inkOnly = !liveText && isInkOnly(latest);
  const inkPx = ink.length ? Math.floor(Math.min(window.innerHeight * (inkOnly ? 0.6 : 0.42), (window.innerWidth * 0.86) / ink.length - 20)) : 0;
  $("#spotInk").innerHTML = ink.length ? inkSvg(ink, inkPx) : "";
  const tEl = $("#spotText");
  tEl.classList.toggle("hidden", inkOnly);
  tEl.textContent = liveText === "✍" ? "✍️ writing…" : text || "…";
  // with handwriting, any text is a smaller caption under the drawing
  tEl.style.fontSize = (ink.length ? Math.min(fitSize(text), window.innerHeight * 0.1) : fitSize(tEl.textContent || "……")) + "px";
  tEl.classList.toggle("interim", !!liveText);
  tEl.classList.toggle("waiting", !text);
  $("#spotPy").textContent = boardPinyin && text && !inkOnly && liveText !== "✍" ? toPinyin(text) : "";

  const marksEl = $("#spotMarks");
  marksEl.classList.toggle("hidden", !(!liveText && latest));
  marksEl.dataset.id = latest?.id || "";
  marksEl.querySelector(".ok").classList.toggle("on", st === true);
  marksEl.querySelector(".no").classList.toggle("on", st === false);
  marksEl.querySelector(".ok").textContent = st === true ? `✓ Correct +${POINTS}` : "✓ Correct";

  const earlier = items.slice(liveText ? 0 : 1, 6);
  $("#spotPrevList").innerHTML = earlier.map((it) =>
    `<span class="${m[it.id] === true ? "ok" : m[it.id] === false ? "no" : ""}">${isInkOnly(it) ? inkSvg(it.ink, 34, "ink ink-chip") : escapeHtml(it.text)}${m[it.id] === true ? " ✓" : m[it.id] === false ? " ✗" : ""}</span>`).join("");
}

// ── Word cloud: every student's words on one screen ──────────────────
const CLOUD_MAX = 80;           // show at most this many different words (the most recent ones)
const seenCloud = new Set();    // words already shown, so only new ones pop in
let cloudSig = "";
let cloudFrame = 0;

const cloudKey = (t) => String(t).replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
function colorOf(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 6;
}

/** Group everyone's words: same word from several students → one bigger word with all their names. */
function cloudWords() {
  const map = new Map();
  let latestId = "";
  for (const [uid, items] of said) {
    const p = players.get(uid);
    if (!p) continue;
    for (const it of items) {
      const inkOnly = isInkOnly(it);
      const key = inkOnly ? "ink:" + it.id : cloudKey(it.text);   // every drawing stays separate
      if (!key) continue;
      let w = map.get(key);
      if (!w) { w = { key, text: it.text, ink: inkOnly ? it.ink : null, names: [], uids: [], count: 0, first: it.id, last: it.id }; map.set(key, w); }
      w.count++;
      if (!w.uids.includes(uid)) { w.uids.push(uid); w.names.push(p.name); }
      if (it.id < w.first) { w.first = it.id; w.text = it.text; }
      if (it.id > w.last) w.last = it.id;
      if (it.id > latestId) latestId = it.id;
    }
  }
  // keep the most recent words, then lay them out in the order they were first said
  const words = [...map.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, CLOUD_MAX)
    .sort((a, b) => (a.first < b.first ? -1 : 1));
  for (const w of words) {
    w.scale = Math.min(3, 1 + 0.6 * Math.log2(w.count));   // said 1× → 1, 2× → 1.6, 4× → 2.2 …
    w.latest = w.last === latestId;
  }
  return words;
}

function renderCloud() {
  $("#cloudPin").textContent = pin;
  $("#cloudUrl").textContent = $("#joinUrl").textContent;
  $("#cloudTitle").innerHTML = meta.prompt
    ? `${escapeHtml(meta.prompt)}${boardPinyin ? `<span class="py">${escapeHtml(meta.promptPinyin || toPinyin(meta.prompt))}</span>` : ""}`
    : "Our answers · 我们的回答";
  const liveNow = [...live.entries()].filter(([id, t]) => t && players.has(id));
  $("#cloudLive").innerHTML = liveNow.map(([id, t]) =>
    `<span>🎤 <b>${escapeHtml(players.get(id).name)}</b>: ${escapeHtml(t)}</span>`).join("");
  // short debounce: many updates arriving together → one layout
  clearTimeout(cloudFrame);
  cloudFrame = setTimeout(layoutCloud, 40);
}

function layoutCloud() {
  const box = $("#cloud");
  const words = cloudWords();
  let total = 0;
  for (const items of said.values()) total += items.length;
  $("#cloudStats").textContent = `👤 ${[...players.values()].filter((p) => p.online !== false).length} · 💬 ${total}`;

  const W = box.clientWidth, H = box.clientHeight;
  const sig = W + "x" + H + "|" + boardPinyin + "|" + words.map((w) => w.key + ":" + w.count + ":" + w.names.join(",") + (w.latest ? "*" : "")).join("|");
  if (sig === cloudSig) return;
  cloudSig = sig;
  if (!words.length) { box.innerHTML = `<div class="cloud-empty">Words will appear here as students speak…</div>`; return; }

  box.innerHTML = words.map((w, i) => {
    const names = w.names.length > 3 ? `${w.names.slice(0, 3).join(", ")} +${w.names.length - 3}` : w.names.join(", ");
    const isNew = !seenCloud.has(w.key);
    return `<div class="cw c${colorOf(w.key)}${isNew ? " new" : ""}${w.latest ? " latest" : ""}" data-i="${i}" title="${escapeHtml(w.names.join(", "))}">
      <div class="cw-t hanzi">${w.ink ? inkSvg(w.ink, 0, "ink cw-ink") : escapeHtml(w.text)}</div><div class="cw-n">${escapeHtml(names)}${w.count > 1 ? ` · ×${w.count}` : ""}</div></div>`;
  }).join("");
  words.forEach((w) => seenCloud.add(w.key));
  const els = [...box.children];

  // Try a big font first; shrink until every word fits without overlapping.
  let base = Math.min(H / 4, W / 7);
  for (let attempt = 0; attempt < 16; attempt++, base *= 0.86) {
    els.forEach((el, i) => { el.style.fontSize = Math.max(14, base * words[i].scale) + "px"; });
    const sizes = els.map((el) => [el.offsetWidth, el.offsetHeight]);
    // Place the biggest words first so they sit in the middle.
    const order = words.map((_, i) => i).sort((a, b) => words[b].scale - words[a].scale || a - b);
    const placed = [];
    const rects = [];
    let ok = true;
    for (const i of order) {
      const spotRect = findCloudSpot(sizes[i][0], sizes[i][1], rects, W, H);
      if (!spotRect) { ok = false; break; }
      rects.push(spotRect);
      placed[i] = spotRect;
    }
    if (ok || attempt === 15) {
      els.forEach((el, i) => {
        const p = placed[i] || { x: Math.random() * Math.max(0, W - sizes[i][0]), y: Math.random() * Math.max(0, H - sizes[i][1]) };
        el.style.left = p.x + "px";
        el.style.top = p.y + "px";
      });
      return;
    }
  }
}

/** Walk out from the centre on a spiral until there's a free spot for a w×h box. */
function findCloudSpot(w, h, placed, W, H) {
  const pad = Math.max(6, h * 0.08);
  const cx = W / 2, cy = H / 2, stretch = Math.max(1, (W / H) * 0.9);
  const maxR = Math.hypot(W, H) / 2;
  // small steps near the middle, and steps of about 4px further out
  for (let t = 0, r = 0; r < maxR; t += Math.min(0.3, 4 / Math.max(r, 1)), r = 2.2 * t) {
    const x = cx + r * Math.cos(t) * stretch - w / 2;
    const y = cy + r * Math.sin(t) - h / 2;
    if (x < 0 || y < 0 || x + w > W || y + h > H) continue;
    if (!placed.some((p) => x < p.x + p.w + pad && x + w + pad > p.x && y < p.y + p.h + pad && y + h + pad > p.y)) {
      return { x, y, w, h };
    }
  }
  return null;
}

// Click a word → open that student's view (to mark it ✓ / ✗).
$("#cloud").onclick = (e) => {
  const el = e.target.closest(".cw");
  if (!el) return;
  const w = cloudWords()[+el.dataset.i];
  if (w) { spotId = w.uids[0]; spotFollow = false; setSpotMode("student"); }
};
$("#spotModeSeg").onclick = (e) => {
  const m = e.target.closest("button")?.dataset.mode;
  if (m) setSpotMode(m);
};

$("#spotBtn").onclick = () => openSpot(null, true);
$("#spotClose").onclick = closeSpot;
$("#spotPrev").onclick = () => stepSpot(-1);
$("#spotNext").onclick = () => stepSpot(1);
$("#spotMarks").onclick = (e) => {
  const b = e.target.closest("button");
  if (b) mark(spotId, $("#spotMarks").dataset.id, b.dataset.v === "1");
};
$("#spotFollow").onchange = (e) => {
  spotFollow = e.target.checked;
  if (spotFollow && lastSpeaker) spotId = lastSpeaker;
  renderSpot();
};
document.addEventListener("keydown", (e) => {
  if (spotId === null) return;
  if (e.target instanceof Element && e.target.closest("input, textarea, select, dialog")) return;
  const k = e.key.toLowerCase();
  if (k === "w") return setSpotMode("cloud");
  if (k === "s") return setSpotMode("student");
  if (spotMode === "cloud" && k !== "escape" && k !== "arrowright" && k !== "arrowleft") return;
  if (k === "escape") closeSpot();
  else if (k === "arrowright") stepSpot(1);
  else if (k === "arrowleft") stepSpot(-1);
  else if (k === "f") $("#spotFollow").click();
  else if (k === "c" || k === "x") {
    const id = $("#spotMarks").dataset.id;
    if (id && !$("#spotMarks").classList.contains("hidden")) mark(spotId, id, k === "c");
  }
});
window.addEventListener("resize", renderSpot);

function heardFrom(id) {
  lastSpeaker = id;
  if (spotId !== null && spotFollow) spotId = id;
}

// ── Live listeners ───────────────────────────────────────────────────
onValue(r("meta"), (s) => {
  const v = s.val();
  if (!v) return; // room deleted (End class)
  meta = v;
  renderControls(); renderBanner(); renderSpot();
});

const onPlayer = (s) => {
  players.set(s.key, s.val());
  renderCard(s.key);
  renderLeaders(); renderCount(); renderJoinNames();
};
onChildAdded(r("players"), onPlayer);
onChildChanged(r("players"), onPlayer);
onChildRemoved(r("players"), (s) => {
  players.delete(s.key); said.delete(s.key); live.delete(s.key); marks.delete(s.key);
  document.getElementById("c-" + s.key)?.remove();
  if (lastSpeaker === s.key) lastSpeaker = null;
  if (spotId === s.key) spotId = orderedIds()[0] ?? "";
  renderAll();
});

// Words each student has finished saying: said/{uid}/{pushId} = { text, at }
const onSaid = (s) => {
  const v = s.val() || {};
  const items = Object.keys(v).sort().reverse().map((id) => ({ id, text: v[id].text, ink: parseInk(v[id].ink) }));
  const grew = items.length > (said.get(s.key)?.length || 0);
  said.set(s.key, items);
  if (grew) heardFrom(s.key);
  renderCard(s.key, grew);
};
onChildAdded(r("said"), onSaid);
onChildChanged(r("said"), onSaid);
onChildRemoved(r("said"), (s) => { said.delete(s.key); renderCard(s.key); });

// What a student is saying right now (before they finish): answers/{uid} = { text, at }
const onLive = (s) => {
  const t = s.val()?.text || "";
  if (t) { live.set(s.key, t); heardFrom(s.key); } else live.delete(s.key);
  renderCard(s.key);
};
onChildAdded(r("answers"), onLive);
onChildChanged(r("answers"), onLive);
onChildRemoved(r("answers"), (s) => { live.delete(s.key); renderCard(s.key); });

const onMarks = (s) => { marks.set(s.key, s.val() || {}); renderCard(s.key); };
onChildAdded(r("marks"), onMarks);
onChildChanged(r("marks"), onMarks);
onChildRemoved(r("marks"), (s) => { marks.delete(s.key); renderCard(s.key); });

onValue(r("scores"), (s) => { scores = s.val() || {}; renderAll(); });

renderControls();
renderAll();
