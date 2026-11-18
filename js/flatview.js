// Простой просмотрщик для браузеров без WebGL: перетаскивание и колесо мыши.
// 360°-панорама показывается развёрткой, по горизонтали она бесшовно зациклена.
export function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

export function flatViewer(container, { src, wrap }) {
  const el = document.createElement('div');
  el.className = 'flatview';
  el.style.backgroundImage = `url("${src}")`;
  el.style.backgroundRepeat = wrap ? 'repeat-x' : 'no-repeat';
  container.appendChild(el);

  const img = new Image();
  let iw = 1, ih = 1, zoom = 1, x = 0, y = 0;
  const handlers = { load: [] };

  function baseScale() {
    const { clientWidth: w, clientHeight: h } = el;
    // 360°: заполняем высоту; обычное фото: вписываем целиком («cover» по меньшей стороне)
    return wrap ? h / ih : Math.max(w / iw, h / ih);
  }
  function clamp() {
    const s = baseScale() * zoom, w = iw * s, h = ih * s;
    const { clientWidth: cw, clientHeight: ch } = el;
    if (!wrap) x = Math.min(0, Math.max(cw - w, x));
    else x = ((x % w) + w) % w - w;
    y = Math.min(0, Math.max(ch - h, y));
    el.style.backgroundSize = `${w}px ${h}px`;
    el.style.backgroundPosition = `${x}px ${y}px`;
  }
  img.onload = () => {
    iw = img.naturalWidth; ih = img.naturalHeight;
    const s = baseScale();
    x = (el.clientWidth - iw * s) / 2; y = (el.clientHeight - ih * s) / 2;
    clamp();
    handlers.load.forEach((fn) => fn());
  };
  img.src = src;

  let drag = null;
  el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX - x, y: e.clientY - y }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => { if (!drag) return; x = e.clientX - drag.x; y = e.clientY - drag.y; clamp(); });
  el.addEventListener('pointerup', () => { drag = null; });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const old = zoom;
    zoom = Math.min(6, Math.max(1, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const r = el.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    x = px - (px - x) * (zoom / old); y = py - (py - y) * (zoom / old);
    clamp();
  }, { passive: false });
  const onResize = () => clamp();
  window.addEventListener('resize', onResize);

  return {
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    destroy() { window.removeEventListener('resize', onResize); el.remove(); },
  };
}
