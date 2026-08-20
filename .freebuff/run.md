# OmniNovel — Preview run doc

## Reproduce uncommitted artifacts

- No `.env*` files exist in this project; the app reads API config from the
  browser's localStorage at runtime, so nothing needs copying.
- Install dependencies with `npm install` if `node_modules/` is missing.
- Dev server uses Vite (`npm run dev`, default port 5173). No build step is
  required for development — Vite serves `index.html` + `src/` directly with HMR.
- Port fallback: port 5173 is sometimes occupied by another project's dev server
  (e.g. `F:\novelist\omninovel`). In that case run on a free port with
  `npm run dev -- --port 5174 --strictPort` and register the preview on that URL.

## Run the server

### User-run (recommended for the user, survives session restarts)

- `start-dev-server.bat` at the project root is a double-click launcher that runs
  Vite in a visible window owned by the user's Windows session — it does NOT die
  when a Freebuff session ends (background agent processes do). See
  `DEV-SERVER-GUIDE.md` for the full user tutorial.
- Autostart: `install-autostart.bat` / `uninstall-autostart.bat` register a
  minimized Startup-folder shortcut (installed on this PC, target
  `start-dev-server.bat`). Note the user may therefore already have a server
  running on 5173 or 5174 at login — check before starting the agent preview.
- Optional DeepSeek proxy key: the bat loads `DEEPSEEK_API_KEY` from a
  `dev-server.env` file placed next to it (never committed) if present.

### Agent-run (this session's preview; dies with the session)

```powershell
powershell -NoProfile -Command "(Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -RedirectStandardOutput '<log>' -RedirectStandardError '<log>.err' -WindowStyle Hidden -PassThru).Id"
```

- stdout and stderr must go to different files (PowerShell restriction).
- Prefer port 5173; if busy, `npm run dev -- --port 5174 --strictPort`.
- The agent-launched server is killed when the session ends — if the user needs
  a long-lived server, point them at `start-dev-server.bat` instead.

### DeepSeek proxy (optional, no in-browser key needed)

- The dev server exposes `GET /api/deepseek/status` and `POST /api/deepseek/chat`
  (src/server/deepseek-proxy.ts). When `DEEPSEEK_API_KEY` is set in the server
  environment, the app's DeepSeek provider routes through the proxy with NO key
  entered in the browser; otherwise it falls back to the in-browser key.
- To enable, set the env var when starting the server (PowerShell:
  `$env:DEEPSEEK_API_KEY="sk-..."; npm run dev`) — never commit the key itself.
- Verify: `curl http://localhost:5173/api/deepseek/status` → `{"configured":true}`.
  Without the var it returns `{"configured":false}` and chat POSTs get a 503 with
  a helpful message.
- Dev-server only: the single-file build (dist/index.html) has no server, so
  production users use the in-browser key path.
- Confirm survival: `powershell -NoProfile -Command "Get-Process -Id <pid>"`.
- Verify the URL answers before registering the preview, e.g.
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` (expect 200).
- To stop: `powershell -NoProfile -Command "Stop-Process -Id <pid>"` (kills the
  npm wrapper; also kill the `node.exe` child via `Get-CimInstance Win32_Process
  -Filter "CommandLine LIKE '%vite%'"` if the port stays busy).
