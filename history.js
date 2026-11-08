import {
  ref, get, update, onValue, query, orderByChild,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  bootTeacher, requireTeacher, showTeacherChip, withEmu, escapeHtml, toPinyin, parseInk, inkSvg, $,
} from "./common.js";

const { auth, db } = await bootTeacher();
const user = await requireTeacher(auth);
const uid = user.uid;
showTeacherChip(auth, user, $("#me"));
$("#backToClass").href = withEmu("host.html");

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString(undefined, {
  weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
}) : "";
const fmtDuration = (a, b) => {
  if (!a || !b || b < a) return "";
  const min = Math.round((b - a) / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
const medal = (i) => ["🥇", "🥈", "🥉"][i] || i + 1;

// ── List of classes ──────────────────────────────────────────────────
let classes = {};    // classId → summary
let openId = null;
let detail = null;   // { students: { uid: { name, score, correct, incorrect, words: { id: { text, ink?, mark? } } } } }

onValue(query(ref(db, `teachers/${uid}/classes`), orderByChild("endedAt")), (s) => {
  classes = s.val() || {};
  renderList();
  if (openId && !classes[openId]) showList();
  else if (openId) renderDetailHeader();
});

function renderList() {
  const ids = Object.keys(classes).sort((a, b) => (classes[b].endedAt || 0) - (classes[a].endedAt || 0));
  $("#classList").innerHTML = ids.length ? ids.map((id) => {
    const c = classes[id];
    const top = (c.top || []).map((t, i) => `<span>${medal(i)} ${escapeHtml(t.name)} <b>${t.score}</b></span>`).join("");
    return `<button class="hist-item" data-id="${escapeHtml(id)}">
      <div class="hi-main">
        <div class="hi-name hanzi">${escapeHtml(c.name || "Class")}</div>
        <div class="muted">${fmtDate(c.endedAt)}${fmtDuration(c.startedAt, c.endedAt) ? " · " + fmtDuration(c.startedAt, c.endedAt) : ""}</div>
      </div>
      <div class="hi-stats"><span>👤 ${c.students || 0}</span><span>💬 ${c.words || 0}</span></div>
      <div class="hi-top hanzi">${top || `<span class="muted">No points given</span>`}</div>
    </button>`;
  }).join("") : `<div class="hist-empty">No saved classes yet.<br><span class="muted">When you click <b>End class</b>, the class is saved here with every student's score and words.</span></div>`;
}

$("#classList").onclick = (e) => {
  const b = e.target.closest(".hist-item");
  if (b) openClass(b.dataset.id);
};

// ── One class ────────────────────────────────────────────────────────
async function openClass(id) {
  openId = id;
  history.replaceState(null, "", "#" + id);
  $("#listView").classList.add("hidden");
  $("#detailView").classList.remove("hidden");
  renderDetailHeader();
  $("#dScores").innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
  $("#dStudents").innerHTML = "";
  const snap = await get(ref(db, `teachers/${uid}/classDetails/${id}`));
  if (openId !== id) return;
  detail = snap.val() || { students: {} };
  renderDetail();
}

function showList() {
  openId = null; detail = null;
  history.replaceState(null, "", location.pathname + location.search);
  $("#detailView").classList.add("hidden");
  $("#listView").classList.remove("hidden");
}
$("#backToList").onclick = showList;

function renderDetailHeader() {
  const c = classes[openId] || {};
  $("#dName").textContent = c.name || "Class";
  $("#dMeta").textContent = [fmtDate(c.endedAt), fmtDuration(c.startedAt, c.endedAt), `${c.students || 0} students`, `${c.words || 0} words`, c.pin ? `PIN ${c.pin}` : ""]
    .filter(Boolean).join(" · ");
}

function rankedStudents() {
  return Object.entries(detail?.students || {})
    .map(([id, s]) => ({ id, ...s, list: Object.keys(s.words || {}).sort().map((k) => s.words[k]) }))
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.name).localeCompare(String(b.name)));
}

function renderDetail() {
  const rows = rankedStudents();
  $("#dScores").innerHTML = rows.length ? rows.map((s, i) => `<tr>
      <td class="rank">${s.score > 0 ? medal(i) : ""}</td>
      <td><a href="#st-${escapeHtml(s.id)}" class="hanzi">${escapeHtml(s.name)}</a></td>
      <td><b>${s.score || 0}</b></td><td class="ok">${s.correct || 0}</td><td class="no">${s.incorrect || 0}</td><td>${s.list.length}</td>
    </tr>`).join("") : `<tr><td colspan="6" class="muted">No students in this class.</td></tr>`;

  $("#dStudents").innerHTML = rows.map((s) => `
    <div class="hist-student" id="st-${escapeHtml(s.id)}">
      <div class="card-head"><span class="nm hanzi">${escapeHtml(s.name)}</span><span class="score">${s.score ? `⭐ ${s.score}` : ""}</span></div>
      <ul class="list">${s.list.length ? s.list.map((w) => {
        const ink = parseInk(w.ink);
        return `<li class="item ${w.mark === true ? "ok" : w.mark === false ? "no" : ""}">
          <div class="it-main">${ink.length ? `<div class="it-ink">${inkSvg(ink, 44)}</div>` : ""}
            <div class="it-text hanzi">${escapeHtml(w.text)}</div><div class="it-py">${escapeHtml(toPinyin(w.text))}</div></div>
          <span class="hist-mark">${w.mark === true ? "✓" : w.mark === false ? "✗" : ""}</span></li>`;
      }).join("") : `<li class="item empty-item">No words</li>`}</ul>
    </div>`).join("");
}

// ── Rename / delete ──────────────────────────────────────────────────
$("#renameClass").onclick = () => {
  const c = classes[openId];
  const name = prompt("Class name", c?.name || "");
  if (name === null || !name.trim()) return;
  update(ref(db, `teachers/${uid}/classes/${openId}`), { name: name.trim().slice(0, 80) });
};
$("#deleteClass").onclick = async () => {
  const c = classes[openId];
  if (!confirm(`Delete “${c?.name || "this class"}” from your history? This can't be undone.`)) return;
  await update(ref(db, `teachers/${uid}`), { [`classes/${openId}`]: null, [`classDetails/${openId}`]: null });
  showList();
};

// ── CSV downloads (open in Excel or Google Sheets) ───────────────────
function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");
  // BOM so Excel shows Chinese characters correctly
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const safeName = () => (classes[openId]?.name || "class").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);

$("#csvScores").onclick = () => {
  const rows = [["Rank", "Student", "Score", "Correct", "Incorrect", "Words"]];
  rankedStudents().forEach((s, i) => rows.push([i + 1, s.name, s.score || 0, s.correct || 0, s.incorrect || 0, s.list.length]));
  downloadCsv(`${safeName()} - scores.csv`, rows);
};
$("#csvWords").onclick = () => {
  const rows = [["Student", "Word", "Pinyin", "Mark", "Handwritten"]];
  for (const s of rankedStudents()) {
    for (const w of s.list) {
      rows.push([s.name, w.text, toPinyin(w.text), w.mark === true ? "correct" : w.mark === false ? "incorrect" : "", w.ink ? "yes" : ""]);
    }
  }
  downloadCsv(`${safeName()} - words.csv`, rows);
};

// Open a class straight away if the link has #classId (from the "Class ended" screen).
const fromHash = location.hash.slice(1);
if (fromHash) openClass(fromHash);
