"""Check the shipped Besselian elements against a direct solve on the ephemeris.

Two different computations of the same thing: eclipse-recon/js/bessel.js reduces
the polynomial elements the catalogue ships, while this script root-solves the
apparent topocentric separation of the two discs straight out of JPL DE440s.
Agreement tests the element fit and the reduction together.

    uv run --with skyfield --with numpy python tools/eclipse-check.py

Prints one line per site and the worst difference at the end. Under about 50 ms
is the expected result; anything approaching a second means the elements, the
fit or the reduction has moved.
"""
import json
import pathlib
import subprocess
import sys

import numpy as np
from skyfield.api import Loader, wgs84

ROOT = pathlib.Path(__file__).resolve().parent.parent
R_SUN_KM = 696000.0
# ephemeris and time data live outside the repo: the kernel is 32 MB
load = Loader('~/.skyfield-data')

R_EARTH_KM = 6378.137
K_PENUMBRA = 0.272488
K_UMBRA = 0.272281

SITES = [
    ('2026-08-12', 'GE point, off Iceland', 65.2250, -25.2283),
    ('2026-08-12', 'Burgos', 42.3439, -3.6969),
    ('2026-08-12', 'near the south limit', 42.0500, -3.7000),
    ('2027-02-06', 'Bahia Blanca', -38.7183, -62.2661),
    ('2027-08-02', 'Luxor', 25.6872, 32.6396),
    ('2027-08-02', 'Vienna, partial', 48.2082, 16.3738),
    ('2028-01-26', 'Amazonas', -1.4558, -59.5000),
    ('2028-07-22', 'Sydney', -33.8688, 151.2093),
    ('2029-06-12', 'Vienna, grazing partial', 48.2082, 16.3738),
    ('2030-11-25', 'GE point', -43.6133, 71.2417),
    ('2031-11-14', 'GE point, hybrid', -0.6333, -137.6300),
    ('2033-03-30', 'Utqiagvik', 71.2906, -156.7886),
    ('2034-03-20', 'Luxor', 25.6872, 32.6396),
    ('2035-09-02', 'Sendai', 38.2682, 140.8694),
    ('2035-09-02', 'Beijing', 39.9042, 116.4074),
]

eph = load('de440s.bsp')
sun, moon, earth = eph['sun'], eph['moon'], eph['earth']


def catalogue():
    """The shipped records, read through node so the file itself is the input."""
    out = subprocess.run(
        ['node', '-e',
         'const c=require(process.argv[1]);console.log(JSON.stringify(c.ECLIPSES))',
         str(ROOT / 'eclipse-recon/js/eclipses.js')],
        capture_output=True, text=True, check=True)
    return {r['id']: r for r in json.loads(out.stdout)}


def engine(records, sites):
    """Local circumstances from bessel.js, in seconds since the day's UT midnight."""
    script = '''
const B = require(process.argv[1]);
const [recs, sites] = [2, 3].map(i => JSON.parse(process.argv[i]));
console.log(JSON.stringify(sites.map(([id, name, lat, lon]) => {
  const r = recs[id];
  const lc = B.localCircumstances(r, lat, lon, 0);
  const day = Date.UTC(r.date[0], r.date[1] - 1, r.date[2]);
  const s = c => c ? (c.date - day) / 1000 : null;
  return { c1: s(lc && lc.c1), c2: s(lc && lc.c2), c3: s(lc && lc.c3),
           c4: s(lc && lc.c4), dur: (lc && lc.duration) || null,
           alt: lc ? lc.sunAlt : null };
})));
'''
    out = subprocess.run(['node', '-e', script, str(ROOT / 'eclipse-recon/js/bessel.js'),
                          json.dumps(records), json.dumps(sites)],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def geometry(ts, site, jd_tt, k):
    t = ts.tt_jd(jd_tt)
    obs = (earth + site).at(t)
    s = obs.observe(sun).apparent()
    m = obs.observe(moon).apparent()
    return (float(s.separation_from(m).degrees),
            float(np.degrees(np.arcsin(R_SUN_KM / s.distance().km))),
            float(np.degrees(np.arcsin(k * R_EARTH_KM / m.distance().km))))


def root(f, lo, hi):
    flo = f(lo)
    if flo * f(hi) > 0:
        return None
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if flo * fm <= 0:
            hi = mid
        else:
            lo, flo = mid, fm
    return 0.5 * (lo + hi)


def deepest(ts, site, jd0):
    a, b = jd0 - 3 / 24, jd0 + 3 / 24
    gr = (5 ** 0.5 - 1) / 2
    c, d = b - gr * (b - a), a + gr * (b - a)
    for _ in range(80):
        if geometry(ts, site, c, K_UMBRA)[0] < geometry(ts, site, d, K_UMBRA)[0]:
            b, d = d, c
            c = b - gr * (b - a)
        else:
            a, c = c, d
            d = a + gr * (b - a)
    return 0.5 * (a + b)


def main():
    records = catalogue()
    rows = engine(records, SITES)
    worst = 0.0
    print(f"{'eclipse':11} {'site':24} {'C1':>7} {'C2':>7} {'C3':>7} {'C4':>7} "
          f"{'length':>8} {'Sun':>5}")
    for (eid, name, lat, lon), got in zip(SITES, rows):
        rec = records[eid]
        ts = load.timescale(delta_t=rec['deltaT'])
        site = wgs84.latlon(lat, lon)
        y, mo, d = rec['date']
        midnight = ts.tt(y, mo, d, 0, 0, 0).tt
        tmax = deepest(ts, site, midnight + rec['t0'] / 24)
        second = lambda jd: (jd - midnight) * 86400.0 - rec['deltaT']
        outer = lambda j: (lambda g: g[0] - (g[1] + g[2]))(geometry(ts, site, j, K_PENUMBRA))
        inner = lambda j: (lambda g: g[0] - abs(g[1] - g[2]))(geometry(ts, site, j, K_UMBRA))
        want = {'c1': root(outer, tmax - 3 / 24, tmax),
                'c4': root(outer, tmax, tmax + 3 / 24)}
        sep, r_sun, r_moon = geometry(ts, site, tmax, K_UMBRA)
        if r_moon > r_sun and sep < r_moon - r_sun:
            want['c2'] = root(inner, tmax - 1 / 24, tmax)
            want['c3'] = root(inner, tmax, tmax + 1 / 24)
        cells = []
        for key in ('c1', 'c2', 'c3', 'c4'):
            if got.get(key) is not None and want.get(key) is not None:
                diff = (got[key] - second(want[key])) * 1000
                worst = max(worst, abs(diff))
                cells.append(f'{diff:6.0f}m')
            else:
                cells.append(f'{"—":>7}')
        length = ''
        if got.get('dur') and want.get('c2') and want.get('c3'):
            length = f"{(got['dur'] - (want['c3'] - want['c2']) * 86400) * 1000:7.0f}m"
        print(f'{eid:11} {name[:24]:24} {" ".join(cells)} {length:>8} {got["alt"]:5.1f}')
    print(f'\nworst difference at any contact: {worst:.0f} ms')
    return 0 if worst < 100 else 1


if __name__ == '__main__':
    sys.exit(main())
