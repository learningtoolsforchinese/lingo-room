// Shared setup for host and student pages.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeAuth, browserSessionPersistence, browserLocalPersistence, browserPopupRedirectResolver,
  signInAnonymously, connectAuthEmulator, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, connectDatabaseEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { pinyin, polyphonic } from "https://cdn.jsdelivr.net/npm/pinyin-pro@3.26.0/+esm";
import { firebaseConfig } from "./firebase-config.js";

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

/** Remove spaces, punctuation and symbols (both Chinese and Latin). */
export function normalize(s) {
  return String(s ?? "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** Pinyin with tone marks, e.g. 你好 → "nǐ hǎo". */
export function toPinyin(s) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return pinyin(t, { toneType: "symbol", nonZh: "consecutive" })
    .replace(/\s+([，。！？、；：,.!?;:])/g, "$1");
}

const HAN = /\p{Script=Han}/u;
const hanOnly = (s) => [...normalize(s)].filter((c) => HAN.test(c)).join("");
/** "hao3" → ["hao", "3"]; neutral tone → "0" */
function syl(p) {
  const m = /^([a-zü:v]+)([0-5])?$/.exec(p);
  return m ? [m[1], m[2] || "0"] : null;
}
const sameSyl = ([b1, t1], [b2, t2]) => b1 === b2 && (t1 === t2 || t1 === "0" || t2 === "0" || t1 === "5" || t2 === "5");

/**
 * Did the student say the target?
 * - the exact characters appear anywhere in what was heard, or
 * - (if acceptSound) the same syllables with the same tones appear in order. This handles 他/她,
 *   simplified vs traditional (妈/媽), characters with several readings (妳 = nǐ/nǎi),
 *   and neutral tones (妈妈 = mā ma).
 */
export function isMatch(heard, target, acceptSound = true) {
  const h = normalize(heard), t = normalize(target);
  if (!h || !t) return false;
  if (h.includes(t)) return true;
  if (!acceptSound) return false;
  const th = hanOnly(t), hh = hanOnly(h);
  if (!th || !hh) return false;
  // Target: the reading in context (what the teacher means). Heard: any valid reading of each character.
  const want = pinyin(th, { toneType: "num", type: "array" }).map(syl);
  const ctx = pinyin(hh, { toneType: "num", type: "array" });
  const poly = polyphonic(hh, { toneType: "num", type: "array" });
  const got = ctx.map((c, i) => [c, ...(poly[i] || [])].map(syl).filter(Boolean));
  if (want.some((w) => !w) || got.length !== hh.length) return false;
  for (let i = 0; i + want.length <= got.length; i++) {
    if (want.every((w, j) => got[i + j].some((g) => sameSyl(w, g)))) return true;
  }
  return false;
}

export const $ = (sel, root = document) => root.querySelector(sel);
