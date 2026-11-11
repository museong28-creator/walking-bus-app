// A timing comparison, not a medical/safety guarantee or instruction to walk faster.
export function assessDeadline({remainingMeters, targetTime, now, bufferSeconds = 120,
  currentSpeedMps = null, comfortSpeedMps = 1.2, maxSuggestedMps = 1.67}) {
  const invalid = !Number.isFinite(remainingMeters) || remainingMeters < 0
    || !Number.isFinite(targetTime) || !Number.isFinite(now)
    || !Number.isFinite(bufferSeconds) || bufferSeconds < 0
    || !Number.isFinite(comfortSpeedMps) || comfortSpeedMps <= 0
    || !Number.isFinite(maxSuggestedMps) || maxSuggestedMps <= 0;
  const empty = {kind:'unknown',requiredSpeedMps:null,requiredPaceSecondsPerKm:null,marginSeconds:null,availableSeconds:null};
  if (invalid) return empty;
  const availableSeconds = (targetTime - now) / 1000 - bufferSeconds;
  if (remainingMeters === 0) return {...empty,kind:'arrived',availableSeconds};
  if (targetTime <= now) return {...empty,kind:'expired',availableSeconds};
  if (availableSeconds <= 0) return {...empty,kind:'late',availableSeconds};
  const requiredSpeedMps = remainingMeters / availableSeconds;
  const requiredPaceSecondsPerKm = 1000 / requiredSpeedMps;
  const knownSpeed = Number.isFinite(currentSpeedMps) && currentSpeedMps >= .25;
  const marginSeconds = knownSpeed ? availableSeconds - remainingMeters / currentSpeedMps : null;
  const result = {requiredSpeedMps,requiredPaceSecondsPerKm,marginSeconds,availableSeconds};
  if (requiredSpeedMps > Math.min(comfortSpeedMps,maxSuggestedMps)) return {...result,kind:'uncomfortable'};
  if (!knownSpeed) return {...result,kind:'unknown'};
  if (marginSeconds < 0) return {...result,kind:'late'};
  return {...result,kind:marginSeconds < 60 ? 'tight' : 'comfortable'};
}

export function positionFreshness(position, serverNow = Date.now()) {
  if (!position || !Number.isFinite(position.receivedAt) || !Number.isFinite(serverNow)) return 'hidden';
  const timestamp = Number.isFinite(position.recordedAt) ? Math.min(position.receivedAt,position.recordedAt) : position.receivedAt;
  const age = Math.max(0,serverNow - timestamp);
  return age >= 90000 ? 'hidden' : age >= 30000 ? 'stale' : 'fresh';
}

export function localDateTimeValue(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
