import * as THREE from 'three';
import * as P from '../shared/protocol.mjs';
import { Avatar } from './avatar';
import type { Ground } from './player';

interface Remote { avatar: Avatar; target: THREE.Vector3; yaw: number; flags: number; lastSeen: number; speed: number; prev: THREE.Vector3 }
/** What we need to know about ourselves to build a STATE packet (the Player satisfies this). */
export interface Me { pos: THREE.Vector3; yaw: number; pitch: number; flying: boolean; airborne: boolean; speed: number }

/**
 * Client side of the relay: streams our state at 10 Hz and keeps the nearby residents interpolated.
 * Works offline too — if the socket never opens, `online` stays false and everything local keeps running.
 */
export class Net {
  ws: WebSocket | null = null;
  online = false;
  myId = 0;
  remotes = new Map<number, Remote>();
  /** Every player's last broadcast map position (id -> x,z), refreshed every few seconds; covers players far outside our snapshot range. */
  roster = new Map<number, { x: number; z: number }>();
  private rosterBuf: { id: number; x: number; z: number }[] = [];
  private players: any[] = [];
  private sendAcc = 0;
  rttMs = 0;
  private pingT = 0;
  onlineCount = 1;

  private retryMs = 1000;
  private lastSent = 0;
  yOffset = () => 0; // hook kept for a future frame change; heights are shared as-is (Google's native frame)
  ground: Ground | null = null;
  /** Any message type this class doesn't handle itself (pins ride on these). */
  onPacket: ((dv: DataView) => void) | null = null;
  /** Names by player id, learned from NAME broadcasts and WHO replies; ids are recycled, so forget a name when its player drops out of view. */
  names = new Map<number, string>();
  private asked = new Set<number>();
  name = P.DEFAULT_NAME;
  /** Random per-browser id: the relay recognises us across a reconnect. */
  private token = (() => { try { let t = +(localStorage.getItem('player_token') ?? 0); if (!t) { t = (Math.random() * 0xfffffffe + 1) >>> 0; localStorage.setItem('player_token', String(t)); } return t; } catch { return (Math.random() * 0xfffffffe + 1) >>> 0; } })();
  private evt: any = {};
  private paused = false; private hideT: ReturnType<typeof setTimeout> | null = null;
  constructor(private scene: THREE.Scene, private url: string, private me: Me) {
    this.connect();
    // rAF stops in background tabs; timers only slow to 1 Hz, which keeps us under the relay's 10 s silence timeout...
    setInterval(() => { if (performance.now() - this.lastSent > 900) this.sendState(); }, 1000);
    // ...until Chrome throttles a long-hidden tab to one timer a minute. Then we'd ghost: kicked, reconnect, kicked. So a tab hidden
    // for 45 s leaves the relay on purpose and comes back the moment it's visible again (offline use keeps working meanwhile).
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (!this.hideT) this.hideT = setTimeout(() => { this.hideT = null; this.paused = true; this.ws?.close(1000, 'hidden'); }, 45000); }
      else { if (this.hideT) { clearTimeout(this.hideT); this.hideT = null; } if (this.paused) { this.paused = false; this.retryMs = 1000; if (!this.ws) this.connect(); } }
    });
  }

  /** Raw send; silently dropped while offline. */
  send(buf: ArrayBuffer) { if (this.online && this.ws) this.ws.send(buf); }

  /** Encode our current state (fresh every call, never a cached packet: a background tab must still report where it is). */
  private sendState() {
    if (!this.online || !this.ws) return;
    const me = this.me, off = this.yOffset();
    this.ws.send(P.encodeState(me.pos.x, me.pos.y - off, me.pos.z, me.yaw, me.pitch,
      (me.flying ? P.FLAG.FLYING : 0) | (me.speed > 0.5 ? P.FLAG.MOVING : 0) | (me.airborne ? P.FLAG.AIRBORNE : 0)));
    this.lastSent = performance.now();
  }

  /** Connect, and keep reconnecting with capped backoff if the relay drops us (offline use continues meanwhile). */
  private connect() {
    try {
      const ws = new WebSocket(this.url); ws.binaryType = 'arraybuffer'; this.ws = ws;
      // report a position right away: a tab opened in the background never runs a frame, and the relay kicks silent sockets after 10 s
      ws.onopen = () => { this.online = true; this.retryMs = 1000; this.ws!.send(P.encodeName(this.name, this.token)); this.sendState(); };
      ws.onclose = () => { this.online = false; this.ws = null; if (this.paused) return; setTimeout(() => { if (!this.paused && !this.ws) this.connect(); }, this.retryMs); this.retryMs = Math.min(10000, this.retryMs * 2); };
      ws.onerror = () => { /* onclose follows */ };
      ws.onmessage = (e) => this.handle(new DataView(e.data as ArrayBuffer));
    } catch { this.ws = null; if (!this.paused) setTimeout(() => this.connect(), this.retryMs); }
  }

  private handle(dv: DataView) {
    switch (dv.getUint8(0)) {
      case P.S2C.WELCOME: this.myId = P.decodeWelcome(dv).myId; break;
      case P.S2C.SNAPSHOT: {
        P.decodeSnapshot(dv, this.players);
        const now = performance.now(); const off = this.yOffset();
        for (const p of this.players) {
          if (p.id === this.myId) continue; // the cell packet includes us
          p.y += off;
          // walking players stand on *our* terrain: absorbs the residual LOD disagreement between clients
          if (!(p.flags & P.FLAG.FLYING) && this.ground) { const g = this.ground.topAt(p.x, p.z, p.y + 3); if (g !== null && Math.abs(g - p.y) < 4) p.y = g; }
          let r = this.remotes.get(p.id);
          if (!r) { r = { avatar: new Avatar(this.names.get(p.id) ?? P.DEFAULT_NAME), target: new THREE.Vector3(p.x, p.y, p.z), prev: new THREE.Vector3(p.x, p.y, p.z), yaw: p.yaw, flags: p.flags, lastSeen: now, speed: 0 };
            r.avatar.setPose(p.x, p.y, p.z, p.yaw); this.scene.add(r.avatar.group); this.remotes.set(p.id, r);
            if (!this.names.has(p.id) && !this.asked.has(p.id) && this.ws) { this.asked.add(p.id); this.ws.send(P.encodeWho(p.id)); } }
          r.prev.copy(r.target); r.target.set(p.x, p.y, p.z); r.yaw = p.yaw; r.flags = p.flags;
          r.speed = r.prev.distanceTo(r.target) / Math.max(0.05, (now - r.lastSeen) / 1000); r.lastSeen = now;
        }
        this.onlineCount = Math.max(this.players.length, 1);
        break;
      }
      case P.S2C.PONG: this.rttMs = performance.now() - dv.getUint32(1, true); break;
      case P.S2C.NAME: { const e = P.decodeNameOf(dv, this.evt); this.names.set(e.id, e.name); this.asked.delete(e.id); this.remotes.get(e.id)?.avatar.setName(e.name); break; }
      case P.S2C.ROSTER: { P.decodeRoster(dv, this.rosterBuf); this.roster.clear(); for (const r of this.rosterBuf) if (r.id !== this.myId) this.roster.set(r.id, { x: r.x, z: r.z }); break; }
      default: this.onPacket?.(dv);
    }
  }

  /** Our display name; sent now if we're connected and again on every (re)connect. */
  setName(name: string) { this.name = P.cleanName(name); this.names.set(this.myId, this.name); if (this.online && this.ws) this.ws.send(P.encodeName(this.name, this.token)); }
  nameOf(id: number) { return id === this.myId ? this.name : (this.names.get(id) ?? `${P.DEFAULT_NAME} #${id}`); }

  /** Called every frame; sends our state at 10 Hz and advances remote interpolation. */
  update(dt: number) {
    this.sendAcc += dt;
    if (this.online && this.ws && this.sendAcc >= 0.1) {
      this.sendAcc = 0;
      this.sendState();
      this.pingT += 0.1; if (this.pingT >= 5) { this.pingT = 0; this.ws.send(P.encodePing(performance.now() >>> 0)); }
    }
    const now = performance.now();
    for (const [id, r] of this.remotes) {
      if (now - r.lastSeen > 2500) { this.scene.remove(r.avatar.group); this.remotes.delete(id); this.names.delete(id); this.asked.delete(id); continue; }
      const g = r.avatar.group.position; g.lerp(r.target, Math.min(1, 10 * dt));
      let d = r.yaw + Math.PI - r.avatar.group.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
      r.avatar.group.rotation.y += d * Math.min(1, 10 * dt);
      r.avatar.animate(dt, r.flags & P.FLAG.MOVING ? Math.max(2, r.speed) : 0, !!(r.flags & P.FLAG.FLYING), !!(r.flags & P.FLAG.AIRBORNE));
    }
  }
}
