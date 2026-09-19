#!/usr/bin/env bash
# Create (or reuse) the Hetzner relay box and deploy to it. Needs: brew install hcloud; HCLOUD_TOKEN in the env.
# usage: HCLOUD_TOKEN=... deploy/relay-up.sh [name] [server-type]
set -euo pipefail
NAME=${1:-citypin-relay}; TYPE=${2:-cx23}
KEY=$HOME/.ssh/citypin_deploy
[ -f "$KEY" ] || ssh-keygen -t ed25519 -N '' -f "$KEY" -C citypin-deploy >/dev/null
hcloud ssh-key describe citypin >/dev/null 2>&1 || hcloud ssh-key create --name citypin --public-key-from-file "$KEY.pub" >/dev/null
if ! hcloud server describe "$NAME" >/dev/null 2>&1; then
  hcloud server create --name "$NAME" --type "$TYPE" --image ubuntu-24.04 --location ash --ssh-key citypin \
    --user-data-from-file "$(dirname "$0")/cloud-init.yaml" >/dev/null
fi
IP=$(hcloud server ip "$NAME")
echo "server $NAME at $IP — waiting for first boot to finish"
until ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 root@"$IP" 'cloud-init status --wait >/dev/null 2>&1; command -v node >/dev/null' 2>/dev/null; do sleep 5; done
KEY=$KEY "$(dirname "$0")/relay-push.sh" "$IP"
