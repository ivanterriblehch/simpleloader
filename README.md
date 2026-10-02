# loader

Text-only Spotify player: your playlists, a track column, a now-playing line, prev/play/next/shuffle. Nothing else.

## Setup
1. Create an app at https://developer.spotify.com/dashboard and add a Redirect URI, e.g. `http://127.0.0.1:8080/`.
2. Put the Client ID in `config.js`.
3. Optional: put your licensed Akkurat Mono at `fonts/AkkuratMono.woff2` (or install it locally). Falls back to system mono.
4. Serve it: `python3 -m http.server 8080` and open `http://127.0.0.1:8080/`.

Requires Spotify Premium (Web Playback SDK). Keys: space = play/pause, left/right = prev/next, / = search, esc = clear search.

## Quality
Spotify's Web Playback SDK and Web API expose no quality setting, so there is no toggle here.
The browser player streams at Spotify's own fixed rate. For a quality choice, set it in the
desktop app (Settings > Audio quality) and control that app via Spotify Connect instead.
