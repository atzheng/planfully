import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';

/**
 * A codec maps between a typed value and its query-string form.
 * `parse` returns undefined for missing or invalid input (the default is used).
 */
export type Codec<T> = {
  parse(raw: string): T | undefined;
  serialize(value: T): string;
};

export const stringCodec: Codec<string> = {
  parse: (raw) => raw,
  serialize: (v) => v,
};

export const numberCodec: Codec<number> = {
  parse: (raw) => {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  },
  serialize: (v) => String(v),
};

/** Serialised as 1 / 0 (matches `wx` and `cancelled`). Also accepts true/false. */
export const booleanCodec: Codec<boolean> = {
  parse: (raw) => {
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return undefined;
  },
  serialize: (v) => (v ? '1' : '0'),
};

/** Comma-separated; commas inside items are percent-escaped. */
export const stringListCodec: Codec<string[]> = {
  parse: (raw) => {
    if (raw === '') return [];
    try {
      return raw.split(',').map((s) => decodeURIComponent(s));
    } catch {
      return undefined;
    }
  },
  serialize: (v) => v.map((s) => encodeURIComponent(s)).join(','),
};

/** Calendar date as 'YYYY-MM-DD'. Invalid dates are rejected. */
export const dateCodec: Codec<string> = {
  parse: (raw) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
    const d = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? undefined : raw;
  },
  serialize: (v) => v,
};

export function enumCodec<const T extends string>(values: readonly T[]): Codec<T> {
  return {
    parse: (raw) => values.find((v) => v === raw),
    serialize: (v) => v,
  };
}

/**
 * Pure: next search string after setting `key`. A value equal to the default
 * removes the key so URLs stay short. Other keys are untouched.
 */
export function nextSearch<T>(
  search: string,
  key: string,
  codec: Codec<T>,
  defaultValue: T,
  value: T,
): string {
  const params = new URLSearchParams(search);
  const raw = codec.serialize(value);
  if (raw === codec.serialize(defaultValue)) params.delete(key);
  else params.set(key, raw);
  const s = params.toString();
  return s ? `?${s}` : '';
}

// Search string produced by a set() that has not rendered yet, so several
// useQueryState setters called in one tick compose instead of overwriting.
let pending: { from: string; search: string } | null = null;

/**
 * URL-backed state for one query key. Updates replace only `location.search`;
 * `location.hash` (the trip secret) is always carried over unchanged.
 */
export function useQueryState<T>(
  key: string,
  codec: Codec<T>,
  defaultValue: T,
  options?: { replace?: boolean },
): [T, (value: T) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const latest = useRef(location);
  latest.current = location;
  useEffect(() => {
    pending = null;
  }, [location.key, location.search]);

  const raw = new URLSearchParams(location.search).get(key);
  const parsed = raw === null ? undefined : codec.parse(raw);
  const value = parsed === undefined ? defaultValue : parsed;

  // Keep codec/default in a ref so the setter identity stays stable.
  const cfg = useRef({ codec, defaultValue });
  cfg.current = { codec, defaultValue };
  const replace = options?.replace ?? false;

  const set = useCallback(
    (next: T) => {
      const loc = latest.current;
      const base = pending && pending.from === loc.search ? pending.search : loc.search;
      const search = nextSearch(base, key, cfg.current.codec, cfg.current.defaultValue, next);
      const to = { pathname: loc.pathname, search, hash: loc.hash };
      pending = { from: loc.search, search };
      void navigate(to, { replace });
    },
    [key, navigate, replace],
  );

  return [value, set];
}
