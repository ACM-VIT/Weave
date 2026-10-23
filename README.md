# WEave / GH Social

WEave is an Expo application for discovering, saving, discussing, and receiving personalized recommendations for GitHub repositories. The repository contains the Expo client, the Express/PostgreSQL backend, Redis-backed feed workers, database migrations, and the versioned backend-to-ML contract.

## Architecture

- The Expo SDK 56 client calls only the public backend HTTP API.
- PostgreSQL is the durable source of truth for product state and telemetry.
- Redis is an expendable, versioned feed queue with reservation recovery.
- Backend workers deliver durable outbox jobs to the authenticated ML API.
- ML owns Qdrant vectors and model artifacts; it does not own product records.
- Backend UUIDs are the canonical user and repository identities across services.

The authoritative API and operating contract is in [backend/README.md](backend/README.md). The full design and staged rollout are documented in [BACKEND_ML_PRODUCTION_ARCHITECTURE.md](BACKEND_ML_PRODUCTION_ARCHITECTURE.md), with parallel ownership and merge rules in [BACKEND_ML_TWO_PERSON_WORKSPLIT.md](BACKEND_ML_TWO_PERSON_WORKSPLIT.md).

## Local development

Requirements:

- Node.js 20.19 or newer
- PostgreSQL/Supabase
- Redis
- The separately deployed ML service for personalized generation

Install and validate the Expo app:

```bash
npm install
npm run lint
npx tsc --noEmit
npx expo start
```

Configure the backend and run it separately:

```bash
cd backend
npm install
npm run build
npm test
npm run migrate
npm run dev
```

Copy the root and backend `.env.example` files to `.env` files and supply local credentials. Never commit real secrets. The v2 feature flags and production process topology are described in the backend README.

## Production processes

Run the API and worker roles as separate processes:

```text
API:                  npm start
Outbox worker:        WORKER_ROLE=outbox npm run worker
Feed reconciliation: WORKER_ROLE=feed npm run worker
Maintenance:         WORKER_ROLE=maintenance npm run worker
```

Before a release, require the frontend lint/type checks, backend build/tests, schema audit, database and HTTP integration tests, healthy outbox/Redis/ML dependencies, and the cutover gates in the architecture plan. Do not enable a full production cohort from local test results alone.

Home keeps at most 500 cards for back-scroll and in-memory offline history.
The retention policy and local validation are documented in
[Home feed history](docs/runbooks/home-feed-history.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Backend/ML work must also follow the file ownership, contract-freeze, migration-numbering, and controlled-integration rules in the two-person work plan.
