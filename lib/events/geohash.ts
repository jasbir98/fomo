// Minimal lat/lng → geohash encoder for the Ticketmaster Discovery v2
// `geoPoint` param, which takes a geohash rather than raw coordinates. No
// geohash library exists in this repo and this is the only caller, so a
// small local implementation (~standard base32 geohash algorithm) beats
// adding a dependency for one call site.
import "server-only";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Encode a lat/lng pair into a geohash string of the given precision
 * (character count). Ticketmaster's Discovery v2 API is documented against
 * precision-9 geohashes for `geoPoint`.
 */
export function encodeGeohash(lat: number, lng: number, precision = 9): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let evenBit = true; // alternate longitude/latitude bits, starting with longitude

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        ch = (ch << 1) | 1;
        lngMin = mid;
      } else {
        ch = ch << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latMin = mid;
      } else {
        ch = ch << 1;
        latMax = mid;
      }
    }
    evenBit = !evenBit;

    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }

  return hash;
}
