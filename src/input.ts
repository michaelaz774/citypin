export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  mouseDX = 0; mouseDY = 0;
  locked = false;
  fireJust = false; fireHeld = false; aimHeld = false; // left / right mouse while the pointer is locked
  enabled = true;
  touch = false; // set by TouchControls: no pointer lock, look deltas come from drags
  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.target instanceof HTMLInputElement) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('click', () => { if (this.enabled && !this.locked && !this.touch) el.requestPointerLock?.(); });
    document.addEventListener('pointerlockchange', () => { if (!this.touch) this.locked = document.pointerLockElement === el; });
    document.addEventListener('mousedown', (e) => { if (!this.locked) return; if (e.button === 0) { this.fireJust = true; this.fireHeld = true; } else if (e.button === 2) this.aimHeld = true; });
    document.addEventListener('mouseup', (e) => { if (e.button === 0) this.fireHeld = false; else if (e.button === 2) this.aimHeld = false; });
    document.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    document.addEventListener('mousemove', (e) => {
      if (this.locked) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; }
    });
  }
  down(code: string) { return this.keys.has(code); }
  just(code: string) { return this.pressed.has(code); }
  axis(neg: string, pos: string) { return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0); }
  endFrame() { this.pressed.clear(); this.mouseDX = 0; this.mouseDY = 0; this.fireJust = false; }
  release() { if (this.locked && !this.touch) document.exitPointerLock?.(); }
}
