# Running the Dev Server on Your Own PC (no Freebuff needed)

## Why does the server "shut down" sometimes?

The server you saw in the Preview tab was **already running on your computer** —
Vite was serving `http://localhost:5173` from `F:\novelist\Gnovel`. It was not
"outside" or in the cloud.

The catch: the agent that set it up launched it as a *hidden background process
attached to the Freebuff session*. When that session ends, restarts, or is
cleaned up (e.g. during a long 20-minute thinking run), the child processes are
terminated — so the server dies with it.

The fix is simple: **start it yourself once, with one click.** Then it belongs
to your Windows session, not to any chat session, and it stays up for as long as
you want — minutes, hours, or days.

---

## Option A — One click (recommended)

1. Open `F:\novelist\Gnovel`.
2. **Double-click `start-dev-server.bat`.**
3. A terminal window opens and Vite prints:
   ```
   VITE v5.x.x  ready in 500 ms
   ➜  Local:   http://localhost:5173/
   ```
4. Open that URL in your browser. Done.

The window stays open and the server keeps running until **you** close the
window or press `Ctrl+C`.

- If port 5173 is already taken (e.g. by a leftover server), Vite automatically
  moves to **5174**, then 5175, etc. — just read the URL it prints.
- First run installs dependencies automatically if `node_modules` is missing.

---

## Option A+ — Start automatically at Windows login (zero clicks)

Already installed on this PC: a minimized shortcut in your Windows Startup
folder launches `start-dev-server.bat` every time you log in. After a login the
server is simply there — restore its (minimized) window from the taskbar to see
which URL it printed, or just open `http://localhost:5173/`.

- **Install / re-install:** double-click `install-autostart.bat` (idempotent,
  overwrites the existing shortcut).
- **Remove:** double-click `uninstall-autostart.bat`.
- **Alternative (admin required):** Task Scheduler task
  `schtasks /Create /SC ONLOGON /TN "OmniNovel Dev Server" /TR "F:\novelist\Gnovel\start-dev-server.bat"`
  if you want it to run hidden instead of minimized.

---

## Option B — Command line (same thing)

```powershell
cd F:\novelist\Gnovel
npm run dev
```

---

## Verify it is running

- Open `http://localhost:5173/` in your browser → you should see the OmniNovel
  "Initialize Novel Universe" screen.
- Or from a terminal:
  ```powershell
  curl http://localhost:5173/ -s -o NUL -w "%{http_code}"
  ```
  Expect `200`.

---

## Optional: DeepSeek proxy (in-browser key not needed)

The dev server exposes `POST /api/deepseek/chat`. If a `DEEPSEEK_API_KEY` is set
in the server's environment, the app routes DeepSeek traffic through the proxy
with **no key entered in the browser**; otherwise it falls back to the
in-browser key.

1. Create a file `dev-server.env` **next to** `start-dev-server.bat`:
   ```
   DEEPSEEK_API_KEY=sk-your-key-here
   ```
   The launcher reads it automatically. **Never commit this file** — add it to
   `.gitignore`.
2. Restart the server (close the window, double-click again).
3. Verify: `curl http://localhost:5173/api/deepseek/status` → `{"configured":true}`.

---

## Stopping / troubleshooting

| Problem | Fix |
|---|---|
| Server running, want to stop | Close the bat window, or press `Ctrl+C` in it. |
| Port 5173 stuck "in use" | `netstat -ano \| findstr :5173`, note the PID, then `taskkill /PID <pid> /F`. |
| Window opens and closes instantly | Run it from PowerShell: `cd F:\novelist\Gnovel` then `npm run dev` — the error text will stay visible. |
| "npm is not recognized" | Node.js is not installed / not on PATH. Install Node 18+ from https://nodejs.org. |

---

## Does the Preview tab still work?

Yes — but the Preview tab is tied to the Freebuff session. If you run the server
with the bat, you can also use it in the Preview tab while a session is active;
when the session ends, **your** bat window keeps the server alive for normal
browser use.
