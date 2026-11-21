// The panel over the map. It rests at three heights: peek (summary line only), half (key numbers
// and main buttons) and full (everything, scrollable). It is dragged with a finger or the mouse.

// Which resting height a released drag settles on. velocity is px/ms, positive when moving up.
export function nearestSnap(height, velocity, points) {
  if (Math.abs(velocity) > 0.4) {
    // A flick goes one step in its direction, however short the drag was.
    const next = velocity > 0 ? points.findIndex(point => point > height + 1) : points.findLastIndex(point => point < height - 1);
    return next !== -1 ? next : velocity > 0 ? points.length - 1 : 0;
  }
  let best = 0;
  points.forEach((point, index) => { if (Math.abs(point - height) < Math.abs(points[best] - height)) best = index; });
  return best;
}

// Free space (px) that the floating map buttons and the location message need above the sheet.
export const FLOAT_ROOM = 88;

// board: the summary that stays visible at peek. detail(): the element where the current view's
// "more" content starts, which is where the half height ends.
// onLayout(): called after every resting position is applied. onDragStart(): a finger took over.
export function createSheet({sheet, scroll, grip, board, panel, detail, root, onLevel = () => {}, onDragStart = () => {}, onLayout = () => {}, window: win = globalThis.window}) {
  let level = 0, points = [0, 0, 0], drag = null, lastDrag = 0;
  const total = () => sheet.offsetHeight;
  const show = (height, animate) => {
    sheet.classList.toggle('dragging', !animate);
    // Too little map is left above the sheet for the floating map buttons: they would cover the chips.
    sheet.classList.toggle('is-tall', total() - height < FLOAT_ROOM);
    sheet.style.transform = `translateY(${Math.max(0, total() - height)}px)`;
  };
  function measure() {
    const max = total(), top = sheet.getBoundingClientRect().top, offset = scroll.scrollTop;
    const peek = Math.min(max, board.getBoundingClientRect().bottom - top + offset);
    const more = detail();
    let half = Math.min(max, Math.max(peek, more ? more.getBoundingClientRect().top - top + offset : peek));
    const full = Math.min(max, Math.max(half, grip.offsetHeight + scroll.scrollHeight));
    // When nearly everything already fits at half, there is no separate full step.
    if (full - half < 32) half = full;
    points = [peek, half, full];
  }
  function layout(animate = false) {
    // Nothing to do while hidden behind the login or the pace measurement, or under a finger.
    if (!total() || drag?.mode === 'drag') return;
    measure();
    root.style.setProperty('--peek', `${points[0]}px`);
    sheet.classList.toggle('is-full', level === 2);
    if (level < 2) scroll.scrollTop = 0;
    // Buttons below the fold must not take keyboard focus while only the summary shows.
    panel.inert = level === 0;
    show(points[level], animate);
    // The visible top of the sheet may have moved: by a level change or by content that grew.
    onLayout();
  }
  function setLevel(next, animate = true) { level = next; layout(animate); }

  function start(x, y, target) {
    if (target?.closest?.('input[type="range"]')) return;
    drag = {x, y, lastY:y, lastTime:win.performance.now(), height:points[level], current:points[level], velocity:0, mode:null,
      handle:grip.contains(target) || board.contains(target)};
  }
  function move(x, y, event) {
    if (!drag || drag.mode === 'scroll') return;
    const dy = drag.y - y;
    if (!drag.mode) {
      // At full height an upward drag, or any drag once scrolled, belongs to the content.
      if (level === 2 && !drag.handle && (scroll.scrollTop > 0 || dy >= 0)) { if (dy !== 0) drag.mode = 'scroll'; return; }
      if (Math.abs(x - drag.x) > Math.abs(dy) + 4) { drag.mode = 'scroll'; return; }
      if (event.cancelable) event.preventDefault();
      if (Math.abs(dy) < 6) return;
      drag.mode = 'drag'; onDragStart(); measure(); panel.inert = false;
    }
    if (event.cancelable) event.preventDefault();
    const now = win.performance.now();
    if (now > drag.lastTime) drag.velocity = .6 * drag.velocity + .4 * (drag.lastY - y) / (now - drag.lastTime);
    drag.lastY = y; drag.lastTime = now;
    drag.current = Math.max(points[0], Math.min(points[2], drag.height + dy));
    show(drag.current, false);
  }
  function end() {
    const finished = drag; drag = null;
    if (finished?.mode !== 'drag') return;
    lastDrag = Date.now();
    level = nearestSnap(finished.current, finished.velocity, points);
    onLevel(level); layout(true);
  }
  sheet.addEventListener('touchstart', event => { if (event.touches.length === 1) start(event.touches[0].clientX, event.touches[0].clientY, event.target); }, {passive:true});
  sheet.addEventListener('touchmove', event => move(event.touches[0].clientX, event.touches[0].clientY, event), {passive:false});
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
  sheet.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.target.closest('input, select, textarea, a, summary, label')) return;
    start(event.clientX, event.clientY, event.target);
    const mouseMove = moved => move(moved.clientX, moved.clientY, moved);
    win.addEventListener('mousemove', mouseMove);
    win.addEventListener('mouseup', () => { win.removeEventListener('mousemove', mouseMove); end(); }, {once:true});
  });
  // Letting go of a drag over a button must not press it.
  sheet.addEventListener('click', event => { if (Date.now() - lastDrag < 350) { event.stopPropagation(); event.preventDefault(); } }, true);
  win.addEventListener('resize', () => layout(false));
  if (win.ResizeObserver) {
    const observer = new win.ResizeObserver(() => layout(true));
    observer.observe(board); observer.observe(panel);
  }
  return {
    get level() { return level; },
    // True while a finger (or the mouse) is moving the sheet.
    get dragging() { return drag?.mode === 'drag'; },
    get height() { return points[level]; },
    get peek() { return points[0]; },
    setLevel, layout,
    // Scrolls the full-height sheet so that the element is at the top.
    reveal(element) { scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12; },
  };
}
