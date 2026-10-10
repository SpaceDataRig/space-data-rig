// Space Data Rig :: live transport, shaped to look like EventSource.
//
// Two backends serve the SAME messages, and connectLive() picks the right one so
// app.js is transport-agnostic:
//   - Cloudflare edge: a Durable Object WebSocket (Hibernation) at /api/events.
//   - Local Node server: the legacy SSE endpoint at /api/events (EventSource).
//
// Strategy: try WebSocket first (the edge path). If the socket never opens within a
// couple of attempts -- e.g. we are talking to the Node SSE server -- fall back
// permanently to EventSource. Either way the object returned exposes addEventListener
// ("hello" | "log" | "state" | ...) and delivers { data: <string> }, exactly like a
// MessageEvent, so callers keep doing JSON.parse(e.data).
//
// WS wire protocol (from the DO): every frame is JSON.stringify({ event, id?, data }).
// We re-stringify `data` so its string matches the SSE `data:` line byte-for-byte.
//
// Reliability: exponential backoff reconnect (1.5s -> 15s cap) plus a 20s "ping"
// keepalive the DO answers with an automatic "pong" (WebSocketRequestResponsePair),
// which also keeps the Hibernated connection warm across idle periods.

export function connectLive(url) {
  const listeners = new Map(); // type -> Set<callback>
  let ws = null;
  let es = null; // EventSource fallback
  let closed = false;
  let opened = false;
  let attempt = 0;
  let fellBack = false;
  let pingTimer = null;

  const wsUrl = toWsUrl(url);
  const httpUrl = url; // original http(s) URL for the SSE fallback

  function emit(type, evObj) {
    const set = listeners.get(type);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(evObj);
      } catch {
        /* a listener throwing must not kill the stream */
      }
    }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send("ping");
        } catch {
          /* ignore; onclose triggers reconnect/fallback */
        }
      }
    }, 20000);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function fireError() {
    emit("error", {});
    if (typeof api.onerror === "function") {
      try {
        api.onerror({});
      } catch {
        /* ignore */
      }
    }
  }

  // ---- WebSocket backend ---------------------------------------------------

  function scheduleReconnect() {
    if (closed || fellBack) return;
    // Never managed to open a WebSocket: the server likely speaks SSE -> fall back.
    if (!opened && attempt >= 1) {
      startEventSourceFallback();
      return;
    }
    attempt += 1;
    const delay = Math.min(1500 * 2 ** (attempt - 1), 15000);
    setTimeout(open, delay);
  }

  function open() {
    if (closed || fellBack) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    api.readyState = WebSocket.CONNECTING;

    ws.onopen = () => {
      opened = true;
      attempt = 0;
      api.readyState = WebSocket.OPEN;
      startPing();
      emit("open", {});
    };

    ws.onmessage = (msg) => {
      // Non-JSON frames are transport keepalive replies (e.g. "pong") -- ignore them.
      let frame;
      try {
        frame = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!frame || typeof frame.event !== "string") return;
      const payload = frame.data === undefined ? "" : JSON.stringify(frame.data);
      emit(frame.event, { type: frame.event, data: payload, lastEventId: frame.id });
    };

    ws.onerror = () => fireError();

    ws.onclose = () => {
      api.readyState = WebSocket.CLOSED;
      stopPing();
      if (closed) return;
      if (typeof api.onclose === "function") {
        try {
          api.onclose({});
        } catch {
          /* ignore */
        }
      }
      scheduleReconnect();
    };
  }

  // ---- EventSource fallback (local Node SSE server) ------------------------

  function startEventSourceFallback() {
    if (fellBack || closed || typeof EventSource === "undefined") return;
    fellBack = true;
    stopPing();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    es = new EventSource(httpUrl);
    api.readyState = WebSocket.CONNECTING;
    es.onopen = () => {
      opened = true;
      api.readyState = WebSocket.OPEN;
      emit("open", {});
    };
    es.onerror = () => fireError();
    // Attach every listener already registered (any added later hook up in addEventListener).
    for (const [type, set] of listeners) {
      for (const cb of set) es.addEventListener(type, (e) => cb(e));
    }
  }

  const api = {
    url: wsUrl,
    readyState: WebSocket.CONNECTING,
    onerror: null,
    onopen: null,
    onclose: null,
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
      if (fellBack && es) es.addEventListener(type, (e) => cb(e));
      return api;
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
      return api;
    },
    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          /* ignore */
        }
      } else if (fellBack && es) {
        // SSE is server->client only; "refresh" is a no-op over the one-way stream.
      }
      return api;
    },
    close() {
      closed = true;
      stopPing();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      if (es) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
      }
    },
  };

  open();
  return api;
}

function toWsUrl(url) {
  try {
    const u = new URL(url, self.location.href);
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol === "http:") u.protocol = "ws:";
    return u.href;
  } catch {
    return url;
  }
}
