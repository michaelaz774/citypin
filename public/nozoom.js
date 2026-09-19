// Loaded as a separate file because the Pages CSP forbids inline scripts.
// iOS Safari ignores user-scalable=no: suppress double-tap zoom and pinch zoom ourselves, before the app even loads
if (matchMedia('(pointer: coarse)').matches || location.search.includes('touch=1')) {
  document.documentElement.style.touchAction = 'none';
  let lastEnd = 0;
  document.addEventListener('touchend', (e) => { const now = Date.now(); if (now - lastEnd < 400 && !(e.target instanceof HTMLInputElement)) e.preventDefault(); lastEnd = now; }, { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}
