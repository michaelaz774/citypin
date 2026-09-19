// Aim direction shared by client and server. Pure functions, no three.js.

/** Direction from yaw/pitch, same convention as the player: yaw 0 looks down -z, positive pitch looks up. */
export function dirFrom(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
