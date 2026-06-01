# AddressIQ — Node Backend Example

[![CI](https://github.com/PTLRepoHub/addressiq-node-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/PTLRepoHub/addressiq-node-backend/actions/workflows/ci.yml)

A minimal Express backend showing the **server-side** half of an AddressIQ
integration: creating widget sessions and verifying inbound webhook signatures.
No AddressIQ SDK package is required — it talks to the AddressIQ REST API
directly.

## Run

```bash
npm install
cp .env.example .env   # fill in your keys
npm run dev            # node --watch server.js
```

## Configuration

See `.env.example`. Set your `ADDRESSIQ_API_KEY`, the API/ingest URLs for your
environment, and the `WEBHOOK_SECRET` used to verify inbound webhook signatures.

> The values in `.env.example` are non-production placeholders. Never commit a
> real `.env` — it is gitignored.

## CI

`.github/workflows/ci.yml` installs dependencies and syntax-checks the server on
every push/PR. This repo's CI is green independent of any SDK release.
