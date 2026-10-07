"""Preview the xan.gripe pages locally before publishing them.

    python scripts/preview-site.py [port]

Serves site/ (so /k3/ and /vitra/ are the local drafts). Anything that only
exists on the live site, such as installers or other projects' pages, is
redirected to https://xan.gripe so links still work.
"""
import http.server
import os
import sys
import urllib.parse

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
LIVE = "https://xan.gripe"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/":
            return self.redirect("/k3/")
        local = self.translate_path(path)
        if os.path.isdir(local):
            local = os.path.join(local, "index.html")
        if not os.path.exists(local):
            return self.redirect(LIVE + self.path)
        super().do_GET()

    def redirect(self, to):
        self.send_response(302)
        self.send_header("Location", to)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5317
    print(f"previewing site/ at http://localhost:{port}/k3/", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
