import {
  ref, get, set, update, remove, onValue, onChildAdded, onChildChanged, onChildRemoved,
  serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { bootTeacher, isTeacher, signInTeacher, signOutTeacher, withEmu, escapeHtml, toPinyin, isMatch, LANGS, $ } from "./common.js";

const LS = { pin: "lingoroom.hostPin", list: "lingoroom.wordList", idx: "lingoroom.wordIdx", py: "lingoroom.boardPinyin" };
const ls = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ── Teacher sign-in (Google) ─────────────────────────────────────────
const { auth, db } = await bootTeacher();

function waitForSignIn() {
  return new Promise((resolve) => {
    $("#signIn").classList.remove("hidden");
    $("#studentLink").href = withEmu("./");
    $("#googleBtn").onclick = async () => {
      $("#signInErr").textContent = "";
      $("#googleBtn").disabled = true;
      try {
        const user = await signInTeacher(auth);
        if (user) { $("#signIn").classList.add("hidden"); resolve(user); }
      } catch (e) {
        console.error(e);
        $("#signInErr").textContent = e.code === "auth/popup-closed-by-user"
          ? "Sign-in was cancelled."
          : e.code === "auth/unauthorized-domain"
            ? "This website isn't allowed yet. Add it in Firebase → Authentication → Settings → Authorized domains."
            : "Could not sign in. Please try again.";
      } finally { $("#googleBtn").disabled = false; }
    };
  });
}

const user = isTeacher(auth.currentUser) ? auth.currentUser : await waitForSignIn();
const uid = user.uid;
{
  const meEl = $("#me");
  meEl.classList.remove("hidden");
  meEl.querySelector("span").textContent = user.displayName || user.email || "Teacher";
  meEl.title = user.email || "";
  const img = meEl.querySelector("img");
  if (user.photoURL) img.src = user.photoURL; else img.remove();
  meEl.querySelector("button").onclick = async () => {
    if (!confirm("Sign out? The room stays open. Sign in again to get back to it.")) return;
    await signOutTeacher(auth);
    location.reload();
  };
}

// ── Room: resume the teacher's last room, or create a new one ──────────
function defaultMeta() {
  return {
    lang: "zh-CN", mode: "free", target: "", targetPinyin: "", round: 0,
    open: true, showPinyin: true, acceptSound: true, createdAt: serverTimestamp(),
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
const answers = new Map();   // uid → { text, final, round, at }
const history = new Map();   // uid → [last final sentences] (free talk)
const lastHistAt = new Map();
let scores = {};             // uid → total points
let awards = {};             // uid → { points, order } for the current round
let boardPinyin = ls.get(LS.py, "1") === "1";
let unsubRound = null;
let subscribedRound = null;

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
  renderControls(); renderAll();
  return update(r("meta"), patch);
}

$("#modeSeg").onclick = (e) => {
  const m = e.target.closest("button")?.dataset.mode;
  if (m) saveMeta({ mode: m });
};
$("#openMic").onchange = (e) => saveMeta({ open: e.target.checked });
$("#stuPy").onchange = (e) => saveMeta({ showPinyin: e.target.checked });
$("#acceptSound").onchange = (e) => saveMeta({ acceptSound: e.target.checked });
langSel.onchange = (e) => saveMeta({ lang: e.target.value });
$("#showPy").onchange = (e) => { boardPinyin = e.target.checked; ls.set(LS.py, boardPinyin ? "1" : "0"); renderAll(); };

function startRound(word) {
  word = word.trim();
  if (!word) { $("#targetInput").focus(); return; }
  $("#targetInput").value = word;
  const round = (meta.round || 0) + 1;
  awards = {};
  Object.assign(meta, { mode: "target", target: word, targetPinyin: toPinyin(word), round, open: true });
  update(roomRef, {
    "meta/mode": "target", "meta/target": word, "meta/targetPinyin": meta.targetPinyin,
    "meta/round": round, "meta/open": true, answers: null,
  });
  answers.clear();
  renderControls(); renderAll();
}
$("#startRound").onclick = () => startRound($("#targetInput").value);
$("#targetInput").onkeydown = (e) => { if (e.key === "Enter") startRound(e.target.value); };

function wordList() {
  return (ls.get(LS.list, "") || "").split("\n").map((s) => s.trim()).filter(Boolean);
}
$("#nextWord").onclick = () => {
  const list = wordList();
  if (!list.length) { openList(); return; }
  let i = parseInt(ls.get(LS.idx, "0"), 10) || 0;
  if (i >= list.length) i = 0;
  ls.set(LS.idx, String(i + 1));
  startRound(list[i]);
};
function openList() { $("#listText").value = ls.get(LS.list, ""); $("#listDlg").showModal(); }
$("#editList").onclick = openList;
$("#listCancel").onclick = () => $("#listDlg").close();
$("#listSave").onclick = () => { ls.set(LS.list, $("#listText").value); ls.set(LS.idx, "0"); $("#listDlg").close(); };

$("#clearBoard").onclick = () => { remove(r("answers")); answers.clear(); history.clear(); renderAll(); };
$("#resetScores").onclick = () => {
  if (!confirm("Reset everyone's score to 0?")) return;
  update(roomRef, { scores: null, rounds: null });
  awards = {}; renderAll();
};
$("#fullscreen").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
};
$("#endRoom").onclick = async () => {
  if (!confirm("End this class? The room and all answers will be deleted.")) return;
  await remove(roomRef);
  await remove(ref(db, `teachers/${uid}/room`)).catch(() => {});
  ls.del(LS.pin);
  document.body.innerHTML = `
    <div class="stu"><div class="stu-center" style="text-align:center">
      <h1>Class ended 再见！</h1>
      <p class="muted">The room was deleted.</p>
      <button class="btn primary wide" onclick="location.reload()">Start a new class</button>
    </div></div>`;
};

function renderControls() {
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === meta.mode));
  $("#targetCtl").style.opacity = meta.mode === "target" ? 1 : 0.55;
  $("#openMic").checked = !!meta.open;
  $("#stuPy").checked = !!meta.showPinyin;
  $("#acceptSound").checked = meta.acceptSound !== false;
  $("#showPy").checked = boardPinyin;
  langSel.value = meta.lang || "zh-CN";
  if (meta.target && !$("#targetInput").value) $("#targetInput").value = meta.target;
}

// ── Scoring ──────────────────────────────────────────────────────────
function maybeAward(id, a) {
  if (meta.mode !== "target" || !meta.target || !a?.final) return;
  if (a.round !== meta.round || awards[id] || !players.has(id)) return;
  if (!isMatch(a.text, meta.target, meta.acceptSound !== false)) return;
  const order = Object.keys(awards).length;          // 0 = first correct
  const points = Math.max(500, 1000 - order * 100);  // 1000, 900, 800 … min 500
  awards[id] = { points, order: order + 1 };
  update(roomRef, {
    [`rounds/${meta.round}/${id}`]: { points, order: order + 1 },
    [`scores/${id}`]: increment(points),
  });
}

function subscribeRound(round) {
  unsubRound?.();
  unsubRound = null;
  subscribedRound = round;
  awards = {};
  if (!round) return;
  unsubRound = onValue(r(`rounds/${round}`), (s) => {
    awards = { ...(s.val() || {}), ...awards };
    renderAll();
  });
}

// ── Rendering ────────────────────────────────────────────────────────
function cardEl(id) {
  let el = document.getElementById("c-" + id);
  if (el) return el;
  el = document.createElement("div");
  el.className = "card";
  el.id = "c-" + id;
  el.innerHTML = `<div class="name"><span class="dot"></span><span class="nm"></span></div>
    <span class="badge"></span><div class="text hanzi"></div><div class="py"></div><div class="hist hanzi"></div>
    <button class="kick" title="Remove student">✕ remove</button>`;
  el.querySelector(".kick").onclick = () => {
    const p = players.get(id);
    if (!confirm(`Remove ${p?.name || "this student"} from the room?`)) return;
    update(roomRef, { [`players/${id}`]: null, [`answers/${id}`]: null, [`scores/${id}`]: null });
  };
  // keep cards ordered by join time
  const mine = players.get(id)?.joinedAt || 0;
  const after = [...grid.querySelectorAll(".card")].find((c) => (players.get(c.id.slice(2))?.joinedAt || 0) > mine);
  grid.insertBefore(el, after || null);
  return el;
}

function renderCard(id, flash = false) {
  const p = players.get(id);
  if (!p) { document.getElementById("c-" + id)?.remove(); return; }
  grid.querySelector(".empty")?.remove();
  const el = cardEl(id);
  const a = answers.get(id);
  const target = meta.mode === "target" && meta.round > 0;
  const current = a && (!target || a.round === meta.round);
  const award = target ? awards[id] : null;

  el.querySelector(".nm").textContent = p.name;
  el.classList.toggle("offline", p.online === false);
  el.classList.toggle("speaking", !!(current && !a.final && a.text));
  el.classList.toggle("correct", !!award);
  el.classList.toggle("wrong", !!(target && !award && current && a.final && a.text));

  const text = current ? a.text || "" : "";
  const tEl = el.querySelector(".text");
  tEl.textContent = text || (target ? "…" : "");
  tEl.classList.toggle("interim", !current || !a.final);
  el.querySelector(".py").textContent = boardPinyin && text ? toPinyin(text) : "";
  el.querySelector(".badge").textContent = award ? `+${award.points}` : "";
  el.querySelector(".badge").style.color = "var(--green)";

  const hist = !target ? (history.get(id) || []).slice(text && a?.final ? 1 : 0, 3) : [];
  el.querySelector(".hist").innerHTML = hist.map((h) => `<div>${escapeHtml(h)}</div>`).join("");
  el.querySelector(".hist").classList.toggle("hidden", !hist.length);

  if (flash) { el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 180); }
}

function renderBanner() {
  const show = meta.mode === "target" && meta.round > 0 && meta.target;
  $("#banner").classList.toggle("hidden", !show);
  if (!show) return;
  $("#bWord").textContent = meta.target;
  $("#bPy").textContent = boardPinyin ? meta.targetPinyin || toPinyin(meta.target) : "";
  $("#bRound").textContent = meta.round;
  $("#bDone").textContent = Object.keys(awards).filter((id) => players.has(id)).length;
  $("#bTotal").textContent = [...players.values()].filter((p) => p.online !== false).length;
}

function renderLeaders() {
  const rows = Object.entries(scores)
    .filter(([id]) => players.has(id))
    .sort((a, b) => b[1] - a[1]).slice(0, 10);
  $("#leaders").innerHTML = rows.length
    ? rows.map(([id, pts]) => `<li><span>${escapeHtml(players.get(id).name)}</span><b>${pts}</b></li>`).join("")
    : `<li class="muted">No points yet</li>`;
}

function renderCount() {
  $("#count").textContent = [...players.values()].filter((p) => p.online !== false).length;
}

function renderAll() {
  for (const id of players.keys()) renderCard(id);
  if (!players.size && !grid.querySelector(".empty")) grid.innerHTML = `<div class="empty">Waiting for students to join…</div>`;
  renderBanner(); renderLeaders(); renderCount(); renderJoinNames();
}

// ── Live listeners ───────────────────────────────────────────────────
onValue(r("meta"), (s) => {
  const v = s.val();
  if (!v) return; // room deleted (End class)
  meta = v;
  if (v.round !== subscribedRound) subscribeRound(v.round);
  renderControls(); renderAll();
});

const onPlayer = (s) => {
  players.set(s.key, s.val());
  renderCard(s.key);
  // a student who joined late may already have an answer waiting
  if (answers.has(s.key)) maybeAward(s.key, answers.get(s.key));
  renderBanner(); renderLeaders(); renderCount(); renderJoinNames();
};
onChildAdded(r("players"), onPlayer);
onChildChanged(r("players"), onPlayer);
onChildRemoved(r("players"), (s) => {
  players.delete(s.key); answers.delete(s.key); history.delete(s.key);
  document.getElementById("c-" + s.key)?.remove();
  renderAll();
});

const onAnswer = (s) => {
  const a = s.val();
  answers.set(s.key, a);
  if (a?.final && a.text && lastHistAt.get(s.key) !== a.at) {
    lastHistAt.set(s.key, a.at);
    const h = history.get(s.key) || [];
    h.unshift(a.text);
    history.set(s.key, h.slice(0, 4));
  }
  maybeAward(s.key, a);
  renderCard(s.key, true);
  renderBanner();
};
onChildAdded(r("answers"), onAnswer);
onChildChanged(r("answers"), onAnswer);
onChildRemoved(r("answers"), (s) => { answers.delete(s.key); renderCard(s.key); });

onValue(r("scores"), (s) => { scores = s.val() || {}; renderLeaders(); });

renderControls();
renderAll();
