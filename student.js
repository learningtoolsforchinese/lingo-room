import {
  ref, get, set, onValue, onDisconnect, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { boot, withEmu, toPinyin, isMatch, $ } from "./common.js";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const LS = { pin: "lingoroom.pin", name: "lingoroom.name" };
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

$("#hostLink").href = withEmu("host.html");
const screens = ["sPin", "sName", "sPlay", "sEnd"];
function show(id) { screens.forEach((s) => $("#" + s).classList.toggle("hidden", s !== id)); }

const params = new URLSearchParams(location.search);
let pin = (params.get("pin") || "").replace(/\D/g, "");
$("#pinInput").value = pin;
show("sPin");

const { db, uid } = await boot();

// ── Step 1: PIN ──────────────────────────────────────────────────────
async function roomExists(p) {
  return (await get(ref(db, `rooms/${p}/meta`))).exists();
}

async function choosePin(p) {
  $("#pinErr").textContent = "";
  if (!/^\d{6}$/.test(p)) { $("#pinErr").textContent = "The PIN has 6 digits."; return; }
  if (!(await roomExists(p))) { $("#pinErr").textContent = "Room not found. Check the PIN."; return; }
  pin = p;
  // Rejoining after a refresh? Skip the name step.
  const me = await get(ref(db, `rooms/${pin}/players/${uid}`)).catch(() => null);
  if (me?.exists()) return enterRoom(me.val().name);
  $("#nameRoom").textContent = pin;
  $("#nameInput").value = ls.get(LS.name) || "";
  show("sName");
  $("#nameInput").focus();
}

$("#pinForm").onsubmit = (e) => { e.preventDefault(); choosePin($("#pinInput").value.replace(/\D/g, "")); };
$("#pinInput").oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); };

// ── Step 2: Name ─────────────────────────────────────────────────────
$("#nameForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("#nameInput").value.trim().slice(0, 20);
  if (!name) return;
  $("#nameErr").textContent = "";
  try {
    await set(ref(db, `rooms/${pin}/players/${uid}`), { name, joinedAt: serverTimestamp(), online: true });
    enterRoom(name);
  } catch (err) {
    console.error(err);
    $("#nameErr").textContent = "Could not join. Is the room still open?";
  }
};

// ── Step 3: Play ─────────────────────────────────────────────────────
let meta = null;
let joined = false;
let ended = false;
let awarded = null;
let unsubAward = null;
let awardRound = null;
const unsubs = [];

function enterRoom(name) {
  ls.set(LS.pin, pin); ls.set(LS.name, name);
  $("#meName").textContent = name;
  $("#meRoom").textContent = pin;
  joined = true; ended = false;
  show("sPlay");
  if (!SR) {
    $("#micNote").textContent = "Voice isn't supported in this browser. Open this page in Chrome or Safari — or type below.";
    $("#mic").disabled = true;
    $("#typeForm").classList.remove("hidden");
  }

  const playerRef = ref(db, `rooms/${pin}/players/${uid}`);
  // Presence: mark offline when the phone disconnects, online when it reconnects.
  unsubs.push(onValue(ref(db, ".info/connected"), (s) => {
    if (!s.val() || ended) return;
    onDisconnect(ref(db, `rooms/${pin}/players/${uid}/online`)).set(false).catch(() => {});
    set(ref(db, `rooms/${pin}/players/${uid}/online`), true).catch(() => {});
  }));

  unsubs.push(onValue(ref(db, `rooms/${pin}/meta`), (s) => {
    if (!s.exists()) return finish("Class ended 再见！", "Your teacher closed the room. Thanks for joining!");
    meta = s.val();
    renderMeta();
  }));

  unsubs.push(onValue(playerRef, (s) => {
    if (s.exists() || !joined) return;
    // Removed by the teacher (or the room ended — the meta listener will say so first).
    setTimeout(() => { if (!ended) finish("You left the room", "The teacher removed you from this room.", true); }, 400);
  }));

  unsubs.push(onValue(ref(db, `rooms/${pin}/scores/${uid}`), (s) => {
    $("#meScore").textContent = s.val() || 0;
  }));
}

function finish(title, msg, canRejoin = false) {
  if (ended) return;
  ended = true; joined = false;
  try { rec?.abort(); } catch {}
  unsubs.splice(0).forEach((u) => u());
  unsubAward?.(); unsubAward = null; awardRound = null;
  $("#endTitle").textContent = title;
  $("#endMsg").textContent = msg;
  $("#endBtn").textContent = canRejoin ? "Join again" : "Join another room";
  $("#endBtn").onclick = () => {
    if (canRejoin) { $("#nameRoom").textContent = pin; show("sName"); }
    else { $("#pinInput").value = ""; show("sPin"); }
  };
  show("sEnd");
}

function renderMeta() {
  const target = meta.mode === "target" && meta.round > 0 && meta.target;
  $("#tBox").classList.toggle("hidden", !target);
  $("#freeBox").classList.toggle("hidden", !!target);
  if (target) {
    $("#tWord").textContent = meta.target;
    $("#tPy").textContent = meta.showPinyin ? meta.targetPinyin || toPinyin(meta.target) : "";
  }
  // New round → clear the old answer and watch for points.
  if (meta.round !== awardRound) {
    awardRound = meta.round;
    awarded = null;
    showHeard("", false);
    setFeedback("");
    unsubAward?.();
    unsubAward = meta.round ? onValue(ref(db, `rooms/${pin}/rounds/${meta.round}/${uid}`), (s) => {
      awarded = s.val();
      if (awarded) setFeedback(`${awarded.order === 1 ? "🥇 First! " : "✅ Correct! "}+${awarded.points}`, "ok");
    }) : null;
  }
  if (SR) {
    $("#mic").disabled = !meta.open;
    if (!meta.open) { try { rec?.stop(); } catch {} }
    if (!listening) $("#micNote").textContent = meta.open ? "Tap to speak" : "⏸ Teacher paused the mics";
  }
  $("#typeInput").disabled = !meta.open;
}

function showHeard(text, interim) {
  $("#heardText").textContent = text;
  $("#heardText").classList.toggle("interim", interim);
  $("#heardPy").textContent = text && meta?.showPinyin !== false ? toPinyin(text) : "";
}
function setFeedback(text, kind = "") {
  const f = $("#feedback");
  f.textContent = text;
  f.className = "feedback " + kind;
}

// ── Sending answers ──────────────────────────────────────────────────
let timer = null, lastSend = 0, queued = "";
function write(text, final) {
  if (!joined || !meta) return;
  set(ref(db, `rooms/${pin}/answers/${uid}`), {
    text: text.slice(0, 200), final, round: meta.round || 0, at: Date.now(),
  }).catch((e) => console.warn("answer not saved", e));
}
function sendInterim(text) {
  queued = text;
  if (timer) return;
  const wait = Math.max(0, 250 - (Date.now() - lastSend));
  timer = setTimeout(() => { timer = null; lastSend = Date.now(); write(queued, false); }, wait);
}
function submitFinal(text) {
  clearTimeout(timer); timer = null;
  text = text.trim().slice(0, 200);
  if (!text || !meta?.open) return;
  write(text, true);
  showHeard(text, false);
  const target = meta.mode === "target" && meta.round > 0 && meta.target;
  if (!target) return setFeedback("Sent ✓", "ok");
  if (awarded) return setFeedback(`✅ Already correct! +${awarded.points}`, "ok");
  if (isMatch(text, meta.target, meta.acceptSound !== false)) setFeedback("✅ Correct!", "ok");
  else setFeedback("Not quite — try again! 再试一次", "no");
}

// ── Speech recognition ───────────────────────────────────────────────
let rec = null, listening = false, transcript = "";
const ERRORS = {
  "not-allowed": "Microphone is blocked. Allow mic access (tap the 🔒 / aA in the address bar), then reload.",
  "service-not-allowed": "Speech is blocked on this device. Check Settings → Siri & Dictation / mic permission.",
  "no-speech": "I didn't hear anything — tap and speak a bit louder.",
  "audio-capture": "No microphone found.",
  "network": "Speech needs internet. Check your Wi-Fi and try again.",
  "language-not-supported": "This browser can't recognise Chinese. Try Chrome or Safari.",
};

function setListening(on) {
  listening = on;
  $("#mic").classList.toggle("on", on);
  $("#mic").textContent = on ? "■" : "🎤";
  $("#micNote").textContent = on ? "Listening… tap to stop" : (meta?.open ? "Tap to speak" : "⏸ Teacher paused the mics");
}

function startListening() {
  if (!SR || !meta?.open || listening) return;
  transcript = "";
  setFeedback("");
  rec = new SR();
  rec.lang = meta.lang || "zh-CN";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  rec.onstart = () => setListening(true);
  rec.onresult = (e) => {
    let s = "";
    for (const res of e.results) s += res[0].transcript;
    transcript = s;
    showHeard(s, true);
    sendInterim(s);
  };
  rec.onerror = (e) => {
    if (e.error === "aborted") return;
    setFeedback(ERRORS[e.error] || `Mic error: ${e.error}`, "no");
  };
  rec.onend = () => {
    setListening(false);
    if (transcript.trim()) submitFinal(transcript);
  };
  try { rec.start(); } catch (err) { console.warn(err); setListening(false); }
}

$("#mic").onclick = () => {
  if (listening) { try { rec.stop(); } catch {} }
  else startListening();
};

// ── Typing fallback ──────────────────────────────────────────────────
$("#typeToggle").onclick = (e) => { e.preventDefault(); $("#typeForm").classList.toggle("hidden"); $("#typeInput").focus(); };
$("#typeForm").onsubmit = (e) => {
  e.preventDefault();
  const t = $("#typeInput").value;
  $("#typeInput").value = "";
  submitFinal(t);
};

// Auto-continue: ?pin=123456 in the link (from the QR code) → go straight to the name step.
if (/^\d{6}$/.test(pin)) choosePin(pin);
