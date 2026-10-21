// 升降按钮绑定
export function setupHoldBtn(btn, onStart, onEnd) {
  btn.addEventListener('pointerdown', (e) => { onStart(); btn.setPointerCapture(e.pointerId); });
  btn.addEventListener('pointerup', (e) => { onEnd(); btn.releasePointerCapture(e.pointerId); });
  btn.addEventListener('pointercancel', onEnd);
}
