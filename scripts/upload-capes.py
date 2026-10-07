"""Uploads the preset capes in services/vitra-api/presets/ to api.xan.gripe.

    python scripts/upload-capes.py [slug ...]

Needs the admin key at ~/.tauri/vitra-api-admin.key (the same value as the Worker's ADMIN_KEY secret).
"""
import base64
import glob
import json
import os
import sys
import urllib.request

API = "https://api.xan.gripe"
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services", "vitra-api", "presets")
KEY = open(os.path.expanduser("~/.tauri/vitra-api-admin.key"), encoding="utf-8").read().strip()

wanted = set(sys.argv[1:])
for meta_path in sorted(glob.glob(os.path.join(HERE, "*.json"))):
    meta = json.load(open(meta_path, encoding="utf-8"))
    if wanted and meta["slug"] not in wanted:
        continue
    png = open(meta_path[:-5] + ".png", "rb").read()
    body = json.dumps({"image": base64.b64encode(png).decode(), "frames": meta["frames"], "delay": meta["delay"],
                       "title": meta["title"], "sort": meta["sort"]}).encode()
    req = urllib.request.Request(f"{API}/v1/admin/presets/{meta['slug']}", data=body, method="PUT",
                                 headers={"content-type": "application/json", "x-admin-key": KEY,
                                          "user-agent": "vitra-upload-capes/1.0"})
    try:
        print(meta["slug"], urllib.request.urlopen(req, timeout=60).read().decode())
    except urllib.error.HTTPError as e:
        print(meta["slug"], "failed:", e.code, e.read().decode())
