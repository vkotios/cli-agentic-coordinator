export function sameStamp(recorded, current) {
  const valid = (s) => typeof s === 'string' && /^-?\d+:-?\d+:-?\d+$/.test(s);
  if (!valid(recorded) || !valid(current)) return { ok: false };
  if (recorded === current) return { ok: true };
  const [dev, ino, birth] = recorded.split(':');
  const [currentDev, currentIno, currentBirth] = current.split(':');
  return dev !== currentDev && ino === currentIno && birth === currentBirth ? { ok: true, migrate: true } : { ok: false };
}

export const stampsMatch = (recorded, current) => sameStamp(recorded, current).ok;
