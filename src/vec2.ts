export interface Vec2 {
  x: number;
  y: number;
}

export function len2(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
