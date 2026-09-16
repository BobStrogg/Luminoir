/**
 * Critically-damped spring step (Game Programming Gems closed form).
 * Mutates `state` in place — no per-frame allocation.
 *
 * @param {{ x: number, v: number }} state  Current value + velocity.
 * @param {number} target
 * @param {number} smoothTime  Approximate time to reach the target.
 * @param {number} dt          Frame delta in seconds.
 * @returns {{ x: number, v: number }} The same `state` object.
 */
export function smoothDamp(state, target, smoothTime, dt) {
  const omega = 2 / smoothTime;
  const xw = omega * dt;
  const exp = 1 / (1 + xw + 0.48 * xw * xw + 0.235 * xw * xw * xw);
  const change = state.x - target;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * exp;
  state.x = target + (change + temp) * exp;
  return state;
}
