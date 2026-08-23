/* Where you are, and what the clock says there.

   Three ways in, and they are tried in this order on purpose: a pair of
   coordinates is read here and never leaves the page; the browser's own
   position is asked for only when you press the button; a place name is the
   one case that has to ask somebody, and it asks Open-Meteo. Nothing but the
   words you typed is ever sent. */
var Places = (function () {
  'use strict';

  var GEOCODER = 'https://geocoding-api.open-meteo.com/v1/search';

  /* "48.21, 16.37", "48.21 16.37", "48.21N 16.37E". Anything with two numbers
     in range and nothing else. */
  function parseCoords(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    var m = t.match(/^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?\s*$/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lon = parseFloat(m[3]);
    if (m[2] && /[Ss]/.test(m[2])) lat = -lat;
    if (m[4] && /[Ww]/.test(m[4])) lon = -lon;
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: lat, lon: lon };
  }

  function search(query, signal) {
    var url = GEOCODER + '?name=' + encodeURIComponent(query) +
              '&count=8&language=en&format=json';
    return fetch(url, { signal: signal }).then(function (r) {
      if (!r.ok) throw new Error('geocoder said ' + r.status);
      return r.json();
    }).then(function (d) {
      return (d.results || []).map(function (r) {
        return {
          name: r.name,
          label: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
          lat: r.latitude, lon: r.longitude,
          elevation: r.elevation || 0,
          timezone: r.timezone || deviceZone()
        };
      });
    });
  }

  function here() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('this browser has no geolocation'));
      navigator.geolocation.getCurrentPosition(function (pos) {
        resolve({
          name: 'where you are',
          label: 'where you are',
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          elevation: pos.coords.altitude || 0,
          timezone: deviceZone()
        });
      }, function (err) { reject(err); },
        { timeout: 15000, maximumAge: 600000, enableHighAccuracy: false });
    });
  }

  function deviceZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (e) { return 'UTC'; }
  }

  /* ---- clocks ---------------------------------------------------------

     A place has its own time zone, and "ten at night" means ten at night
     THERE. These two turn an instant into that place's wall clock and back.
     Doing it with Intl rather than a fixed offset is what makes the hour
     survive a daylight-saving boundary. */

  function offsetMs(date, zone) {
    try {
      var dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      var p = {};
      dtf.formatToParts(date).forEach(function (part) { p[part.type] = part.value; });
      var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day,
                           +p.hour % 24, +p.minute, +p.second);
      return asUTC - date.getTime();
    } catch (e) { return 0; }
  }

  /* An instant -> the "YYYY-MM-DDTHH:MM" a datetime-local input wants. */
  function toLocalInput(date, zone) {
    var shifted = new Date(date.getTime() + offsetMs(date, zone));
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' +
           pad(shifted.getUTCDate()) + 'T' + pad(shifted.getUTCHours()) + ':' +
           pad(shifted.getUTCMinutes());
  }

  /* And back. The offset depends on the instant, and the instant is what we
     are solving for, so it is applied twice -- which settles it except in the
     one ambiguous hour when a clock goes back. */
  function fromLocalInput(value, zone) {
    var m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    var wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    var guess = new Date(wall - offsetMs(new Date(wall), zone));
    return new Date(wall - offsetMs(guess, zone));
  }

  function zoneLabel(date, zone) {
    try {
      var dtf = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' });
      var part = dtf.formatToParts(date).find(function (p) { return p.type === 'timeZoneName'; });
      return part ? part.value : zone;
    } catch (e) { return zone; }
  }

  return {
    parseCoords: parseCoords, search: search, here: here, deviceZone: deviceZone,
    offsetMs: offsetMs, toLocalInput: toLocalInput, fromLocalInput: fromLocalInput,
    zoneLabel: zoneLabel, GEOCODER: GEOCODER
  };
})();
if (typeof module !== 'undefined') module.exports = Places;
