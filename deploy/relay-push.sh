#!/usr/bin/env bash
# Push the relay to a box that ran deploy/cloud-init.yaml, and (re)start it behind Caddy with TLS.
# usage: deploy/relay-push.sh <ip> [hostname]   (hostname defaults to <ip>.sslip.io, which needs no DNS)
set -euo pipefail
IP=$1; HOST=${2:-5-161-53-64.sslip.io}
KEY=${KEY:-$HOME/.ssh/citypin_deploy}
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new root@$IP"
cd "$(dirname "$0")/.."
rsync -az -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" --delete \
  --include='server/***' --include='shared/***' --include='public/' --include='public/data/' --include='public/data/toronto.json' \
  --include='package.json' --include='package-lock.json' --exclude='*' ./ root@$IP:/opt/citypin/
scp -i "$KEY" deploy/relay.service root@$IP:/etc/systemd/system/relay.service
$SSH "mkdir -p /var/lib/citypin && cd /opt/citypin && npm ci --omit=dev --no-audit --no-fund >/dev/null \
  && printf '%s, 5-161-53-64.sslip.io {\n\treverse_proxy localhost:8790\n}\n' '$HOST' > /etc/caddy/Caddyfile \
  && systemctl daemon-reload && systemctl enable --now relay && systemctl restart relay && systemctl reload caddy"
sleep 3
$SSH "curl -s localhost:8790/metrics | cut -c1-80"; echo
echo "relay is at wss://$HOST   (metrics: https://$HOST/metrics)"
