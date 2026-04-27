/**
 * Thin EventTarget that impersonates a DOM element inside the render
 * Web Worker so `OrbitControls` (which expects a real `HTMLElement`)
 * can still attach pointer / wheel / touch listeners.
 *
 * The main thread captures the real pointer events on the canvas'
 * placeholder element and posts serialised event payloads across; this
 * class re-dispatches them as synthetic events in the worker, so the
 * view-from-OrbitControls is indistinguishable from the real DOM.
 *
 * We also proxy `ownerDocument` because OrbitControls registers
 * pointermove / pointerup listeners there for capture-outside-canvas
 * semantics.
 */
export class ElementProxy extends EventTarget {
  /** @type {{ left: number, top: number, width: number, height: number, right: number, bottom: number }} */
  _rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  /** Shared document proxy so pointermove-on-document also works. */
  ownerDocument;

  constructor() {
    super();
    this.ownerDocument = new DocumentProxy();
    // OrbitControls reads `.style.touchAction`; provide a dummy object.
    this.style = { touchAction: '' };
  }

  /** Called by the worker when the main thread reports a resize. */
  setRect(rect) {
    this._rect = rect;
  }

  getBoundingClientRect() {
    return this._rect;
  }

  get clientWidth() { return this._rect.width; }
  get clientHeight() { return this._rect.height; }

  /** OrbitControls calls these; pointer capture is managed by the
   *  main thread already, so the worker-side stubs just swallow the
   *  call. */
  setPointerCapture(_pointerId) {}
  releasePointerCapture(_pointerId) {}
  hasPointerCapture(_pointerId) { return false; }
  focus() {}

  /** OrbitControls' `.connect()` in modern Three.js reads
   *  `domElement.getRootNode().defaultView` to find the window it
   *  should install event listeners on.  Our proxy returns a stub
   *  that re-dispatches to the same document proxy.  `defaultView`
   *  can be `self` (the worker global) which IS an EventTarget.
   */
  getRootNode() {
    const doc = this.ownerDocument;
    return {
      defaultView: self, // WorkerGlobalScope is an EventTarget
      addEventListener: doc.addEventListener.bind(doc),
      removeEventListener: doc.removeEventListener.bind(doc),
      dispatchEvent: doc.dispatchEvent.bind(doc),
    };
  }

  /** Dispatch a synthetic event from the payload posted across the
   *  worker boundary.  `target` is `'element'` or `'document'`. */
  dispatchProxied(target, payload) {
    const ev = toSyntheticEvent(payload);
    if (target === 'document') this.ownerDocument.dispatchEvent(ev);
    else this.dispatchEvent(ev);
  }
}

class DocumentProxy extends EventTarget {
  // OrbitControls occasionally reads document.pointerLockElement.
  get pointerLockElement() { return null; }
}

/**
 * Rebuild an event from a plain-object payload posted by the main
 * thread.  We fake the properties OrbitControls actually reads —
 * doing a full Event clone with the proper constructor tree is
 * overkill (and some constructors aren't available in workers).
 */
function toSyntheticEvent(p) {
  const ev = new Event(p.type, { bubbles: true, cancelable: true });
  // Common properties
  ev.clientX = p.clientX ?? 0;
  ev.clientY = p.clientY ?? 0;
  ev.pageX = p.pageX ?? p.clientX ?? 0;
  ev.pageY = p.pageY ?? p.clientY ?? 0;
  ev.deltaX = p.deltaX ?? 0;
  ev.deltaY = p.deltaY ?? 0;
  ev.deltaZ = p.deltaZ ?? 0;
  ev.deltaMode = p.deltaMode ?? 0;
  ev.button = p.button ?? 0;
  ev.buttons = p.buttons ?? 0;
  ev.ctrlKey = !!p.ctrlKey;
  ev.shiftKey = !!p.shiftKey;
  ev.altKey = !!p.altKey;
  ev.metaKey = !!p.metaKey;
  ev.pointerId = p.pointerId ?? 0;
  ev.pointerType = p.pointerType ?? 'mouse';
  ev.isPrimary = p.isPrimary ?? true;
  // Touch props (OrbitControls reads .touches on touch events)
  if (p.touches) ev.touches = p.touches;
  if (p.changedTouches) ev.changedTouches = p.changedTouches;
  if (p.targetTouches) ev.targetTouches = p.targetTouches;
  // preventDefault / stopPropagation are provided by the base Event.
  return ev;
}
