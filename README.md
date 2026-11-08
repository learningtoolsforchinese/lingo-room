# Lingo Room

A free, Kahoot-style live classroom app for language lessons. Students join with a PIN and their name, then respond, and their answers show up live on the teacher's screen.

The first version is built for **Chinese speaking practice** (speech recognition plus pinyin). It's designed to grow into other activities, such as writing, and other languages, such as English and French.

- **Teacher page:** `host.html`. The teacher signs in with their Google (Gmail) account, then sees the PIN, a QR code, a live card for each student listing everything they said, and a leaderboard.
- **Student page:** `index.html`. Enter the PIN and a name, then answer by speaking 🎤, typing ⌨️ or handwriting ✍️, whichever the teacher allows.

Everything runs in the browser: **GitHub Pages** hosts the pages and **Firebase Realtime Database** (free Spark plan) syncs the data live. Speech recognition is the browser's built-in Web Speech API. The Listening maker uses open-source Piper voices that run in the browser.

## How it works

- **The teacher chooses how students answer** with the **Answer by** switch: 🎤 **Speak**, ⌨️ **Type** or ✍️ **Write**, one at a time. The selected one is highlighted, and every student's screen switches to it straight away.
- **✍️ Write is a handwriting board.** The student writes in the 田字格 box and taps **Send**. Nothing is recognised or corrected: the teacher sees the drawing exactly as the student wrote it, on the card, big in Spotlight, in the word cloud and in History, and marks it ✓ or ✗.
- **The app never corrects students.** It shows exactly what each student said, so the teacher can do the correcting.
- **Each student's card lists every word they've said,** newest at the top. While a student is still speaking, their words appear in grey with ●●●.
- **The teacher marks each word ✓ (correct) or ✗ (incorrect).** Each ✓ is worth **+1000 points**. Clicking the same mark again removes it, and the points too.
- **The leaderboard** is ordered by score and shows how many ✓ each student has.
- **On the student's phone,** a ✓ shows a celebration: 🎉 *太棒了！Great job!* **+1000**. A ✗ shows a gentle "let's try again! 加油 💪". Students also see their own list of words with the teacher's marks.
- **Word to say (optional):** the teacher can type a word and click **Show**, or use **Next ▶** with a saved word list. It appears on the board and on every student's phone.

**🔍 Spotlight** fills the projector screen and has two views:
- **☁ Word cloud** (the default) shows every student's words on one screen, like Mentimeter, each with the student's name underneath. New words pop in as students speak. A word several students said grows bigger and shows all their names (e.g. *×4*). The top shows the join link and PIN, and students who are still talking appear at the bottom. Click a word to open that student's view.
- **👤 One student** shows one student's latest words in giant text with pinyin, plus big **✓ Correct / ✗ Incorrect** buttons. Click a student's card to open it.

Keys: **W** word cloud, **S** one student, **← →** switch student, **C** marks correct, **X** marks incorrect, **F** turns "follow latest speaker" on or off, **Esc** closes. The cloud shows the 80 most recent different words.

**📚 Class history.** **End class** asks for a class name (prefilled with the date and time) and saves the class before closing the room: every student's final score, ✓/✗ counts, and every word they said, with handwriting and your marks. Open **📚 History** from the teacher page to see past classes, open one for the full leaderboard and each student's words, **download CSV** files (scores, or every word) for Excel or Google Sheets, rename a class, or delete it. History is saved on your Google account, so it's there on any computer, and only you can see it.

Teacher options: answers on/off, pinyin on the board, pinyin for students, Simplified (zh-CN) or Traditional (zh-TW), clear words (keeps scores), reset scores, full screen, end class.

## 🎧 Listening maker (separate from classes)

A standalone tool for making **listening-test audio** and downloading it as an **MP3**. Open it from the teacher page (**🎧 Listening**). It doesn't need a class or a room.

Type a script, one line at a time. Use the buttons or type small tags:

| Tag | What it does |
|---|---|
| `*2*` … `*2*` | read what's between twice (`*3*` for three times) |
| `*p1*` | pause 1 second (`*p0.5*`, `*p3*` …) |
| `*d*` `*dd*` `*b*` `*c*` | ding · ding-dong · beep · chime |
| `A:` `B:` (or `女：` `男：`) at the start of a line | choose the voice. No label = voice A |

Example (a typical test item):

```
欢迎参加听力考试
*2*
A: 今天的天气真不错
B: 是啊，太阳阳光明媚
问题：今天的天气怎么样？ *p1* *d*
*2*
```

Choose the language (中文, English or Français), the speed, the pause after each line and the pause between repeats, then click **🎧 Make audio**. Listen to it in the page, then click **⬇ Download MP3**. **💾 Save script** keeps the script (not the audio) on your Google account, so you can open it later and make the audio again.

- **Voices:** open-source Piper voices, made on your own computer. The first time, the voice downloads once (about 63 MB) and is then kept in your browser. English and French have a real woman and man. Chinese has only one open voice, so voice **B** is that voice lowered in pitch, which is a deeper voice and not a real man.
- **Sounds** (ding, beep…) are generated by the page, so there are no files and no copyright concerns.

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
4. After about a minute your site is live at `https://learningtoolsforchinese.github.io/lingo-room/`.
   - Teacher: `https://learningtoolsforchinese.github.io/lingo-room/host.html`
   - Students: `https://learningtoolsforchinese.github.io/lingo-room/`, or they scan the QR code.

```bash
git remote add origin https://github.com/learningtoolsforchinese/lingo-room.git
git push -u origin main --tags
```

### 3. Allow your site in Firebase Auth
**Authentication → Settings → Authorized domains → Add domain →** `learningtoolsforchinese.github.io`

Without this step, students get an error when they join.

---

## In class

1. Open `host.html` on the projector and **sign in with Google**. The room is created automatically and the PIN and QR code appear.
2. Students scan the QR code or open the site and type the PIN, then enter their name.
3. Click **Start ▶**. Students speak, their words appear on their cards, and you mark each one ✓ or ✗. Use **🔍 Spotlight** to show one student full screen.
4. Click **End class** at the end. Give the class a name, and it's saved to **📚 History**. Then the room closes for students.

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

## Releasing an update

Before pushing, stamp the new version on the file links so browsers load the fresh files:

```bash
sh scripts/set-version.sh 0.10.0
```

## Files
| File | Purpose |
|---|---|
| `index.html`, `student.js` | Student page |
| `host.html`, `host.js` | Teacher page |
| `history.html`, `history.js` | Class history page |
| `listening.html`, `listening.js`, `tts.js` | Listening maker (script → speech → MP3) |
| `common.js` | Firebase setup, pinyin, drawing handwriting |
| `board.js` | Handwriting board |
| `style.css` | Styles |
| `firebase-config.js` | **Your Firebase config goes here** |
| `database.rules.json` | Security rules to paste into Firebase |
| `firebase.json` | Emulator config (local testing only) |

© 2026 Lun Sovathana
