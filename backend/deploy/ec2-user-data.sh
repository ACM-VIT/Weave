#!/bin/bash
set -euxo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this bootstrap as root (EC2 user data already runs as root)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "This bootstrap supports Ubuntu EC2 images; found ${ID:-unknown}." >&2
  exit 1
fi

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
systemctl enable --now docker

if id ubuntu >/dev/null 2>&1; then
  usermod -aG docker ubuntu
fi

install -d -m 0700 -o root -g root /etc/gh-social
install -d -m 0755 -o root -g root /opt/gh-social/docs/runbooks
touch /var/lib/cloud/instance/gh-social-bootstrap-complete
