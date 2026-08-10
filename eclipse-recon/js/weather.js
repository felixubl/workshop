/* Eclipse Recon — the weather desk.
   Three modes, chosen by how far away the event is:
   - forecast     eclipse within ~15 days: the Open-Meteo forecast, hourly
   - archive      eclipse in the past: what the sky actually did (ERA5)
   - climatology  eclipse further out: the same calendar date over the last
                  ten years of ERA5, averaged — the odds, not a promise

   Endpoints: api.open-meteo.com, archive-api.open-meteo.com,
   geocoding-api.open-meteo.com (search), api.bigdatacloud.net (name for a
   coordinate). All keyless. Nothing is sent until a mode that needs it runs. */

var Wx = (function () {
  'use strict';

  var FORECAST_DAYS = 15;
  var CLIMO_YEARS = 8;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoDate(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }

  function modeFor(eclipseDate) {
    var now = Date.now();
    var t = eclipseDate.getTime();
    if (t < now - 86400000) return 'archive';
    if (t - now < FORECAST_DAYS * 86400000) return 'forecast';
    return 'climatology';
  }

  function getJSON(url, signal) {
    return fetch(url, { signal: signal }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* One batched call for up to ~40 points. Returns an array (per point) of
     { tz, utcOffsetSec, hours: [{tUTCms, low, mid, high, total, precip,
       precipProb, wind, temp}] }. */
  function fetchHourly(base, points, dateISO, extraParams, signal) {
    var lats = points.map(function (p) { return p.lat.toFixed(4); }).join(',');
    var lons = points.map(function (p) { return p.lon.toFixed(4); }).join(',');
    var hourly = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,' +
                 'precipitation,wind_speed_10m,temperature_2m' + (extraParams || '');
    var url = base + '?latitude=' + lats + '&longitude=' + lons +
              '&hourly=' + hourly +
              '&start_date=' + dateISO + '&end_date=' + dateISO +
              '&timezone=auto&windspeed_unit=kmh';
    return getJSON(url, signal).then(function (data) {
      var items = Array.isArray(data) ? data : [data];
      return items.map(function (item) {
        var H = item.hourly || {};
        var times = H.time || [];
        var off = (item.utc_offset_seconds || 0) * 1000;
        var hours = times.map(function (t, i) {
          return {
            tUTCms: Date.parse(t + 'Z') - off,
            low: numOr(H.cloud_cover_low, i),
            mid: numOr(H.cloud_cover_mid, i),
            high: numOr(H.cloud_cover_high, i),
            total: numOr(H.cloud_cover, i),
            precip: numOr(H.precipitation, i),
            precipProb: numOr(H.precipitation_probability, i),
            wind: numOr(H.wind_speed_10m, i),
            temp: numOr(H.temperature_2m, i)
          };
        });
        return {
          tz: item.timezone || 'UTC',
          utcOffsetSec: item.utc_offset_seconds || 0,
          hours: hours
        };
      });
    });
  }

  function numOr(arr, i) {
    var v = arr ? arr[i] : null;
    return (v === null || v === undefined || isNaN(v)) ? null : v;
  }

  /* Linear interpolation of a point's hourly series to an exact moment. */
  function atTime(pointData, dateUTC) {
    var hs = pointData.hours;
    if (!hs || !hs.length) return null;
    var t = dateUTC.getTime();
    if (t <= hs[0].tUTCms) return hs[0];
    for (var i = 1; i < hs.length; i++) {
      if (hs[i].tUTCms >= t) {
        var a = hs[i - 1], b = hs[i];
        var f = (t - a.tUTCms) / (b.tUTCms - a.tUTCms);
        var out = {};
        ['low', 'mid', 'high', 'total', 'precip', 'precipProb', 'wind', 'temp']
          .forEach(function (k) {
            out[k] = (a[k] === null || b[k] === null) ? (b[k] !== null ? b[k] : a[k])
                     : a[k] + (b[k] - a[k]) * f;
          });
        return out;
      }
    }
    return hs[hs.length - 1];
  }

  /* Forecast for points on a date (each { lat, lon }); chunked. */
  function forecast(points, eclipseDate, signal) {
    var d = isoDate(eclipseDate.getUTCFullYear(), eclipseDate.getUTCMonth() + 1,
                    eclipseDate.getUTCDate());
    return batched(points, 40, function (chunk) {
      return fetchHourly('https://api.open-meteo.com/v1/forecast', chunk, d,
                         ',precipitation_probability,visibility', signal);
    });
  }

  /* What the sky actually did (for archived eclipses). */
  function archive(points, eclipseDate, signal) {
    var d = isoDate(eclipseDate.getUTCFullYear(), eclipseDate.getUTCMonth() + 1,
                    eclipseDate.getUTCDate());
    return batched(points, 40, function (chunk) {
      return fetchHourly('https://archive-api.open-meteo.com/v1/archive', chunk,
                         d, '', signal);
    });
  }

  /* Ten-ish years of the same calendar date. Returns per point
     { climo: true, years, hours } where hours holds the per-hour mean across
     years (tUTCms mapped onto the eclipse year for easy lookup). */
  function climatology(points, eclipseDate, signal) {
    var m = eclipseDate.getUTCMonth() + 1, day = eclipseDate.getUTCDate();
    var thisYear = new Date().getUTCFullYear();
    var years = [];
    for (var y = thisYear - CLIMO_YEARS; y < thisYear; y++) years.push(y);
    var perYear = years.map(function (y) {
      var d = isoDate(y, m, day);
      return batched(points, 40, function (chunk) {
        return fetchHourly('https://archive-api.open-meteo.com/v1/archive',
                           chunk, d, '', signal);
      });
    });
    return Promise.all(perYear).then(function (all) {
      // all[yearIdx][pointIdx] -> average across years, hour by hour
      return points.map(function (_, pi) {
        var tz = all[0][pi].tz, off = all[0][pi].utcOffsetSec;
        var nH = all[0][pi].hours.length;
        var hours = [];
        for (var h = 0; h < nH; h++) {
          var acc = { n: 0, low: 0, mid: 0, high: 0, total: 0, precip: 0, wind: 0, temp: 0 };
          all.forEach(function (yr) {
            var hh = yr[pi].hours[h];
            if (!hh || hh.total === null) return;
            acc.n++;
            acc.low += hh.low || 0; acc.mid += hh.mid || 0;
            acc.high += hh.high || 0; acc.total += hh.total || 0;
            acc.precip += hh.precip || 0; acc.wind += hh.wind || 0;
            acc.temp += hh.temp || 0;
          });
          var base = all[0][pi].hours[h];
          var refMs = base ? base.tUTCms : null;
          // re-anchor the clock onto the eclipse's own year
          var anchored = null;
          if (refMs !== null) {
            var dRef = new Date(refMs);
            anchored = Date.UTC(eclipseDate.getUTCFullYear(),
                                dRef.getUTCMonth(), dRef.getUTCDate(),
                                dRef.getUTCHours(), dRef.getUTCMinutes());
          }
          hours.push(acc.n === 0 ? { tUTCms: anchored, total: null } : {
            tUTCms: anchored,
            low: acc.low / acc.n, mid: acc.mid / acc.n, high: acc.high / acc.n,
            total: acc.total / acc.n, precip: acc.precip / acc.n,
            precipProb: null, wind: acc.wind / acc.n, temp: acc.temp / acc.n
          });
        }
        return { tz: tz, utcOffsetSec: off, hours: hours,
                 climo: true, years: years.length };
      });
    });
  }

  function batched(points, size, run) {
    var chunks = [];
    for (var i = 0; i < points.length; i += size) {
      chunks.push(points.slice(i, i + size));
    }
    // sequential chunks: kinder to the API, order preserved
    var out = [];
    return chunks.reduce(function (p, chunk) {
      return p.then(function () {
        return run(chunk).then(function (res) { out.push.apply(out, res); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* Fetch by whatever mode the date demands. Resolves
     { mode, data: [per point] }. */
  function get(points, eclipseDate, signal) {
    var mode = modeFor(eclipseDate);
    var fn = mode === 'forecast' ? forecast : mode === 'archive' ? archive : climatology;
    return fn(points, eclipseDate, signal).then(function (data) {
      return { mode: mode, data: data };
    });
  }

  /* Sky score 0..100 from conditions at eclipse time. Low cloud is fatal,
     cirrus is survivable; rain probability drags it further down. */
  function skyScore(c) {
    if (!c || c.total === null) return null;
    var low = c.low || 0, mid = c.mid || 0, high = c.high || 0;
    var s = 100 - (0.55 * low + 0.33 * mid + 0.12 * high);
    if (c.precipProb !== null && c.precipProb !== undefined) {
      s -= c.precipProb * 0.25;
    } else if (c.precip) {
      s -= Math.min(25, c.precip * 12);
    }
    return Math.max(0, Math.min(100, s));
  }

  function verdictFor(score) {
    if (score === null) return { code: 'UNKN', word: 'NO DATA' };
    if (score >= 70) return { code: 'GO', word: 'GO' };
    if (score >= 45) return { code: 'COND', word: 'CONDITIONAL' };
    return { code: 'NOGO', word: 'NO-GO' };
  }

  /* Place search (Open-Meteo geocoder). */
  function search(q, signal) {
    var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
              encodeURIComponent(q) + '&count=8&language=en&format=json';
    return getJSON(url, signal).then(function (d) { return d.results || []; });
  }

  /* Name for a coordinate (BigDataCloud, keyless). Best-effort. */
  function placeName(lat, lon, signal) {
    var url = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' +
              lat.toFixed(4) + '&longitude=' + lon.toFixed(4) + '&localityLanguage=en';
    return getJSON(url, signal).then(function (d) {
      var parts = [d.city || d.locality, d.principalSubdivision, d.countryCode]
        .filter(Boolean);
      return parts.length ? parts.join(', ') : null;
    }).catch(function () { return null; });
  }

  return {
    modeFor: modeFor,
    get: get,
    atTime: atTime,
    skyScore: skyScore,
    verdictFor: verdictFor,
    search: search,
    placeName: placeName
  };
})();
