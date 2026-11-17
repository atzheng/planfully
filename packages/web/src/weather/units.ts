export type TempUnit = 'C' | 'F';
export type WindUnit = 'kmh' | 'mph';
export type Units = { temp: TempUnit; wind: WindUnit };

const FAHRENHEIT_REGIONS = new Set(['US', 'BS', 'BZ', 'KY', 'PW', 'LR']);
const MPH_REGIONS = new Set(['US', 'GB', 'LR', 'MM']);

function region(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).maximize().region;
  } catch {
    return undefined;
  }
}

/** Default units from a locale (e.g. navigator.language): US gets F and mph, UK mph, else C and km/h. */
export function defaultUnits(locale?: string): Units {
  const lang = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  const r = region(lang);
  return {
    temp: r && FAHRENHEIT_REGIONS.has(r) ? 'F' : 'C',
    wind: r && MPH_REGIONS.has(r) ? 'mph' : 'kmh',
  };
}

export const cToF = (c: number) => (c * 9) / 5 + 32;
export const kphToMph = (k: number) => k / 1.609344;
export const mmToIn = (mm: number) => mm / 25.4;

export function convertTemp(c: number, u: TempUnit): number {
  return u === 'F' ? cToF(c) : c;
}
export function convertWind(kph: number, u: WindUnit): number {
  return u === 'mph' ? kphToMph(kph) : kph;
}
export function formatTemp(c: number, u: TempUnit): string {
  return `${Math.round(convertTemp(c, u))}°${u}`;
}
export function formatWind(kph: number, u: WindUnit): string {
  return `${Math.round(convertWind(kph, u))} ${u === 'mph' ? 'mph' : 'km/h'}`;
}
/** Precipitation follows the temperature unit: inches with F, mm with C. */
export function formatPrecip(mm: number, u: TempUnit): string {
  return u === 'F' ? `${mmToIn(mm).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}
