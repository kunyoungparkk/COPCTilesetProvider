import { describe, expect, it } from 'vitest';
import { geodeticToEcef } from '../src/crs/ecef.js';

// WGS84, exactly as the ellipsoid defines them: the semi-major axis, and the
// semi-minor axis a(1 - f) for the defining flattening f = 1/298.257223563.
// Written out rather than derived, so the test never repeats the module's
// own arithmetic back at it.
const A = 6_378_137;
const POLAR = 6_356_752.314_245_179;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * The outward surface normal at a geodetic position — which is what geodetic
 * latitude *means*, so this is a definition rather than a second conversion.
 */
function surfaceNormal(longitude: number, latitude: number): [number, number, number] {
  const lon = toRadians(longitude);
  const lat = toRadians(latitude);
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

describe('geodeticToEcef', () => {
  // Closed form, so these are not "what the code happens to produce" — they
  // are what the ellipsoid says, independently of any implementation.
  it('puts the origin on the semi-major axis', () => {
    const [x, y, z] = geodeticToEcef(0, 0, 0);

    expect(x).toBeCloseTo(A, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('puts 90 degrees east a quarter turn around', () => {
    const [x, y, z] = geodeticToEcef(90, 0, 0);

    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(A, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('puts the north pole on the semi-minor axis', () => {
    const [x, y, z] = geodeticToEcef(0, 90, 0);

    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(POLAR, 6);
  });

  // Away from the equator and the poles, where the normal and the ray from the
  // centre point in different directions. On the equator they coincide, so a
  // version that raises points radially would pass an equator-only check and be
  // metres wrong everywhere the data actually is.
  it('adds height along the normal, not along the radius', () => {
    const [sx, sy, sz] = geodeticToEcef(20, 45, 0);
    const [rx, ry, rz] = geodeticToEcef(20, 45, 1000);
    const [nx, ny, nz] = surfaceNormal(20, 45);

    expect(rx - sx).toBeCloseTo(1000 * nx, 6);
    expect(ry - sy).toBeCloseTo(1000 * ny, 6);
    expect(rz - sz).toBeCloseTo(1000 * nz, 6);
  });

  it('is symmetric about the equator', () => {
    const [, , north] = geodeticToEcef(12, 34, 56);
    const [, , south] = geodeticToEcef(12, -34, 56);

    expect(north).toBeCloseTo(-south, 6);
  });

  // Two facts that together pin a surface point down to one place, and that the
  // ellipsoid supplies on its own: the point lies on it, and the normal there
  // rises at the latitude asked for. Anything that reaches the ellipsoid at the
  // wrong latitude — a missing (1 - e²), say — fails one or the other.
  it('puts a surface point on the ellipsoid at the latitude asked for', () => {
    const [x, y, z] = geodeticToEcef(-123.06875, 44.05625, 0);

    expect((x * x + y * y) / (A * A) + (z * z) / (POLAR * POLAR)).toBeCloseTo(1, 12);
    // tan(geodetic latitude) = (a²/b²)·z/√(x²+y²): the normal's inclination,
    // steeper than the geocentric one everywhere but the equator and the poles.
    const latitude = Math.atan2(z * A * A, Math.hypot(x, y) * POLAR * POLAR);
    expect((latitude * 180) / Math.PI).toBeCloseTo(44.05625, 9);
  });

  // Autzen's own latitude, so the pipeline test downstream has a value that
  // was checked here first.
  it('places a point at Autzen on the right side of the Earth', () => {
    const [x, y, z] = geodeticToEcef(-123.06875, 44.05625, 100);

    expect(x).toBeLessThan(0); // western hemisphere
    expect(y).toBeLessThan(0); // and west of the 90th meridian
    expect(z).toBeGreaterThan(0); // northern hemisphere
    expect(Math.hypot(x, y, z)).toBeCloseTo(6_367_000, -4); // near the surface
  });
});
