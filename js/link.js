// Phone <-> car link.
//
// The car display is the "host": it registers a peer id derived from its
// pairing code. Phones connect to that id. Transport is WebRTC via PeerJS,
// so the two devices talk directly (or through a TURN relay when the phone's
// hotspot NAT blocks a direct path). A BroadcastChannel transport is also
// available for trying both screens in one browser (?transport=local).
//
// Messages are plain JSON objects with a `t` (type) field.

const PREFIX = 'carauto-v1-';
const HEARTBEAT_MS = 8000;
const STALE_MS = 25000;

export function peerIdFor(code) {
  return PREFIX + String(code).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function transportFromUrl() {
  return new URLSearchParams(location.search).get('transport') === 'local' ? 'local' : 'peer';
}

function peerOptions(server) {
  const opts = { debug: 0 };
  if (server && server.host) {
    Object.assign(opts, {
      host: server.host,
      port: Number(server.port) || 443,
      path: server.path || '/',
      secure: server.secure !== false,
      key: server.key || 'peerjs',
    });
  }
  return opts;
}

class Base extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
    return this;
  }
}

// ---------------------------------------------------------------------------
// Car side
// ---------------------------------------------------------------------------
export class CarHost extends Base {
  constructor(code, { transport = 'peer', server = null } = {}) {
    super();
    this.code = code;
    this.transport = transport;
    this.server = server;
    this.clients = new Map(); // id -> { send, lastSeen, close }
    this.state = 'offline';
    this._timers = [];
  }

  get clientCount() {
    return this.clients.size;
  }

  start() {
    this._stopped = false;
    if (this.transport === 'local') this._startLocal();
    else this._startPeer();
    this._timers.push(setInterval(() => this._heartbeat(), HEARTBEAT_MS));
  }

  stop() {
    this._stopped = true;
    this._timers.forEach(clearInterval);
    this._timers = [];
    clearTimeout(this._retry);
    for (const c of this.clients.values()) c.close?.();
    this.clients.clear();
    this.peer?.destroy();
    this.channel?.close();
  }

  broadcast(msg) {
    for (const c of this.clients.values()) c.send(msg);
  }

  _status(state, message = '') {
    this.state = state;
    this.emit('status', { state, message });
  }

  _addClient(id, send, close) {
    this.clients.set(id, { send, close, lastSeen: Date.now() });
    this.emit('clients', { count: this.clients.size });
    this.emit('join', { id, send });
  }

  _removeClient(id) {
    if (this.clients.delete(id)) this.emit('clients', { count: this.clients.size });
  }

  _receive(id, msg) {
    const c = this.clients.get(id);
    if (c) c.lastSeen = Date.now();
    if (!msg || typeof msg !== 'object' || msg.t === 'ping') return;
    this.emit('message', { id, msg, reply: (m) => c?.send(m) });
  }

  _heartbeat() {
    const now = Date.now();
    for (const [id, c] of this.clients) {
      if (now - c.lastSeen > STALE_MS) {
        c.close?.();
        this._removeClient(id);
      } else {
        c.send({ t: 'ping' });
      }
    }
  }

  _startLocal() {
    this.channel = new BroadcastChannel(peerIdFor(this.code));
    this.channel.onmessage = ({ data }) => {
      if (!data || data.to !== 'car') return;
      const { from, msg } = data;
      if (msg?.t === 'hello' && !this.clients.has(from)) {
        this._addClient(from, (m) => this.channel.postMessage({ to: from, msg: m }), null);
      }
      if (msg?.t === 'bye') return this._removeClient(from);
      if (this.clients.has(from)) this._receive(from, msg);
    };
    this._status('online');
  }

  _startPeer() {
    if (!window.Peer) {
      this._status('error', 'Connection library failed to load');
      return;
    }
    const peer = new window.Peer(peerIdFor(this.code), peerOptions(this.server));
    this.peer = peer;
    this._status('connecting');

    peer.on('open', () => this._status('online'));
    peer.on('connection', (conn) => {
      const id = conn.connectionId;
      conn.on('open', () => this._addClient(id, (m) => conn.open && conn.send(m), () => conn.close()));
      conn.on('data', (d) => this._receive(id, d));
      conn.on('close', () => this._removeClient(id));
      conn.on('error', () => this._removeClient(id));
    });
    peer.on('disconnected', () => {
      if (this._stopped || peer.destroyed) return;
      this._status('connecting', 'Reconnecting to pairing server…');
      setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
    });
    peer.on('error', (err) => {
      if (this._stopped) return;
      const msg = err.type === 'unavailable-id'
        ? 'This pairing code is busy (is the car app open in another tab?). Retrying…'
        : err.type === 'browser-incompatible'
          ? 'This browser does not support WebRTC'
          : 'No internet connection to the pairing server. Retrying…';
      this._status('error', msg);
      if (err.type === 'browser-incompatible') return;
      peer.destroy();
      clearTimeout(this._retry);
      this._retry = setTimeout(() => this._startPeer(), err.type === 'unavailable-id' ? 10000 : 5000);
    });
  }
}

// ---------------------------------------------------------------------------
// Phone side
// ---------------------------------------------------------------------------
export class PhoneClient extends Base {
  constructor(code, { transport = 'peer', server = null, name = 'Phone' } = {}) {
    super();
    this.code = code;
    this.transport = transport;
    this.server = server;
    this.name = name;
    this.queue = [];
    this.connected = false;
    this.lastRx = 0;
    this.backoff = 2000;
    this.id = Math.random().toString(36).slice(2);
  }

  start() {
    this._stopped = false;
    this._connect();
    this._watch = setInterval(() => {
      if (this.connected && Date.now() - this.lastRx > STALE_MS) this._dropped('Lost connection to car');
      if (this.connected) this._rawSend({ t: 'ping' });
    }, HEARTBEAT_MS);
    this._onVisible = () => {
      if (document.visibilityState === 'visible' && !this.connected) this._connect();
    };
    document.addEventListener('visibilitychange', this._onVisible);
  }

  stop() {
    this._stopped = true;
    clearInterval(this._watch);
    clearTimeout(this._retry);
    document.removeEventListener('visibilitychange', this._onVisible);
    if (this.transport === 'local') this.channel?.postMessage({ to: 'car', from: this.id, msg: { t: 'bye' } });
    this.conn?.close();
    this.peer?.destroy();
    this.channel?.close();
    this.connected = false;
  }

  // Queue messages while disconnected so actions taken during reconnects
  // (or a share that opened the app) are delivered once the car is reached.
  send(msg) {
    if (this.connected) this._rawSend(msg);
    else {
      // keep only the latest GPS fix / volume in the queue
      if (msg.t === 'gps' || msg.t === 'media') this.queue = this.queue.filter((m) => m.t !== msg.t || (msg.t === 'media' && m.cmd !== msg.cmd));
      this.queue.push(msg);
    }
  }

  _rawSend(msg) {
    if (this.transport === 'local') this.channel.postMessage({ to: 'car', from: this.id, msg });
    else if (this.conn?.open) this.conn.send(msg);
  }

  _status(state, message = '') {
    this.emit('status', { state, message });
  }

  _connected() {
    this.connected = true;
    this.backoff = 2000;
    this.lastRx = Date.now();
    this._status('connected');
    this._rawSend({ t: 'hello', name: this.name });
    const q = this.queue;
    this.queue = [];
    q.forEach((m) => this._rawSend(m));
  }

  _dropped(message) {
    const was = this.connected;
    this.connected = false;
    this.conn?.close();
    this.conn = null;
    if (was || message) this._status('disconnected', message || 'Disconnected');
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._stopped) return;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this._connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.6, 15000);
  }

  _receive(msg) {
    this.lastRx = Date.now();
    if (!msg || msg.t === 'ping') return;
    this.emit('message', msg);
  }

  _connect() {
    if (this._stopped || this.connected) return;
    this._status('connecting');
    if (this.transport === 'local') return this._connectLocal();
    if (!window.Peer) return this._status('error', 'Connection library failed to load');

    if (!this.peer || this.peer.destroyed) {
      const peer = new window.Peer(peerOptions(this.server));
      this.peer = peer;
      peer.on('open', () => this._dial());
      peer.on('disconnected', () => !peer.destroyed && setTimeout(() => !peer.destroyed && peer.reconnect(), 1500));
      peer.on('error', (err) => {
        if (this._stopped) return;
        if (err.type === 'peer-unavailable') {
          this._status('error', 'Car not found. Is the car app open and online?');
        } else {
          this._status('error', 'No connection to the pairing server. Retrying…');
          peer.destroy();
        }
        this._dropped();
      });
    } else if (this.peer.open) {
      this._dial();
    }
  }

  _dial() {
    if (this.connected) return;
    const conn = this.peer.connect(peerIdFor(this.code), { reliable: true, serialization: 'json' });
    conn.on('open', () => {
      this.conn = conn;
      this._connected();
    });
    conn.on('data', (d) => this._receive(d));
    conn.on('close', () => this.conn === conn && this._dropped('Disconnected from car'));
    conn.on('error', () => this.conn === conn && this._dropped('Connection error'));
  }

  _connectLocal() {
    if (!this.channel) {
      this.channel = new BroadcastChannel(peerIdFor(this.code));
      this.channel.onmessage = ({ data }) => {
        if (!data || data.to !== this.id) return;
        if (!this.connected) this._connected();
        this._receive(data.msg);
      };
    }
    this.channel.postMessage({ to: 'car', from: this.id, msg: { t: 'hello', name: this.name } });
    this._scheduleRetry();
  }
}
