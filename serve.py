#!/usr/bin/env python3
"""The workshop, served locally.

`python3 -m http.server` answers 304 Not Modified for anything whose timestamp
it has seen before, which means an edited stylesheet, an edited article or a
redrawn favicon can keep serving the old bytes while you stare at the page and
doubt yourself. This server sends no-store and strips the validators, so every
reload is a real fetch.

    python3 serve.py [port]        default 8770

Note that a browser caches the FAVICON separately from everything else, and
often keeps it across a hard reload. If the tab icon looks stale, open
/assets/favicon.svg directly in a tab, which forces the fetch.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_header(self, keyword, value):
        # Drop the validators, or the browser will still ask and still be told
        # nothing changed.
        if keyword.lower() in ('last-modified', 'etag'):
            return
        super().send_header(keyword, value)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    handler = partial(NoCacheHandler, directory='.')
    with ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
        print('workshop on http://localhost:%d  (no-store, Ctrl+C to stop)' % port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nstopped')


if __name__ == '__main__':
    main()
