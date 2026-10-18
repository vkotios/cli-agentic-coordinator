// Process birth ordering is meaningful only inside the same native clock scope.
// Linux tick identities include boot and PID namespace; legacy bare ticks do not.
export function creationPoint(value) {
  if (typeof value !== 'string') return null;
  const wall = /^ms:(-?(?:0|[1-9]\d*))$/.exec(value);
  if (wall) {
    const at = Number(wall[1]);
    return Number.isSafeInteger(at) && Math.abs(at) <= 8640000000000000 && value === `ms:${at}`
      ? { kind: 'wall', scope: 'ms', value: at } : null;
  }
  const native = /^linux:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d{0,19}):(0|[1-9]\d*)$/.exec(value);
  if (!native) return null;
  const at = Number(native[3]);
  return Number.isSafeInteger(at)
    ? { kind: 'linux', boot: native[1], namespace: native[2], scope: `linux:${native[1]}:${native[2]}`, value: at } : null;
}

export function tableClockScope(table, hit = null) {
  if (typeof table?.clockScope === 'string') return table.clockScope;
  const own = creationPoint(hit?.createdAt);
  if (own) return own.scope;
  const points = table?.map(row => creationPoint(row.createdAt)) ?? [];
  return points.length && points.every(point => point && point.scope === points[0]?.scope) ? points[0].scope : null;
}
