/**
 * Solar position from date + location — pure math, no dependencies and no coupling
 * to any mapping library. Algorithm adapted from the well-known SunCalc routines
 * (Vladimir Agafonkin, BSD-2). Returns compass-based angles in degrees:
 *   azimuth  — direction the sun is in, 0 = north, 90 = east, clockwise
 *   altitude — angle above the horizon, negative when the sun is down
 */
export interface SunPosition {
    azimuth: number;   // degrees, clockwise from north
    altitude: number;  // degrees above horizon
}

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397; // Earth's axial tilt

function toDays(date: Date): number {
    return date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
}

function solarMeanAnomaly(d: number): number {
    return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M: number): number {
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const P = RAD * 102.9372; // perihelion of the Earth
    return M + C + P + Math.PI;
}

function declination(l: number): number {
    return Math.asin(Math.sin(OBLIQUITY) * Math.sin(l));
}

function rightAscension(l: number): number {
    return Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l));
}

function siderealTime(d: number, lw: number): number {
    return RAD * (280.16 + 360.9856235 * d) - lw;
}

export function sunPosition(date: Date, lat: number, lng: number): SunPosition {
    const lw = RAD * -lng;
    const phi = RAD * lat;
    const d = toDays(date);

    const M = solarMeanAnomaly(d);
    const L = eclipticLongitude(M);
    const dec = declination(L);
    const ra = rightAscension(L);
    const H = siderealTime(d, lw) - ra;

    // SunCalc azimuth is measured from south, clockwise toward west; convert to a
    // compass bearing measured from north.
    const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));

    let azimuth = azSouth / RAD + 180;
    azimuth = ((azimuth % 360) + 360) % 360;

    return { azimuth, altitude: altitude / RAD };
}
