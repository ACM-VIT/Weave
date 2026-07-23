# EC2 host and HTTPS ingress

The backend release remains the four systemd-managed containers documented in
`backend/README.md`. This runbook adds only the reusable host bootstrap and
Caddy ingress from the EC2 deployment proposal. It does not create a private
Redis instance or replace the existing migration, schema-audit, readiness, and
rollback workflow.

## 1. Bootstrap an Ubuntu EC2 host

Supply `backend/deploy/ec2-user-data.sh` as EC2 user data on a fresh Ubuntu
instance. It installs Docker from Docker's official Ubuntu repository, enables
the daemon, and creates the root-controlled deployment directories.

The instance security group should expose ports 80 and 443 publicly and limit
port 22 to trusted administration addresses. Do not expose the backend's port
5000, PostgreSQL, or Redis publicly. Point the backend DNS record at the
instance before starting Caddy.

## 2. Configure the proxy

Install the committed assets:

```sh
sudo install -o root -g root -m 0644 backend/deploy/caddy/Caddyfile /etc/gh-social/Caddyfile
sudo install -o root -g root -m 0644 backend/deploy/systemd/gh-social-proxy.service /etc/systemd/system/gh-social-proxy.service
sudo install -o root -g root -m 0600 backend/deploy/caddy/proxy.env.example /etc/gh-social/proxy.env
```

Edit `/etc/gh-social/proxy.env` and set the public backend domain, ACME contact
email, loopback backend upstream, and an approved immutable Caddy image digest.
The proxy deliberately uses host networking so it can reach the existing API
container at `127.0.0.1:5000`; Redis remains the externally shared deployment
used by both the backend and ML feedback consumer.

Validate the configuration before activation:

```sh
set -a
. /etc/gh-social/proxy.env
set +a
sudo docker run --rm \
  --env-file /etc/gh-social/proxy.env \
  --volume /etc/gh-social/Caddyfile:/etc/caddy/Caddyfile:ro \
  "$CADDY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemd-analyze verify /etc/systemd/system/gh-social-proxy.service
```

## 3. Activate and verify

Start the API first, then enable the stable ingress service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now gh-social-proxy.service
curl --fail --silent --show-error "https://${BACKEND_DOMAIN}/readyz"
sudo systemctl status gh-social-proxy.service --no-pager
```

`/healthz` reports only process liveness. Production acceptance and every
backend release must continue to use `/readyz`, which checks PostgreSQL, shared
Redis, ML, the durable outbox, and enabled feature dependencies.
