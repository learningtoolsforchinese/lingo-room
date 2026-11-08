// Shared setup for host and student pages.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeAuth, browserSessionPersistence, browserLocalPersistence, browserPopupRedirectResolver,
  signInAnonymously, connectAuthEmulator, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, connectDatabaseEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { pinyin } from "https://cdn.jsdelivr.net/npm/pinyin-pro@3.26.0/+esm";
import { firebaseConfig } from "./firebase-config.js?v=0.11.0";

const params = new URLSearchParams(location.search);

// ?emu=1 → use the local Firebase emulator (for testing without a real project).
export const useEmulator = params.get("emu") === "1";

export const isConfigured = useEmulator ||
  !Object.values(firebaseConfig).some((v) => String(v).includes("PASTE_"));

export const LANGS = {
  "zh-CN": "普通话 · Simplified (zh-CN)",
  "zh-TW": "國語 · Traditional (zh-TW)",
};

let ctx = null;

/** Set up Firebase once. Shows a setup message if the config is missing. */
function init() {
  if (ctx) return ctx;
  if (!isConfigured) {
    document.body.insertAdjacentHTML("afterbegin", `
      <div class="setup-banner">
        <b>Firebase isn't set up yet.</b> Open <code>firebase-config.js</code> and paste your Firebase web config.
        See <code>README.md</code> for the 10-minute setup.
      </div>`);
    throw new Error("Firebase config missing");
  }
  const config = useEmulator
    ? { apiKey: "demo-key", authDomain: "127.0.0.1", projectId: "demo-lingoroom", databaseURL: "http://127.0.0.1:9000?ns=demo-lingoroom-default-rtdb" }
    : firebaseConfig;
  const app = initializeApp(config);
  // In emulator mode each tab keeps its own sign-in, so you can test a teacher and many students in one browser.
  const auth = initializeAuth(app, {
    persistence: useEmulator ? browserSessionPersistence : browserLocalPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  const db = getDatabase(app);
  if (useEmulator) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectDatabaseEmulator(db, "127.0.0.1", 9000);
  }
  ctx = { auth, db };
  return ctx;
}

/** Students: reuse whoever is signed in on this browser, or sign in anonymously. Returns { db, uid }. */
export async function boot() {
  const { auth, db } = init();
  await auth.authStateReady();
  const user = auth.currentUser || (await signInAnonymously(auth)).user;
  return { db, uid: user.uid };
}

/** Teachers: set up Firebase and wait for any saved sign-in. Returns { auth, db }. */
export async function bootTeacher() {
  const { auth, db } = init();
  await auth.authStateReady();
  return { auth, db };
}

/** A teacher is anyone signed in with a Google account. */
export const isTeacher = (user) =>
  !!user && !user.isAnonymous && user.providerData.some((p) => p.providerId === "google.com");

export async function signInTeacher(auth) {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    return (await signInWithPopup(auth, provider)).user;
  } catch (e) {
    // Some browsers block pop-ups: fall back to a full-page redirect to Google.
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw e;
  }
}

export const signOutTeacher = (auth) => signOut(auth);

const GOOGLE_LOGO = `<svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

/**
 * Teacher pages: show the Google sign-in screen until a teacher is signed in.
 * Resolves with the signed-in user.
 */
export async function requireTeacher(auth) {
  if (isTeacher(auth.currentUser)) return auth.currentUser;
  document.body.insertAdjacentHTML("beforeend", `
    <div class="join-overlay signin" id="signIn">
      <div class="join-card" style="max-width:440px">
        <div class="brand" style="font-size:28px">Lingo <span>Room</span></div>
        <p class="muted" style="margin:6px 0 24px">Teacher sign in</p>
        <button class="google-btn" id="googleBtn">${GOOGLE_LOGO} Sign in with Google</button>
        <div class="err" id="signInErr" style="margin-top:12px"></div>
        <p class="note" style="margin-top:18px"><a href="${withEmu("./")}">I'm a student →</a></p>
      </div>
    </div>`);
  return new Promise((resolve) => {
    const btn = document.getElementById("googleBtn");
    const err = document.getElementById("signInErr");
    btn.onclick = async () => {
      err.textContent = "";
      btn.disabled = true;
      try {
        const user = await signInTeacher(auth);
        if (user) { document.getElementById("signIn").remove(); resolve(user); }
      } catch (e) {
        console.error(e);
        err.textContent = e.code === "auth/popup-closed-by-user"
          ? "Sign-in was cancelled."
          : e.code === "auth/unauthorized-domain"
            ? "This website isn't allowed yet. Add it in Firebase → Authentication → Settings → Authorized domains."
            : "Could not sign in. Please try again.";
      } finally { btn.disabled = false; }
    };
  });
}

/** Fill the teacher's name/photo chip (#me) with a Sign out button. */
export function showTeacherChip(auth, user, el) {
  el.classList.remove("hidden");
  el.querySelector("span").textContent = user.displayName || user.email || "Teacher";
  el.title = user.email || "";
  const img = el.querySelector("img");
  if (user.photoURL) img.src = user.photoURL; else img.remove();
  el.querySelector("button").onclick = async () => {
    if (!confirm("Sign out? Sign in again with the same Google account to get back to your classes.")) return;
    await signOut(auth);
    location.reload();
  };
}

/** Keep ?emu=1 on links between pages. */
export function withEmu(url) {
  const u = new URL(url, location.href);
  if (useEmulator) u.searchParams.set("emu", "1");
  return u.toString();
}

// ── Text helpers ────────────────────────────────────────────
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Pinyin with tone marks, e.g. 你好 → "nǐ hǎo". */
export function toPinyin(s) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return pinyin(t, { toneType: "symbol", nonZh: "consecutive" })
    .replace(/\s+([，。！？、；：,.!?;:])/g, "$1");
}

// ── Handwriting ─────────────────────────────────────────────
/** Read the handwriting stored with a word: [{ t: "好", s: [[x, y, x, y, …], …] }, …] (0–255 box). */
export function parseInk(str) {
  if (!str) return [];
  try {
    const v = JSON.parse(str);
    return Array.isArray(v) ? v.filter((g) => g && Array.isArray(g.s)) : [];
  } catch { return []; }
}

/** Draw handwriting as small SVG squares with a 田字格 guide. */
export function inkSvg(groups, px, cls = "ink") {
  return groups.map((g) => {
    const lines = g.s.map((pts) => {
      const xy = [];
      for (let i = 0; i + 1 < pts.length; i += 2) xy.push(`${+pts[i] || 0},${+pts[i + 1] || 0}`);
      if (xy.length === 1) xy.push(xy[0]);
      return `<polyline points="${xy.join(" ")}"/>`;
    }).join("");
    return `<svg class="${cls}" viewBox="0 0 256 256" width="${px}" height="${px}" aria-label="${escapeHtml(g.t || "")}">
      <path class="ink-grid" d="M128 0V256M0 128H256M0 0L256 256M256 0L0 256"/><g class="ink-strokes">${lines}</g></svg>`;
  }).join("");
}

/** A handwritten answer has only a drawing — no text to show. */
export const isInkOnly = (w) => !!w?.ink?.length && w.text === "✍";

/** Ways a student can answer. Older rooms without this setting = speaking only. */
export const INPUTS = { speak: "🎤 Speak", type: "⌨️ Type", write: "✍️ Write" };
export function inputsOf(meta) {
  const v = meta?.inputs || { speak: true };
  const on = Object.keys(INPUTS).filter((k) => v[k]);
  return on.length ? [on[0]] : ["speak"];   // one answer type at a time
}

export const $ = (sel, root = document) => root.querySelector(sel);
