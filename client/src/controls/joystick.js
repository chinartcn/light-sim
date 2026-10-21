import * as THREE from 'three';

export function createJoystick(container, stick) {
  let isActive = false;
  const vector = new THREE.Vector2(0, 0);
  const maxRadius = 45;

  function update(e) {
    const rect = container.getBoundingClientRect();
    let dx = e.clientX - (rect.left + rect.width / 2);
    let dy = e.clientY - (rect.top + rect.height / 2);
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > maxRadius) {
      dx = (dx / distance) * maxRadius;
      dy = (dy / distance) * maxRadius;
    }
    stick.style.transform = `translate(${dx}px, ${dy}px)`;
    vector.set(dx / maxRadius, dy / maxRadius);
  }

  container.addEventListener('pointerdown', (e) => {
    isActive = true;
    stick.style.transition = 'none';
    container.setPointerCapture(e.pointerId);
    update(e);
  });

  container.addEventListener('pointermove', (e) => {
    if (isActive) update(e);
  });

  const reset = (e) => {
    if (!isActive) return;
    isActive = false;
    vector.set(0, 0);
    stick.style.transition = 'transform 0.1s ease-out';
    stick.style.transform = `translate(0px, 0px)`;
    container.releasePointerCapture(e.pointerId);
  };

  container.addEventListener('pointerup', reset);
  container.addEventListener('pointercancel', reset);

  // 暴露给外部调用的状态
  return {
    getVector: () => vector
  };
}
