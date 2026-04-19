# Audio assets (in Git)

These files are **committed to the repository** under `assets/sound/` as normal Git blobs (not Git LFS). They are required for the game’s SFX and music in production (e.g. Vercel) and for local `index.html` runs.

- **effects/** — `*.wav` / `*.mp3` (cannon, voices, ambient, UI-adjacent cues)
- **music/** — `track1.mp3` … `track6.mp3` (background playlist)

If audio is silent in the browser, check the in-game **volume** slider and tap/click once after load (autoplay policies). The game resolves paths from `document.baseURI` and preloads the cannon sample for reliable playback after the 1s broadside delay.
