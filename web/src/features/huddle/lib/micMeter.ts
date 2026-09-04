/**
 * Mic-level meter scaling. Import-free so `node --test` can load it.
 */

/** dBov floor the meter treats as silence. Below this the bar is empty. */
export const MIC_METER_FLOOR_DBOV = -60;

/**
 * dBov (-127…0) as a 0…1 bar position.
 *
 * A linear map of the full dBov range would leave normal speech — which sits
 * around -30 to -15 dBov — in the top quarter of the bar and give three
 * quarters of the widget to inaudible noise. Clamping at -60 puts the useful
 * range across the whole meter.
 */
export function micMeterFraction(levelDbov: number): number {
  if (!Number.isFinite(levelDbov) || levelDbov <= MIC_METER_FLOOR_DBOV) {
    return 0;
  }
  const clamped = Math.min(0, levelDbov);
  return (clamped - MIC_METER_FLOOR_DBOV) / -MIC_METER_FLOOR_DBOV;
}

/**
 * Is this peer audibly speaking?
 *
 * The relay forwards a per-frame `level_dbov` as telemetry; the bar uses it
 * to light up a speaker chip. -45 dBov is the desktop's practical threshold:
 * low enough to catch a quiet talker, high enough that room noise does not
 * light everyone up at once.
 */
export const SPEAKING_THRESHOLD_DBOV = -45;

export function isSpeaking(levelDbov: number): boolean {
  return Number.isFinite(levelDbov) && levelDbov > SPEAKING_THRESHOLD_DBOV;
}
