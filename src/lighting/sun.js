// Where the sun is in the sky, from date and place (NOAA-style approximation, good to
// a fraction of a degree, which is plenty for daylight in a room).
// Returns degrees: azimuth clockwise from north, elevation above the horizon.

export function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24; // hours
  const ha = (gmst * 15 + lon) * rad - ra; // hour angle
  const phi = lat * rad;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { azimuth: ((azimuth / rad) % 360 + 360) % 360, elevation: elevation / rad };
}

// A Date for today's date at the given local time in Zürich (whatever the viewer's time zone).
export function zurichTime(hour, minute = 0, day = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'shortOffset' })
      .formatToParts(day)
      .map((p) => [p.type, p.value]),
  );
  const offset = Number((parts.timeZoneName.match(/GMT([+-]\d+)/) ?? [0, 1])[1]); // CET +1 / CEST +2
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour - offset, minute));
}
