// Pure Web Mercator maths: the lat/lng under a pixel of the map container. Maps' own projection
// needs the Maps API; this keeps the long-press handler testable.

const TILE = 256;

export type LatLng = { lat: number; lng: number };

function toWorld({ lat, lng }: LatLng): { x: number; y: number } {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

function fromWorld(x: number, y: number): LatLng {
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  const lng = ((((x * 360 - 180 + 180) % 360) + 360) % 360) - 180;
  return { lat, lng };
}

/**
 * The position at (`px`, `py`), measured from the container's top-left corner, for a map whose
 * centre is `center` at `zoom` and whose container is `width` x `height` pixels.
 */
export function latLngAtPixel(
  center: LatLng,
  zoom: number,
  size: { width: number; height: number },
  px: number,
  py: number,
): LatLng {
  const c = toWorld(center);
  const worldPx = TILE * 2 ** zoom;
  const x = c.x + (px - size.width / 2) / worldPx;
  const y = Math.min(1, Math.max(0, c.y + (py - size.height / 2) / worldPx));
  return fromWorld(x, y);
}
