"""Build the eclipse catalogue from a JPL ephemeris.

    uv run --with skyfield --with numpy python tools/eclipse-elements.py 2026 2035

Finds every solar eclipse in the range, computes its polynomial Besselian
elements from DE440s, and prints the records in the shape
eclipse-recon/js/eclipses.js ships. The published NASA/GSFC element pages are
deliberately not the source: their VSOP87/ELP2000-85 geometry differs from a
modern ephemeris by up to 0.8 s of contact time, and the delta-T they carry is a
1990s prediction of the Earth's rotation, 11.6 s stale by 2035.

The construction is the classical one. The shadow axis is the line from the
Sun's centre through the Moon's centre; the fundamental plane passes through the
Earth's centre perpendicular to it, with z towards the Sun. x and y are the
axis' coordinates in that plane in equatorial Earth radii, d and mu its
declination and Greenwich hour angle, l1 and l2 the penumbral and umbral cone
radii there. mu is the *ephemeris* hour angle — sidereal time evaluated as
though UT1 were TT — which is why the reduction adds -1.002738*15*deltaT/3600 to
the observer's longitude rather than to the clock alone.

delta-T is Skyfield's: measured for a past eclipse, and the current IERS-based
extrapolation for a future one.

Check the result with tools/eclipse-check.py, which reduces these elements and
compares them against a direct topocentric solve on the same ephemeris.
"""
import sys

import numpy as np
from skyfield import almanac
from skyfield.api import Loader
from skyfield.framelib import true_equator_and_equinox_of_date

# ephemeris and time data live outside the repo: the kernel is 32 MB
load = Loader('~/.skyfield-data')

R_EARTH_KM = 6378.137
R_SUN_KM = 696000.0          # the radius behind the 959.63" solar semi-diameter
K1 = 0.272488                # lunar radius for the penumbral cone, Earth radii
K2 = 0.272281                # and for the umbral one, smaller on purpose
FIT_SPAN_HOURS = 3.5         # NASA fits over +/- 3; this covers the same window
FIT_SAMPLES = 29

eph = load('de440s.bsp')
sun, moon, earth = eph['sun'], eph['moon'], eph['earth']
rotation = load.timescale(delta_t=0.0)   # sidereal time as though UT1 = TT
clock = load.timescale()                 # for delta-T alone


def elements_at(jd_tt):
    t = rotation.tt_jd(jd_tt)
    here = earth.at(t)
    S = here.observe(sun).apparent().frame_xyz(true_equator_and_equinox_of_date).km
    M = here.observe(moon).apparent().frame_xyz(true_equator_and_equinox_of_date).km
    axis = S - M
    length = np.linalg.norm(axis)
    rho = length / R_EARTH_KM                       # Sun-Moon distance, Earth radii
    a = np.arctan2(axis[1], axis[0])
    d = np.arcsin(axis[2] / length)
    xhat = np.array([-np.sin(a), np.cos(a), 0.0])
    yhat = np.array([-np.sin(d) * np.cos(a), -np.sin(d) * np.sin(a), np.cos(d)])
    zhat = np.array([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)])
    Mr = M / R_EARTH_KM
    x, y, z = Mr @ xhat, Mr @ yhat, Mr @ zhat
    sr = R_SUN_KM / R_EARTH_KM
    sin_f1, sin_f2 = (sr + K1) / rho, (sr - K2) / rho
    tan_f1 = sin_f1 / np.sqrt(1 - sin_f1 ** 2)
    tan_f2 = sin_f2 / np.sqrt(1 - sin_f2 ** 2)
    return {'x': x, 'y': y, 'z': z, 'd': np.degrees(d),
            'mu': (t.gast * 15.0 - np.degrees(a)) % 360.0,
            'l1': (z + K1 / sin_f1) * tan_f1,
            'l2': (z - K2 / sin_f2) * tan_f2,
            'tanF1': tan_f1, 'tanF2': tan_f2}


def axis_distance(jd_tt):
    """How far the shadow axis passes from the Earth's centre, in Earth radii."""
    el = elements_at(jd_tt)
    return float(np.hypot(el['x'], el['y']))


def greatest(jd_guess):
    """Golden-section on that distance: the instant of greatest eclipse."""
    a, b = jd_guess - 0.25, jd_guess + 0.25
    gr = (5 ** 0.5 - 1) / 2
    c, d = b - gr * (b - a), a + gr * (b - a)
    for _ in range(70):
        if axis_distance(c) < axis_distance(d):
            b, d = d, c
            c = b - gr * (b - a)
        else:
            a, c = c, d
            d = a + gr * (b - a)
    return 0.5 * (a + b)


def eclipses(year_from, year_to):
    """Every new moon whose shadow axis comes close enough to touch the Earth."""
    t0 = clock.utc(year_from, 1, 1)
    t1 = clock.utc(year_to + 1, 1, 1)
    times, phases = almanac.find_discrete(t0, t1, almanac.moon_phases(eph))
    found = []
    for t, phase in zip(times, phases):
        if phase != 0:                       # 0 is new moon
            continue
        jd = greatest(t.tt)
        el = elements_at(jd)
        # the penumbra touches the Earth when the axis passes within 1 + l1
        if axis_distance(jd) < 1.0 + el['l1']:
            found.append(jd)
    return found


def fit(jd_greatest, delta_t):
    """Cubics in the hours from t0, t0 being the whole UT hour nearest greatest."""
    day = np.floor(jd_greatest - 0.5) + 0.5           # JD(TT) of TT midnight
    t0 = round((jd_greatest - day) * 24.0)
    taus = np.linspace(-FIT_SPAN_HOURS, FIT_SPAN_HOURS, FIT_SAMPLES)
    rows = [elements_at(day + (t0 + tau) / 24.0) for tau in taus]
    design = np.vander(taus, 4, increasing=True)
    out, worst = {}, {}
    series = {k: [r[k] for r in rows] for k in ('x', 'y', 'd', 'l1', 'l2')}
    series['mu'] = list(np.unwrap([r['mu'] for r in rows], period=360.0))
    for key, values in series.items():
        coef, *_ = np.linalg.lstsq(design, np.array(values), rcond=None)
        out[key] = [float(c) for c in coef]
        worst[key] = float(np.max(np.abs(design @ coef - np.array(values))))
    out['mu'][0] %= 360.0
    middle = rows[FIT_SAMPLES // 2]
    out['tanF1'] = float(middle['tanF1'])
    out['tanF2'] = float(middle['tanF2'])
    return t0, out, worst


def number(v, dp=8):
    if abs(v) < 5e-9:                 # under the fit's own noise across the window
        text = '0.0'
    else:
        text = f'{v:.{dp}f}'.rstrip('0')
        if text.endswith('.'):
            text += '0'
    return text if text.startswith('-') else ' ' + text


def record(eid, date, t0, delta_t, el):
    keys = ('x', 'y', 'd', 'l1', 'l2', 'mu')
    cells = {k: [number(v) for v in el[k]] for k in keys}
    width = [max(len(cells[k][i]) for k in keys) for i in range(4)]
    lines = ['  {', f"    id: '{eid}',",
             f'    date: [{date[0]}, {date[1]}, {date[2]}],',
             f'    t0: {t0:.1f},', f'    deltaT: {delta_t:.2f},']
    for k in keys:
        lines.append(f'    {(k + ":").ljust(4)}[' +
                     ', '.join(c.rjust(width[i]) for i, c in enumerate(cells[k])) + '],')
    lines += [f"    tanF1: {el['tanF1']:.7f},", f"    tanF2: {el['tanF2']:.7f}", '  }']
    return '\n'.join(lines)


def main(year_from, year_to):
    blocks = []
    for jd in eclipses(year_from, year_to):
        t = clock.tt_jd(jd)
        delta_t = round(float(t.delta_t), 2)
        t0, el, worst = fit(jd, delta_t)
        ut = clock.tt_jd(jd - delta_t / 86400.0).utc
        date = (ut.year, ut.month, ut.day)
        eid = f'{date[0]}-{date[1]:02d}-{date[2]:02d}'
        blocks.append(record(eid, date, t0, delta_t, el))
        print(f'{eid}  fit residual x {worst["x"]:.1e}  y {worst["y"]:.1e}  '
              f'mu {worst["mu"]:.1e}  deltaT {delta_t}', file=sys.stderr)
    print(',\n'.join(blocks))


if __name__ == '__main__':
    main(int(sys.argv[1]), int(sys.argv[2]))
