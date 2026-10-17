// Locations (v0.7 — API.md §1.52). ONE shape everywhere ({label, lat?, lng?});
// lat/lng are OPTIONAL, both-or-neither, and only ever a user-initiated
// one-tap SNAPSHOT — no live GPS, no watching, nothing ambient (FEATURES #30).
// Rendering is a LINK the user chooses to open — geo:/OSM/Google URLs built
// here, never tile embeds, never a map SDK or API key (golden rule 7).
// Opening a map app is the user leaving our origin by choice; we never fetch
// map data server-side.
import type { Location } from '@socialchat/shared';

export interface MapLink {
  label: string;
  href: string;
}

/** The §1.52 link recipes, verbatim. geo: is offered on coarse-pointer
 * (touch) devices only — desktop browsers rarely register a geo: handler. */
export function mapLinks(loc: Location): MapLink[] {
  const links: MapLink[] = [];
  const coarse =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  if (loc.lat !== undefined && loc.lng !== undefined) {
    if (coarse) links.push({ label: 'Map app', href: `geo:${loc.lat},${loc.lng}` });
    links.push({
      label: 'OpenStreetMap',
      href: `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}`,
    });
    links.push({
      label: 'Google Maps',
      href: `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`,
    });
  } else {
    // Label-only: the SEARCH URLs with the URL-encoded label.
    const q = encodeURIComponent(loc.label);
    links.push({ label: 'OpenStreetMap', href: `https://www.openstreetmap.org/search?query=${q}` });
    links.push({ label: 'Google Maps', href: `https://www.google.com/maps/search/?api=1&query=${q}` });
  }
  return links;
}

/** One explicit, permission-gated snapshot of the device's position — the
 * user tapped "use my current location"; nothing watches, nothing repeats. */
export function snapshotPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Round to ~11 m — a meetup pin, not a surveying instrument.
        resolve({
          lat: Math.round(pos.coords.latitude * 1e4) / 1e4,
          lng: Math.round(pos.coords.longitude * 1e4) / 1e4,
        });
      },
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }
    );
  });
}
