# Silent Disco Sync

Turn a group of phones into one synchronized sound system. A host opens a room, guests scan a
QR code, and at a scheduled instant every phone starts the same audio within a few milliseconds
of the others.

**Live:** https://silent-disco-sync.onrender.com (free tier: the first visit after ~15 min idle takes ~30-60 s to wake)

> Work in progress. The full README (architecture, how clock sync works, measured accuracy)
> lands in Phase 6.

## Local setup

```bash
nvm use            # Node 20.19+
npm install
npm run dev        # server on :3000, client on :5173 (also on your LAN IP)
```

Open the "Network" URL Vite prints (e.g. `http://192.168.1.20:5173`) on your laptop so the QR
code points at an address phones can reach.

## Scripts

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Server (tsx watch) and Vite dev server together |
| `npm run build`     | Build client, then bundle server                |
| `npm start`         | Run the production server (serves client + ws)  |
| `npm test`          | Vitest unit and integration tests               |
| `npm run lint`      | ESLint                                          |
| `npm run typecheck` | Strict TypeScript across all packages           |
