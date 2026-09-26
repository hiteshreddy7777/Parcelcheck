# ParcelCheck — Full-Stack Damage Claim Builder

Turn a messy damaged-parcel experience (photos, a voice note, invoice details)
into one structured, ready-to-send claim — powered by the Sarvam AI stack.

## Stack

| Layer    | Tech                                             |
|----------|--------------------------------------------------|
| Frontend | Vanilla HTML/CSS/JS (no build step), served by Express |
| Backend  | Node.js + Express                                |
| Storage  | JSON file store (`data/claims.json`) — swap for SQLite/Postgres later |
| AI       | Saaras v3 (speech-to-text), gemma4 (image input), Sarvam-105B (structured report) via api.sarvam.ai |

## Quick start

```bash
npm install
npm start
```

Open http://localhost:3000 — the app runs in **demo mode** with simulated
model output (zero setup, no key needed). Click "Load sample claim" then
"Generate damage report" to see the full flow.

## Going live (real Sarvam AI calls)

1. Get an API key at https://dashboard.sarvam.ai
2. `cp .env.example .env` and set `SARVAM_API_KEY=sk_...`
3. Restart: `npm start` — the badge switches to LIVE API

In live mode:
- Voice notes are transcribed by **Saaras v3** on the server (23 languages).
- Package photos are analyzed by **gemma4** image input (beta).
- The structured claim is assembled by **Sarvam-105B** with a JSON response format.

The key is read server-side from the environment and never sent to the browser.

## API

| Method | Route                 | Body / Notes                                    |
|--------|-----------------------|-------------------------------------------------|
| GET    | /api/health           | `{mode: "live" \| "demo", pipeline: {...}}`      |
| POST   | /api/stt              | raw audio body (`audio/webm`), `?language=hi-IN` |
| POST   | /api/analyze-photos   | `{photos: [{name, dataUrl, tags}]}`             |
| POST   | /api/generate-report  | `{transcript, vision, photos, order}`           |
| POST   | /api/claims           | full claim JSON → persisted                      |
| GET    | /api/claims           | list saved claims                               |
| GET    | /api/claims/:id       | fetch one claim                                 |
| PATCH  | /api/claims/:id       | `{status: "draft"\|"submitted"\|"resolved"}`    |

## Project layout

```
parcelcheck-app/
├── server.js          Express app: routes, static serving, .env loader
├── lib/
│   ├── sarvam.js      Sarvam API client + demo fallbacks
│   └── store.js       JSON-file claims store
├── public/
│   ├── index.html     UI
│   ├── styles.css     UI styling
│   └── app.js         UI logic — calls the /api routes
├── data/claims.json   created at runtime (gitignored)
└── .env.example
```

## Notes & caveats

- Demo mode is fully deterministic — the same evidence produces the same report.
- Live-mode vision uses the `gemma4` image-input model (beta) since Sarvam
  Vision's own API is a document-intelligence job pipeline; the report uses
  `sarvam-105b`. If a live call fails, the server falls back to demo heuristics
  and says so in the response.
- For production, replace `lib/store.js` with a real database and add auth.
