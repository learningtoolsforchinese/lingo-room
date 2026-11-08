# Lingo Room

A free, Kahoot-style live classroom app for language lessons. Students join with a PIN and their name, then respond, and their answers show up live on the teacher's screen.

The first version is built for **Chinese speaking practice** (speech recognition plus pinyin). It's designed to grow into other activities, such as writing, and other languages, such as English and French.

- **Teacher page:** `host.html`. The teacher signs in with their Google (Gmail) account, then sees the PIN, a QR code, a live card for each student and a leaderboard.
- **Student page:** `index.html`. Enter the PIN and a name, then tap 🎤 to speak (or type).

Everything runs in the browser: **GitHub Pages** hosts the pages and **Firebase Realtime Database** (free Spark plan) syncs the data live. Speech recognition is the browser's built-in Web Speech API, which is also free.

## Modes

| Mode | What happens |
|---|---|
| 🗣 **Free talk** | Students say anything. Each card shows their latest sentence and the last few before it. |
| 🎯 **Say the word** | The teacher sets a word (or uses **Next ▶** with a word list). Students who say it correctly get points: 1000 for the first, then 900, 800 … down to a minimum of 500. |

Teacher options: mics on/off, pinyin on the board, pinyin for students, **Accept same sound** (counts 他/她 or 妈/媽 as correct when the syllables and tones match), Simplified (zh-CN) or Traditional (zh-TW), clear board, reset scores, full screen, end class.

---

## Setup (about 10 minutes, no credit card)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> and click **Create a project**. Name it something like `lingo-room`. You can turn off Google Analytics.
2. **Build → Authentication → Get started → Sign-in method**, then turn on two providers:
   - **Google → Enable**, pick your email as the support email, **Save**. Teachers sign in with this.
   - **Anonymous → Enable → Save.** Students join with this, without an account.
3. **Build → Realtime Database → Create database.** Pick a location near you (e.g. Singapore `asia-southeast1`) and choose **Start in locked mode**.
4. In the Realtime Database, open the **Rules** tab, delete what's there, paste the whole contents of [`database.rules.json`](database.rules.json), and click **Publish**.
5. Click **Project settings (⚙) → General → Your apps → `</>` (Web)**. Give it a name and click **Register app**. You don't need Firebase Hosting.
6. Copy the `firebaseConfig` values into [`firebase-config.js`](firebase-config.js). Check that `databaseURL` is there. If it's missing, copy it from the top of the Realtime Database page.

> These config values are **not secrets**, so it's fine to put them in a public GitHub repo. The security rules are what protect the data.

### 2. Put it on GitHub Pages
1. Create a new **public** repo on GitHub, e.g. `lingo-room`.
2. Push this folder to it (see the commands below).
3. In the repo, go to **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**
4. After about a minute your site is live at `https://<your-username>.github.io/lingo-room/`.
   - Teacher: `https://<your-username>.github.io/lingo-room/host.html`
   - Students: `https://<your-username>.github.io/lingo-room/`, or they scan the QR code.

```bash
git remote add origin https://github.com/<your-username>/lingo-room.git
git push -u origin main --tags
```

### 3. Allow your site in Firebase Auth
**Authentication → Settings → Authorized domains → Add domain →** `<your-username>.github.io`

Without this step, students get an error when they join.

---

## In class

1. Open `host.html` on the projector and **sign in with Google**. The room is created automatically and the PIN and QR code appear.
2. Students scan the QR code or open the site and type the PIN, then enter their name.
3. Click **Start ▶**, then choose **Free talk** or **Say the word**.
4. Click **End class** at the end. This deletes the room and its data.

If the teacher refreshes the page, or signs in on a different computer with the same Google account, the same room comes back. Students who refresh rejoin automatically.

> **Who can be a teacher?** Anyone with a Google account can sign in and open a room. Students can never create rooms or change one. If you want only specific teachers (e.g. your school's accounts), that can be added later.

### Tips for students' phones
- Use **Chrome** (Android, laptop) or **Safari** (iPhone/iPad). Firefox and some in-app browsers (LINE, Facebook, Telegram) **don't support voice**. The page then shows a box for typing instead.
- The first time, the browser asks for **microphone permission**. Tap **Allow**.
- On iPhone, Siri & Dictation must be allowed: *Settings → Screen Time → Content & Privacy → Allowed Apps*, if it's restricted.
- Test it once on the classroom Wi-Fi before the first real lesson.

## Free-tier limits (Firebase Spark)
- **100 simultaneous connections.** One class of 30 uses about 31. Running three classes at the same time would get close to the limit.
- **1 GB storage and 10 GB/month download.** A lesson uses a few MB.
- No Cloud Functions are needed, so there's never a bill.

---

## Testing locally (optional, for developers)
You can try everything on your computer with the Firebase emulator. This needs Java and Node.

```bash
npx firebase-tools@13 emulators:start --only auth,database --project demo-lingoroom
```
```bash
python3 -m http.server 8080
```
Then open `http://localhost:8080/host.html?emu=1` (the emulator shows a test Google account picker) and, in other tabs, `http://localhost:8080/?emu=1`. In emulator mode each tab is a separate student.

## Files
| File | Purpose |
|---|---|
| `index.html`, `student.js` | Student page |
| `host.html`, `host.js` | Teacher page |
| `common.js` | Firebase setup, pinyin and answer matching |
| `style.css` | Styles |
| `firebase-config.js` | **Your Firebase config goes here** |
| `database.rules.json` | Security rules to paste into Firebase |
| `firebase.json` | Emulator config (local testing only) |

© 2026 Lun Sovathana
