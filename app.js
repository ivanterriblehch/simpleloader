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
      <input id="q" placeholder="search /" autocomplete="off" spellcheck="false">
      <div id="cols">
        <div><div class="dim">playlists / ${playlists.length}</div><ul id="list"></ul></div>
        <div>
          <div id="trhead" class="dim"><span>select a playlist</span></div>
          <ul id="tracks"></ul>
        </div>
      </div>
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
    $("#q").addEventListener("input", applyFilter);
    $("#q").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.target.value = ""; applyFilter(); e.target.blur(); }
      else if (e.key === "Enter" && e.target.value.trim()) showSearch(e.target.value.trim());
    });
    list.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) showTracks(b.parentNode, b.dataset.uri, b.textContent);
    });
  }

  // ---------- tracks column ----------
  let selected = null, currentUri = null, currentTrack = null, loadId = 0, searchUris = null, queueMode = null;

  function markPlaying() {
    document.querySelectorAll("#list li").forEach((li) =>
      li.classList.toggle("on", li.firstChild.dataset.uri === currentUri));
    document.querySelectorAll("#tracks li").forEach((li) =>
      li.classList.toggle("on", (searchUris || selected === currentUri) && currentTrack === li.firstChild.dataset.uri));
  }

  // Spotify won't list some playlists' tracks, but the play queue is readable.
  let queueTimer = null;
  async function refreshQueue(tries = 0) {
    clearTimeout(queueTimer);
    if (!queueMode || selected !== currentUri) return;
    const my = loadId, name = queueMode;
    try {
      const q = await api("/me/player/queue");
      if (my !== loadId || !queueMode) return;
      // Spotify's queue can lag a moment behind the player: wait until it matches.
      if (tries < 5 && q.currently_playing && currentTrack && q.currently_playing.uri !== currentTrack) {
        queueTimer = setTimeout(() => refreshQueue(tries + 1), 800);
        return;
      }
      const items = [q.currently_playing, ...(q.queue || [])].filter((t) => t && t.uri);
      $("#trhead").firstChild.textContent = name + " / up next / " + items.length + " (spotify hides the full list)";
      const ul = $("#tracks");
      ul.textContent = "";
      items.forEach((t, n) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        const artists = (t.artists || []).map((x) => x.name).join(", ");
        b.textContent = `${String(n).padStart(2, "0")}  ${t.name} / ${artists}`.toLowerCase();
        b.dataset.uri = t.uri;
        li.appendChild(b);
        ul.appendChild(li);
      });
      markPlaying();
      applyFilter();
    } catch (e) { /* keep whatever is shown */ }
  }

  function applyFilter() {
    const q = $("#q").value.trim().toLowerCase();
    document.querySelectorAll(searchUris ? "#list li" : "#list li, #tracks li").forEach((li) => {
      li.hidden = !!q && !li.firstChild.textContent.toLowerCase().includes(q);
    });
  }

  async function fetchTracks(id) {
    for (const kind of ["items", "tracks"]) {
      try {
        const out = [];
        let url = `/playlists/${id}/${kind}?limit=100`;
        while (url) {
          const page = await api(url);
          out.push(...page.items);
          url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
        }
        return out;
      } catch (e) { if (kind === "tracks") throw e; }
    }
  }

  async function showSearch(q) {
    const my = ++loadId;
    selected = null;
    searchUris = null;
    queueMode = null;
    document.querySelectorAll("#list li").forEach((x) => x.classList.remove("sel"));
    const head = $("#trhead"), ul = $("#tracks");
    head.innerHTML = "<span></span>";
    head.firstChild.textContent = "spotify: " + q + " / searching";
    ul.textContent = "";
    try {
      const r = await api("/search?type=track&limit=10&q=" + encodeURIComponent(q));
      if (my !== loadId) return;
      const found = (r.tracks.items || []).filter((t) => t && t.uri);
      searchUris = found.map((t) => t.uri);
      head.innerHTML = "<span></span><button id=\"playall\">play all</button>";
      head.firstChild.textContent = "spotify: " + q + " / " + found.length;
      found.forEach((t, n) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        const artists = (t.artists || []).map((x) => x.name).join(", ");
        b.textContent = `${String(n + 1).padStart(2, "0")}  ${t.name} / ${artists}`.toLowerCase();
        b.dataset.uri = t.uri;
        li.appendChild(b);
        ul.appendChild(li);
      });
      markPlaying();
    } catch (e) {
      if (my === loadId) head.firstChild.textContent = "spotify: " + q + " / search failed (" + e.message + ")";
    }
  }

  async function showTracks(li, uri, name) {
    const my = ++loadId;
    selected = uri;
    searchUris = null;
    queueMode = null;
    document.querySelectorAll("#list li").forEach((x) => x.classList.toggle("sel", x === li));
    const head = $("#trhead"), ul = $("#tracks");
    head.innerHTML = "<span></span>";
    head.firstChild.textContent = name + " / loading";
    ul.textContent = "";
    try {
      const items = await fetchTracks(uri.split(":").pop());
      if (my !== loadId) return;
      const rows = [];
      items.forEach((it, i) => {
        const t = it && (it.item || it.track);
        if (t && t.uri) rows.push({ t, i });
      });
      head.innerHTML = "<span></span><button id=\"playall\">play all</button>";
      head.firstChild.textContent = name + " / " + rows.length;
      const pad = String(rows.length).length;
      rows.forEach(({ t, i }, n) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        const artists = (t.artists || []).map((x) => x.name).join(", ");
        b.textContent = `${String(n + 1).padStart(pad, "0")}  ${t.name} / ${artists}`.toLowerCase();
        b.dataset.uri = t.uri;
        b.dataset.pos = i;
        li.appendChild(b);
        ul.appendChild(li);
      });
      markPlaying();
      applyFilter();
    } catch (e) {
      if (my !== loadId) return;
      const blocked = /\b(403|404)$/.test(e.message);
      head.innerHTML = "<span></span><button id=\"playall\">play all</button>";
      head.firstChild.textContent = name + (blocked
        ? " / spotify won't list this playlist's tracks to this app. play all still works"
        : " / can't load tracks (" + e.message + ")");
      if (blocked) { queueMode = name; refreshQueue(); }
    }
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
    let deviceId, shuffle = false;
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
      const prev = currentTrack;
      currentTrack = t && ((t.linked_from && t.linked_from.uri) || t.uri);
      markPlaying();
      if (currentTrack !== prev) refreshQueue();
    });
    player.connect();

    const playContext = async (uri, position) => {
      if (!deviceId) return;
      await player.activateElement();
      await api("/me/player/shuffle?state=" + shuffle + "&device_id=" + deviceId, { method: "PUT" });
      await api("/me/player/play?device_id=" + deviceId, { method: "PUT", body: JSON.stringify(position == null ? { context_uri: uri } : { context_uri: uri, offset: { position } }) });
    };

    const playUris = async (uris) => {
      if (!deviceId) return;
      await player.activateElement();
      await api("/me/player/play?device_id=" + deviceId, { method: "PUT", body: JSON.stringify({ uris }) });
    };
    const fail = (err) => ($("#now").textContent = err.message);
    $("#tracks").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || queueMode) return;
      if (searchUris) playUris([b.dataset.uri]).catch(fail);
      else if (selected) playContext(selected, Number(b.dataset.pos)).catch(fail);
    });
    $("#trhead").addEventListener("click", (e) => {
      if (e.target.id !== "playall") return;
      if (searchUris) playUris(searchUris).catch(fail);
      else if (selected) playContext(selected).catch(fail);
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
      if (e.target.tagName === "INPUT") return;
      if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
      else if (e.code === "Space") { e.preventDefault(); player.togglePlay(); }
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
