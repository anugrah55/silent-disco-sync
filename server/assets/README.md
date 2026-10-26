# Track library

`tracks.json` lists the tracks the server offers. Each entry points at an audio file in this
folder (mp3, m4a or wav, max 12 MB). A missing file is listed as unavailable instead of
crashing the server.

## Bundled tracks

The three bundled tracks (`neon-pulse`, `night-drive`, `afterglow`) are original music
synthesized by `server/scripts/generate-tracks.ts` and released as CC0. Regenerate them with:

```bash
npm run tracks:generate -w server
```

They are 32 kHz mono **WAV** on purpose: MP3 and AAC encoders prepend priming samples
(~25-50 ms) that browsers trim inconsistently, which would put a Chrome phone and a Safari
phone out of sync before any sync code runs. WAV starts on sample 0 everywhere.

The **click track** (120 BPM sync test signal) is synthesized on each device and needs no file.

## Adding your own

Add the file here and an entry to `tracks.json`:

```json
{ "id": "my-track", "title": "My Track", "artist": "Someone", "file": "my-track.wav", "bpm": 120 }
```

Good sources of CC0 / royalty-free music:

- **Free Music Archive** — https://freemusicarchive.org (filter by license: CC0)
- **Pixabay Music** — https://pixabay.com/music/ (Pixabay Content License, no attribution needed)
- **ccMixter** — https://ccmixter.org (check each track; prefer CC0 / CC BY)
- **OpenGameArt (music)** — https://opengameart.org (filter CC0)
- **Kevin MacLeod / incompetech** — https://incompetech.com (CC BY 4.0, attribution required)

Pick tracks with a clear, steady beat: a kick on every beat makes any echo between phones easy to hear.
