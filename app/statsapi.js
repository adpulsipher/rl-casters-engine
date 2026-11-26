'use strict';
// Client for Rocket League's official Stats API: a local TCP socket that streams
// back-to-back JSON messages {"Event": "...", "Data": ...} during matches.

const net = require('net');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

// Splits a stream of concatenated JSON objects into complete objects.
class JsonSplitter {
  constructor(onObject) { this.onObject = onObject; this.reset(); }
  reset() { this.buf = ''; this.depth = 0; this.inStr = false; this.esc = false; this.start = -1; this.pos = 0; }
  push(chunk) {
    this.buf += chunk;
    let i = this.pos;
    for (; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === '\\') this.esc = true;
        else if (c === '"') this.inStr = false;
        continue;
      }
      if (c === '"') { if (this.depth > 0) this.inStr = true; continue; }
      if (c === '{' || c === '[') { if (this.depth === 0) this.start = i; this.depth++; continue; }
      if (c === '}' || c === ']') {
        if (this.depth === 0) continue;
        this.depth--;
        if (this.depth === 0 && this.start >= 0) {
          const text = this.buf.slice(this.start, i + 1);
          this.buf = this.buf.slice(i + 1); i = -1; this.start = -1;
          try { this.onObject(JSON.parse(text)); } catch (e) { /* skip a broken message */ }
        }
      }
    }
    if (this.depth === 0) { this.buf = ''; this.pos = 0; } else this.pos = i;
    if (this.buf.length > 8 * 1024 * 1024) this.reset(); // never grow without bound
  }
}

class StatsClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 49123, log }) {
    super();
    Object.assign(this, { host, port, log });
    this.connected = false;
    this.stopped = false;
    this.lastWaitLog = 0;
  }
  start() { this.connect(); }
  stop() { this.stopped = true; try { this.sock && this.sock.destroy(); } catch (e) {} }

  connect() {
    if (this.stopped) return;
    const sock = net.connect({ host: this.host, port: this.port });
    this.sock = sock;
    const decoder = new StringDecoder('utf8');
    const splitter = new JsonSplitter((msg) => this.handle(msg));
    sock.setNoDelay(true);
    sock.on('connect', () => {
      this.connected = true;
      this.log(`Connected to Rocket League (port ${this.port}). The casters are live.`);
      this.emit('status', 'connected');
    });
    sock.on('data', (d) => splitter.push(decoder.write(d)));
    const retry = () => {
      if (this.connected) {
        this.connected = false;
        this.log('Rocket League disconnected. Waiting for it to come back...');
        this.emit('status', 'disconnected');
      } else if (Date.now() - this.lastWaitLog > 60000) {
        this.lastWaitLog = Date.now();
        this.log('Waiting for Rocket League match data... (start Rocket League / a career match)');
      }
      sock.removeAllListeners();
      sock.destroy();
      if (!this.stopped) setTimeout(() => this.connect(), 2000);
    };
    sock.on('error', () => {});
    sock.on('close', retry);
  }

  handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const name = msg.Event || msg.event;
    let data = msg.Data !== undefined ? msg.Data : msg.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
    if (!name) return;
    this.emit('event', name, data || {});
  }
}

module.exports = { StatsClient, JsonSplitter };
