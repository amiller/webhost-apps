# OAuth3 debug console — Twitter as a case study. Self-contained webhost-app,
# runtime=image on the tee-daemon. Real Brave (--no-sandbox, unprivileged) driven by
# GLM-4.5V vision + xdotool over X11, plus a rettiwt (reverse-engineered API) path.
# One image_port (3000, ws-bridge): dashboard + noVNC/live view + control + agent.
FROM ghcr.io/m1k1o/neko/brave:latest
USER root

RUN apt-get update && apt-get install -y curl ca-certificates gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && apt-get install -y nodejs xdotool x11vnc websockify openvpn iproute2 && \
    rm -rf /var/lib/apt/lists/*

# ProtonVPN full-tunnel (active only in an attested deploy with caps:[NET_ADMIN] + tun)
COPY vpn.sh /opt/vpn.sh
RUN chmod +x /opt/vpn.sh
COPY vpn.conf /etc/neko/supervisord/vpn.conf

# Envoy extension (CDP trace-capture) + ws-bridge
COPY extension/ /usr/share/chromium/extensions/envoy/
RUN chown -R neko:neko /usr/share/chromium/extensions
COPY ws-bridge.js /opt/envoy/ws-bridge.js
COPY bridge.conf /etc/neko/supervisord/bridge.conf
RUN cd /opt/envoy && npm install ws && mkdir -p /opt/envoy/web

# noVNC stream
COPY x11vnc.conf /etc/neko/supervisord/x11vnc.conf
COPY websockify.conf /etc/neko/supervisord/websockify.conf

# Brave: unprivileged, about:blank, no proxy
RUN rm -f /etc/neko/supervisord/chromium.conf
COPY brave.conf /etc/neko/supervisord/brave.conf
COPY policies.json /etc/brave/policies/managed/policies.json

# The debug-console agent. Deps FIRST (cached layer) so editing server.ts only rebuilds a tiny
# source layer — no npm reinstall, no giant node_modules re-push/re-pull. Fast iterations.
COPY package.json /opt/agent/package.json
RUN cd /opt/agent && npm install
COPY human-mouse.ts glm-vision.ts server.ts /opt/agent/
COPY twitter-server.conf /etc/neko/supervisord/twitter-agent.conf

# Dashboard last — a tiny top layer, so restyling the UI is a fast-iteration rebuild too.
COPY web/ /opt/envoy/web/

CMD ["/usr/bin/supervisord", "-c", "/etc/neko/supervisord.conf"]
