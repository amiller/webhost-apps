#!/bin/bash
# ProtonVPN full-tunnel INSIDE the container. Requires NET_ADMIN + /dev/net/tun — i.e. an
# ATTESTED daemon deploy with caps:[NET_ADMIN] (dev/opaque never get it). Degrades to a
# graceful no-op (direct egress) when the tun device or config is absent, so the same image
# still runs un-attested. redirect-gateway (in the ProtonVPN config) keeps the per-project
# docker /24 as a connected route, so the daemon's inbound to image_port still works.
set -uo pipefail
if [ ! -e /dev/net/tun ] || [ -z "${OVPN_CONFIG_BASE64:-}" ]; then
  echo "[vpn] no /dev/net/tun or OVPN_CONFIG_BASE64 — direct egress (not attested / no caps)"
  exec sleep infinity
fi
mkdir -p /vpn
echo "$OVPN_CONFIG_BASE64" | base64 -d > /vpn/config.ovpn
printf '%s\n%s\n' "${OPENVPN_USER:-}" "${OPENVPN_PASS:-}" > /vpn/auth.txt
chmod 600 /vpn/auth.txt
sed -i 's|^auth-user-pass$|auth-user-pass /vpn/auth.txt|' /vpn/config.ovpn
sed -i '/update-resolv-conf/d;/script-security 2/d' /vpn/config.ovpn
echo 'nameserver 1.1.1.1' > /etc/resolv.conf 2>/dev/null || true
echo "[vpn] starting OpenVPN (ProtonVPN, full-tunnel)"
exec openvpn --config /vpn/config.ovpn --auth-nocache --auth-user-pass /vpn/auth.txt
