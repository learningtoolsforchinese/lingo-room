import {
  ref, get, set, push, remove, onValue, onDisconnect, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { boot, withEmu, toPinyin, escapeHtml, $, parseInk, inkSvg, inputsOf, isInkOnly } from "./common.js?v=0.9.0";
import { createBoard, encodeStrokes } from "./board.js?v=0.9.0";

const POINTS = 1000;
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
const rr = (path) => ref(db, `rooms/${pin}/${path}`);

// ── Step 1: PIN ──────────────────────────────────────────────────────
async function choosePin(p) {
  $("#pinErr").textContent = "";
  if (!/^\d{6}$/.test(p)) { $("#pinErr").textContent = "The PIN has 6 digits."; return; }
  if (!(await get(ref(db, `rooms/${p}/meta`))).exists()) { $("#pinErr").textContent = "Room not found. Check the PIN."; return; }
  pin = p;
  // Rejoining after a refresh? Skip the name step.
  const me = await get(rr(`players/${uid}`)).catch(() => null);
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
    await set(rr(`players/${uid}`), { name, joinedAt: serverTimestamp(), online: true });
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
let myWords = [];        // [{ id, text }] newest first
let myMarks = {};        // wordId → true | false
let marksLoaded = false;
let lastScore = null;
const unsubs = [];

function enterRoom(name) {
  ls.set(LS.pin, pin); ls.set(LS.name, name);
  $("#meName").textContent = name;
  $("#meRoom").textContent = pin;
  joined = true; ended = false; marksLoaded = false; lastScore = null;
  show("sPlay");
  if (!SR) {
    $("#micNote").textContent = "Voice isn't supported in this browser. Open this page in Chrome or Safari.";
    $("#mic").disabled = true;
  }

  // Presence: mark offline when the phone disconnects, online when it reconnects.
  unsubs.push(onValue(ref(db, ".info/connected"), (s) => {
    if (!s.val() || ended) return;
    onDisconnect(rr(`players/${uid}/online`)).set(false).catch(() => {});
    set(rr(`players/${uid}/online`), true).catch(() => {});
  }));

  unsubs.push(onValue(rr("meta"), (s) => {
    if (!s.exists()) return finish("Class ended 再见！", "Your teacher closed the room. Thanks for joining!");
    meta = s.val();
    renderMeta();
  }));

  unsubs.push(onValue(rr(`players/${uid}`), (s) => {
    if (s.exists() || !joined) return;
    // Removed by the teacher (or the room ended — the meta listener says so first).
    setTimeout(() => { if (!ended) finish("You left the room", "The teacher removed you from this room.", true); }, 400);
  }));

  unsubs.push(onValue(rr(`scores/${uid}`), (s) => {
    const v = s.val() || 0;
    $("#meScore").textContent = v;
    if (lastScore !== null && v > lastScore) {
      $("#scorePill").classList.add("bump");
      setTimeout(() => $("#scorePill").classList.remove("bump"), 300);
    }
    lastScore = v;
  }));

  unsubs.push(onValue(rr(`said/${uid}`), (s) => {
    const v = s.val() || {};
    myWords = Object.keys(v).sort().reverse().map((id) => ({ id, text: v[id].text, ink: parseInk(v[id].ink) }));
    renderMine();
  }));

  unsubs.push(onValue(rr(`marks/${uid}`), (s) => {
    const next = s.val() || {};
    if (marksLoaded) {
      // Only react to marks the teacher just made, not ones from before a refresh.
      for (const [id, val] of Object.entries(next)) {
        if (val === true && myMarks[id] !== true) celebrate(wordOf(id));
        else if (val === false && myMarks[id] !== false) tryAgain(wordOf(id));
      }
    }
    myMarks = next;
    marksLoaded = true;
    renderMine();
  }));
}

const textOf = (id) => myWords.find((w) => w.id === id)?.text || "";
const wordOf = (id) => myWords.find((w) => w.id === id);

function finish(title, msg, canRejoin = false) {
  if (ended) return;
  ended = true; joined = false;
  try { rec?.abort(); } catch {}
  unsubs.splice(0).forEach((u) => u());
  $("#endTitle").textContent = title;
  $("#endMsg").textContent = msg;
  $("#endBtn").textContent = canRejoin ? "Join again" : "Join another room";
  $("#endBtn").onclick = () => {
    if (canRejoin) { $("#nameRoom").textContent = pin; show("sName"); }
    else { $("#pinInput").value = ""; show("sPin"); }
  };
  show("sEnd");
}

// ── Answer modes chosen by the teacher: speak / type / write ─────────
let mode = null;
function availableModes() {
  const on = inputsOf(meta);
  // No voice in this browser and speaking is the only option → let them type instead.
  if (!SR && on.length === 1 && on[0] === "speak") return ["speak", "type"];
  return on;
}
function setMode(m) {
  mode = m;
  document.querySelectorAll("#modeTabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("#paneSpeak").classList.toggle("hidden", m !== "speak");
  $("#paneType").classList.toggle("hidden", m !== "type");
  $("#paneWrite").classList.toggle("hidden", m !== "write");
  if (m !== "speak" && listening) { try { rec.stop(); } catch {} }
  if (m === "write") ensureBoard();
  setFeedback("");
}
$("#modeTabs").onclick = (e) => { const m = e.target.closest("button")?.dataset.mode; if (m) setMode(m); };

function renderModes() {
  const modes = availableModes();
  document.querySelectorAll("#modeTabs button").forEach((b) => b.classList.toggle("hidden", !modes.includes(b.dataset.mode)));
  $("#modeTabs").classList.toggle("hidden", modes.length < 2);
  if (!modes.includes(mode)) setMode(modes[0]);
  $(".stu-prompt .lbl").textContent = modes.length === 1
    ? { speak: "Say this · 请说", type: "Type this · 请打字", write: "Write this · 请写" }[modes[0]]
    : "Answer this · 请回答";
}

function renderMeta() {
  const prompt = meta.prompt || "";
  renderModes();
  $("#pBox").classList.toggle("hidden", !prompt);
  $("#hintBox").classList.toggle("hidden", !!prompt);
  $("#pWord").textContent = prompt;
  $("#pPy").textContent = prompt && meta.showPinyin ? meta.promptPinyin || toPinyin(prompt) : "";
  if (SR) {
    $("#mic").disabled = !meta.open;
    if (!meta.open) { try { rec?.stop(); } catch {} }
    if (!listening) $("#micNote").textContent = meta.open ? "Tap to speak" : "⏸ Teacher paused the mics";
  }
  $("#typeInput").disabled = !meta.open;
  $("#wSend").disabled = !meta.open;
}

function renderMine() {
  const correct = myWords.filter((w) => myMarks[w.id] === true).length;
  $("#mineCount").textContent = correct ? `✓ ${correct}` : "";
  $("#mine").innerHTML = myWords.length
    ? myWords.map((w) => {
        const st = myMarks[w.id];
        return `<li class="${st === true ? "ok" : st === false ? "no" : ""}">
          ${isInkOnly(w) ? `<span class="t">${inkSvg(w.ink, 64)}</span>`
            : `${w.ink.length ? `<span class="inks">${inkSvg(w.ink, 30)}</span>` : ""}<span class="t">${escapeHtml(w.text)}</span>`}
          <span class="m">${st === true ? `✓ +${POINTS}` : st === false ? "✗ Try again" : ""}</span></li>`;
      }).join("")
    : `<li class="none">Your words will appear here</li>`;
}

function showHeard(text, interim) {
  $("#heardText").textContent = text;
  $("#heardText").classList.toggle("interim", interim);
  $("#heardPy").textContent = text && meta?.showPinyin !== false ? toPinyin(text) : "";
}
function setFeedback(text, kind = "") {
  $("#feedback").textContent = text;
  $("#feedback").className = "feedback " + kind;
}

// ── Celebrate / encourage ────────────────────────────────────────────
let yayTimer = null;
function celebrate(word) {
  const yay = $("#yay");
  $("#yayWord").innerHTML = isInkOnly(word) ? inkSvg(word.ink, 120) : escapeHtml(word?.text || "");
  yay.querySelectorAll(".confetti").forEach((c) => c.remove());
  const bits = ["🎉", "⭐", "✨", "🎊", "💯", "🌟"];
  for (let i = 0; i < 28; i++) {
    const c = document.createElement("span");
    c.className = "confetti";
    c.textContent = bits[i % bits.length];
    c.style.left = Math.random() * 100 + "%";
    c.style.animationDuration = 1.6 + Math.random() * 1.6 + "s";
    c.style.animationDelay = Math.random() * 0.5 + "s";
    yay.appendChild(c);
  }
  // restart the entrance animations
  yay.classList.add("hidden"); void yay.offsetWidth; yay.classList.remove("hidden");
  navigator.vibrate?.([60, 40, 60]);
  clearTimeout(yayTimer);
  yayTimer = setTimeout(() => yay.classList.add("hidden"), 3200);
}
$("#yay").onclick = () => $("#yay").classList.add("hidden");

let toastTimer = null;
function tryAgain(word) {
  const t = $("#toast");
  t.textContent = isInkOnly(word) ? "Let's try that one again! 加油 💪" : `“${word?.text || ""}” — let's try again! 加油 💪`;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// ── Sending words ────────────────────────────────────────────────────
// While speaking: answers/{uid} = { text } so the teacher sees it live.
// When finished:  said/{uid}/{pushId} = { text, at } is added to the student's list.
let timer = null, lastSend = 0, queued = "";
function writeLive(text) {
  if (!joined) return;
  set(rr(`answers/${uid}`), { text: text.slice(0, 200), at: Date.now() }).catch((e) => console.warn(e));
}
function sendInterim(text) {
  queued = text;
  if (timer) return;
  const wait = Math.max(0, 250 - (Date.now() - lastSend));
  timer = setTimeout(() => { timer = null; lastSend = Date.now(); writeLive(queued); }, wait);
}
function submitWord(text, via, ink = null) {
  clearTimeout(timer); timer = null;
  text = text.trim().slice(0, 200);
  if (!text || !joined || !meta?.open) return false;
  const word = { text, at: serverTimestamp(), via };
  if (ink) word.ink = ink;
  push(rr(`said/${uid}`), word).catch((e) => { console.warn("not saved", e); setFeedback("Couldn't send — try again", "no"); });
  remove(rr(`answers/${uid}`)).catch(() => {});
  if (via === "speak") showHeard(text, false);
  setFeedback("Sent to your teacher ✓");
  return true;
}

// ── Speech recognition ───────────────────────────────────────────────
let rec = null, listening = false, transcript = "";
const ERRORS = {
  "not-allowed": "Microphone is blocked. Allow mic access (tap the 🔒 / aA in the address bar), then reload.",
  "service-not-allowed": "Speech is blocked on this device. Check Settings → Siri & Dictation / mic permission.",
  "no-speech": "I didn't hear anything — tap and speak a bit louder.",
  "audio-capture": "No microphone found.",
  "network": "Speech needs internet. Check your Wi-Fi and try again.",
  "language-not-supported": "This browser can't recognise this language. Try Chrome or Safari.",
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
  showHeard("", true);
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
    if (transcript.trim()) submitWord(transcript, "speak");
    else remove(rr(`answers/${uid}`)).catch(() => {});
  };
  try { rec.start(); } catch (err) { console.warn(err); setListening(false); }
}

$("#mic").onclick = () => {
  if (listening) { try { rec.stop(); } catch {} }
  else startListening();
};

// ── Typing ───────────────────────────────────────────────────────────
$("#paneType").onsubmit = (e) => {
  e.preventDefault();
  if (submitWord($("#typeInput").value, "type")) $("#typeInput").value = "";
};
$("#typeInput").oninput = (e) => {
  if (e.target.value.trim()) sendInterim(e.target.value);
  else { clearTimeout(timer); timer = null; remove(rr(`answers/${uid}`)).catch(() => {}); }
};

// ── Handwriting board ────────────────────────────────────────────────
// The student writes on the board and sends the drawing exactly as it is.
// Nothing is recognised or corrected: the teacher sees the real strokes.
const INK_TEXT = "✍";   // stands in for the text of a handwritten answer
let board = null;

function ensureBoard() {
  if (board) { board.resize(); return; }
  board = createBoard($("#wCanvas"), () => {
    // let the teacher see that this student is writing
    if (board.strokes.length) sendInterim(INK_TEXT);
    else { clearTimeout(timer); timer = null; remove(rr(`answers/${uid}`)).catch(() => {}); }
  });
}

$("#wUndo").onclick = () => board?.undo();
$("#wClear").onclick = () => board?.clear();
$("#wSend").onclick = () => {
  if (!board?.strokes.length) { setFeedback("Write on the board first ✍️", "no"); return; }
  const ink = JSON.stringify([{ t: INK_TEXT, s: encodeStrokes(board.strokes, board.width, board.height) }]);
  if (ink.length > 30000) { setFeedback("That drawing is too big — clear it and write a little less.", "no"); return; }
  if (submitWord(INK_TEXT, "write", ink)) board.clear();
};

// Auto-continue: ?pin=123456 in the link (from the QR code) → go straight to the name step.
if (/^\d{6}$/.test(pin)) choosePin(pin);
