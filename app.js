(() => {
  const SCOPES = [
    "streaming", "user-read-email", "user-read-private",
    "user-read-playback-state", "user-modify-playback-state",
    "playlist-read-private", "playlist-read-collaborative",
  ].join(" ");
  const REDIRECT = location.origin + location.pathname;
  const CLIENT_ID = window.CONFIG.clientId;
  const $ = (s) => document.querySelector(s);
  const app = $("#app");
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- auth (PKCE, no backend) ----------
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const rand = (n = 64) => b64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);

  async function login() {
    const verifier = rand(96);
    store.set("verifier", verifier);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    location.href = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT,
      scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge,
    });
  }

  async function tokenRequest(params) {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
    });
    if (!r.ok) throw new Error("auth failed");
    const t = await r.json();
    store.set("access", t.access_token);
    store.set("expires", String(Date.now() + t.expires_in * 1000 - 60000));
    if (t.refresh_token) store.set("refresh", t.refresh_token);
    return t.access_token;
  }

  async function token() {
    if (store.get("access") && Date.now() < Number(store.get("expires"))) return store.get("access");
    const refresh = store.get("refresh");
    if (!refresh) throw new Error("no session");
    return tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
  }

  async function api(path, opts = {}) {
    const r = await fetch("https://api.spotify.com/v1" + path, {
      ...opts, headers: { Authorization: "Bearer " + (await token()), "Content-Type": "application/json" },
    });
    if (!r.ok && r.status !== 204) throw new Error(path + " " + r.status);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  // ---------- ui ----------
  function msg(text) { app.textContent = text; }

  function render(playlists) {
    app.innerHTML = `
      <div class="dim">playlists / ${playlists.length}</div>
      <ul id="list"></ul>
      <div id="bar">
        <div id="now" class="dim">-</div>
        <button id="prev">prev</button>
        <button id="toggle">play</button>
        <button id="next">next</button>
        <button id="shuffle">shuffle: off</button>
        <button id="logout" class="dim">logout</button>
      </div>`;
    const list = $("#list");
    playlists.forEach((p) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.textContent = p.name.toLowerCase();
      b.dataset.uri = p.uri;
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  async function loadPlaylists() {
    const out = [];
    let url = "/me/playlists?limit=50";
    while (url) {
      const page = await api(url);
      out.push(...page.items.filter(Boolean));
      url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
    }
    return out;
  }

  // ---------- player ----------
  function startPlayer() {
    let deviceId, shuffle = false, currentUri = null;
    const player = new Spotify.Player({
      name: "loader", volume: 0.8,
      getOAuthToken: (cb) => token().then(cb),
    });
    player.addListener("ready", ({ device_id }) => { deviceId = device_id; $("#now").textContent = "ready"; });
    player.addListener("authentication_error", () => msg("auth error. reload."));
    player.addListener("account_error", () => msg("spotify premium required for playback."));
    player.addListener("player_state_changed", (s) => {
      if (!s) return;
      const t = s.track_window.current_track;
      $("#now").textContent = t ? `${t.name} / ${t.artists.map((a) => a.name).join(", ")}`.toLowerCase() : "-";
      $("#toggle").textContent = s.paused ? "play" : "pause";
      currentUri = s.context && s.context.uri;
      document.querySelectorAll("#list li").forEach((li) =>
        li.classList.toggle("on", li.firstChild.dataset.uri === currentUri));
    });
    player.connect();

    const playContext = async (uri) => {
      if (!deviceId) return;
      await player.activateElement();
      await api("/me/player/shuffle?state=" + shuffle + "&device_id=" + deviceId, { method: "PUT" });
      await api("/me/player/play?device_id=" + deviceId, { method: "PUT", body: JSON.stringify({ context_uri: uri }) });
    };

    $("#list").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) playContext(b.dataset.uri).catch((err) => ($("#now").textContent = err.message));
    });
    $("#prev").onclick = () => player.previousTrack();
    $("#next").onclick = () => player.nextTrack();
    $("#toggle").onclick = () => player.togglePlay();
    $("#shuffle").onclick = async () => {
      shuffle = !shuffle;
      $("#shuffle").textContent = "shuffle: " + (shuffle ? "on" : "off");
      if (deviceId) api("/me/player/shuffle?state=" + shuffle + "&device_id=" + deviceId, { method: "PUT" }).catch(() => {});
    };
    $("#logout").onclick = () => { ["access", "expires", "refresh", "verifier"].forEach(store.del); location.reload(); };
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space") { e.preventDefault(); player.togglePlay(); }
      else if (e.key === "ArrowRight") player.nextTrack();
      else if (e.key === "ArrowLeft") player.previousTrack();
    });
  }

  // ---------- boot ----------
  async function boot() {
    if (CLIENT_ID.startsWith("PASTE")) return msg("set clientId in config.js");
    $("#login").onclick = login;
    const code = new URLSearchParams(location.search).get("code");
    try {
      if (code) {
        await tokenRequest({
          grant_type: "authorization_code", code, redirect_uri: REDIRECT,
          code_verifier: store.get("verifier") || "",
        });
        history.replaceState({}, "", REDIRECT);
      }
      if (!store.get("refresh")) return;
      msg("loading");
      const playlists = await loadPlaylists();
      render(playlists);
      window.onSpotifyWebPlaybackSDKReady = startPlayer;
      const s = document.createElement("script");
      s.src = "https://sdk.scdn.co/spotify-player.js";
      document.head.appendChild(s);
    } catch (e) {
      ["access", "expires", "refresh"].forEach(store.del);
      app.innerHTML = '<button id="login">connect spotify</button>';
      $("#login").onclick = login;
    }
  }
  boot();
})();
