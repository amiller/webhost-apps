#!/usr/bin/env python3
"""Hand your logged-in otter.ai cookie to a Copilot instance — the script alternative to the
Otter Pilot extension. Reads sessionid+csrftoken from your local Chrome and POSTs them to the
onboarding URL you copied from the Connections panel.

  python3 onboard_otter.py "http://localhost:8137/onboard/otter?u=<token>"
"""
import json, sys, urllib.request
import browser_cookie3 as bc


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: onboard_otter.py <onboard-url-from-connections-panel>")
    jar = {c.name: c.value for c in bc.chrome(domain_name="otter.ai")}
    body = json.dumps({"sessionid": jar["sessionid"], "csrftoken": jar["csrftoken"]}).encode()
    req = urllib.request.Request(sys.argv[1], data=body,
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        print(json.loads(r.read()))


if __name__ == "__main__":
    main()
