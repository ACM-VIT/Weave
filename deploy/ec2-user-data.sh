#!/bin/bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl unzip

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

if ! command -v aws >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64) awscli_arch=x86_64 ;;
    aarch64|arm64) awscli_arch=aarch64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awscli_arch}.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp/awscliv2
  /tmp/awscliv2/aws/install
  rm -rf /tmp/awscliv2 /tmp/awscliv2.zip
fi

install -d -m 0750 -o ubuntu -g ubuntu /opt/weave-backend
touch /var/lib/cloud/instance/weave-bootstrap-complete
