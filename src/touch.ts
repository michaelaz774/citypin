import type { Input } from './input';

/**
 * Minecraft-style touch controls. Everything becomes the same key codes and look deltas the keyboard/mouse produce,
 * so the movement code doesn't know the difference.
 *   D-pad (bottom left)   slide for 8-way movement; double-tap forward = sprint; centre = descend while flying
 *   anywhere else         drag = look
 *   JUMP (bottom right)   hold = jump / ascend; double-tap = toggle flying
 *   top right             CAM · MAP · RST
 */
export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');

const DIRS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];

export class TouchControls {
  root = document.getElementById('touch')!;
  private padPid = -1; private lookPid = -1;
  private lookLast = { x: 0, y: 0 };
  private pad = document.getElementById('dpad')!;
  private arrows: Record<string, HTMLElement> = {};
  private lastFwdTap = 0; private sprinting = false; private fwdDown = false;
  private lastJumpTap = 0; private sprintLatched = false;
  flying = false;

  constructor(private input: Input) {
    this.root.hidden = false; document.body.classList.add('touch');
    input.locked = true; // no pointer lock on touch; look deltas come from drags
    for (const el of Array.from(this.pad.querySelectorAll<HTMLElement>('[data-dir]'))) this.arrows[el.dataset.dir!] = el;
    const synthetic = new URLSearchParams(location.search).has('touch');
    const isTouch = (e: PointerEvent) => e.pointerType !== 'mouse' || synthetic;

    // ---- D-pad: one finger, 8-way by angle, centre = sneak/descend
    this.pad.addEventListener('pointerdown', (e) => {
      if (!isTouch(e) || this.padPid >= 0) return;
      e.preventDefault(); e.stopPropagation(); this.padPid = e.pointerId;
      try { this.pad.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      this.updatePad(e.clientX, e.clientY, true);
    });
    this.pad.addEventListener('pointermove', (e) => { if (e.pointerId === this.padPid) this.updatePad(e.clientX, e.clientY, false); });
    const padEnd = (e: PointerEvent) => { if (e.pointerId !== this.padPid) return; this.padPid = -1; this.clearPad(); };
    this.pad.addEventListener('pointerup', padEnd); this.pad.addEventListener('pointercancel', padEnd);

    // ---- look: drag anywhere that isn't a button
    const zone = document.getElementById('touchzones')!;
    zone.addEventListener('pointerdown', (e) => {
      if (!isTouch(e) || this.lookPid >= 0) return;
      e.preventDefault(); this.lookPid = e.pointerId;
      try { zone.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookPid) return;
      const dx = e.clientX - this.lookLast.x, dy = e.clientY - this.lookLast.y;
      input.mouseDX += dx * 2.4; input.mouseDY += dy * 2.4; this.lookLast = { x: e.clientX, y: e.clientY };
    });
    const lookEnd = (e: PointerEvent) => { if (e.pointerId === this.lookPid) this.lookPid = -1; };
    zone.addEventListener('pointerup', lookEnd); zone.addEventListener('pointercancel', lookEnd);

    // ---- JUMP (walking): hold = Space; double-tap = start flying.  ▲ (flying): hold = ascend; double-tap = land.  ▼: descend
    const holdWithDoubleTap = (el: HTMLElement, code: string, onDouble: () => void) => {
      el.addEventListener('pointerdown', (e) => {
        if (!isTouch(e)) return; e.preventDefault(); e.stopPropagation();
        const now = performance.now();
        if (now - this.lastJumpTap < 400) { onDouble(); this.lastJumpTap = 0; } else this.lastJumpTap = now;
        this.press(code); el.classList.add('on');
      });
      const up = (e: PointerEvent) => { e.preventDefault(); input.keys.delete(code); input.keys.delete('KeyF'); el.classList.remove('on'); };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    };
    holdWithDoubleTap(this.root.querySelector<HTMLElement>('#tjump')!, 'Space', () => this.press('KeyF'));
    holdWithDoubleTap(this.root.querySelector<HTMLElement>('#tup')!, 'Space', () => this.press('KeyF'));

    // ---- SPRINT toggle (Minecraft's sprint button); double-tapping forward on the pad works too
    const sprint = this.root.querySelector<HTMLElement>('#tsprint')!;
    sprint.addEventListener('pointerdown', (e) => {
      if (!isTouch(e)) return; e.preventDefault(); e.stopPropagation();
      this.sprintLatched = !this.sprintLatched; sprint.classList.toggle('on', this.sprintLatched);
      if (this.sprintLatched) this.press('ShiftLeft'); else if (!this.sprinting) input.keys.delete('ShiftLeft');
    });

    // ---- simple buttons (tap = key press)
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('button[data-key]'))) {
      const code = b.dataset.key!;
      b.addEventListener('pointerdown', (e) => { if (!isTouch(e)) return; e.preventDefault(); e.stopPropagation(); this.press(code); b.classList.add('on'); });
      const up = (e: PointerEvent) => { e.preventDefault(); input.keys.delete(code); b.classList.remove('on'); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
    }
  }

  private press(code: string) { if (!this.input.keys.has(code)) this.input.pressed.add(code); this.input.keys.add(code); }

  private updatePad(x: number, y: number, isDown: boolean) {
    const r = this.pad.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2), len = Math.hypot(dx, dy);
    const on = new Set<string>();
    if (len < r.width * 0.16) { if (this.flying) on.add('KeyC'); } // centre: descend while flying (Minecraft's sneak slot)
    else {
      const a = Math.atan2(-dy, dx); // 0 = right, +π/2 = up
      const sector = (lo: number, hi: number) => a >= lo && a <= hi;
      const w = Math.PI / 8 * 3; // 67.5°: each direction covers its quadrant plus the diagonals
      if (sector(Math.PI / 2 - w, Math.PI / 2 + w)) on.add('KeyW');
      if (sector(-Math.PI / 2 - w, -Math.PI / 2 + w)) on.add('KeyS');
      if (sector(-w, w)) on.add('KeyD');
      if (a >= Math.PI - w || a <= -Math.PI + w) on.add('KeyA');
    }
    // double-tap forward = sprint (held until forward is released)
    const fwd = on.has('KeyW');
    if (fwd && !this.fwdDown) { const now = performance.now(); if (isDown && now - this.lastFwdTap < 350) this.sprinting = true; this.lastFwdTap = now; }
    if (!fwd) this.sprinting = false;
    this.fwdDown = fwd;
    for (const code of [...DIRS, 'KeyC']) { if (on.has(code)) this.press(code); else this.input.keys.delete(code); }
    if (this.sprinting || this.sprintLatched) this.press('ShiftLeft'); else this.input.keys.delete('ShiftLeft');
    for (const [dir, el] of Object.entries(this.arrows)) el.classList.toggle('on', on.has(dir));
    this.pad.classList.toggle('sprint', this.sprinting);
  }
  private clearPad() {
    for (const code of [...DIRS, 'KeyC']) this.input.keys.delete(code);
    if (!this.sprintLatched) this.input.keys.delete('ShiftLeft');
    this.sprinting = false; this.fwdDown = false;
    for (const el of Object.values(this.arrows)) el.classList.remove('on');
    this.pad.classList.remove('sprint');
  }
  /** Walking or flying: the ascend/descend pad replaces JUMP, and the centre glyph follows the mode. */
  setContext(opts: { flying: boolean }) {
    const fly = this.flying = opts.flying;
    this.root.querySelector<HTMLElement>('#tjump')!.hidden = fly;
    this.root.querySelector<HTMLElement>('#tflight')!.hidden = !fly;
    // KeyC on the pad centre is a bonus while flying; the ▼ button is the primary control
    this.arrows['KeyC'].textContent = fly ? '▼' : '';
  }
}
