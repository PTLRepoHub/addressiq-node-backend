# AddressIQ — Node Backend Example

[![CI](https://github.com/PTLRepoHub/addressiq-node-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/PTLRepoHub/addressiq-node-backend/actions/workflows/ci.yml)

A minimal Express backend showing the **server-side** half of an AddressIQ
integration. It is the AddressIQ analogue of OkHi's `js-core` server-JS package:
a **session minter**. It holds your tenant `ADDRESSIQ_API_KEY` server-side and
hands the browser a short-lived **session token** to mount IQCollect with — the
raw API key is never shipped to the browser.

It talks to the AddressIQ REST API directly; no AddressIQ SDK package is
required on the server.

## What this does

- **Mints widget sessions** (`POST /api/session`) using the server-held
  `x-api-key`, returning a `sessionToken` the browser uses as IQCollect's
  `apiKey` config field.
- **Serves a browser page** (`public/index.html`) that mints a session and
  mounts `@addressiq/iqcollect-web` with the minted token.
- **Proxies** address submission, verification status, and location pings.
- **Receives + verifies webhooks** (HMAC `x-addressiq-signature`).

## Architecture — server-mint → browser collect → mobile verify

```
  ┌─────────────────┐                           ┌───────────────────┐
  │  Browser page   │   1. POST /api/session    │  Node backend     │
  │  (public/       │ ────────────────────────▶ │  (this repo)      │
  │   index.html)   │   { phone, name, email }  │                   │
  │                 │                           │  holds API KEY    │ ──┐ x-api-key
  │                 │ ◀──────────────────────── │  (server-only)    │   │ (server→server)
  │                 │   { sessionToken, ... }   │                   │ ◀─┘
  │                 │   2.                      └───────────────────┘
  │  IQCollect      │                                    │
  │  mounted with   │   3. collect address               ▼
  │  apiKey =       │ ─────────────────────────▶  AddressIQ REST API
  │  sessionToken   │   returns locationCode            ( api.addressiqpro.com )
  └─────────────────┘
          │  locationCode
          ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  4. Mobile SDK (separate app): startVerification(            │
  │       { locationCode })  ── digital verification             │
  │     Browsers CANNOT verify → BROWSER_VERIFICATION_NOT_SUPPORTED│
  └─────────────────────────────────────────────────────────────┘
```

- **The `apiKey` is never sent to the browser.** The browser only ever sees the
  short-lived `sessionToken` minted by step 1.
- **Verification is mobile-only.** The browser SDK is collect-only: it returns a
  `locationCode`. Digital verification runs on the mobile SDK via
  `startVerification({ locationCode })`. The web SDK's `verify.*` surface
  rejects with `BROWSER_VERIFICATION_NOT_SUPPORTED`.

## Run

```bash
npm install
cp .env.example .env   # fill in your keys
npm start              # node server.js   (or: npm run dev — node --watch)
```

Then open <http://localhost:3333/> and click **Collect Address**. The page is
served by `express.static('public')`.

## Configuration

Copy `.env.example` to `.env` and set:

| Var                    | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `ADDRESSIQ_API_KEY`    | Your tenant API key. **Server-only — never sent to the browser.** |
| `ADDRESSIQ_API_URL`    | AddressIQ API base URL for your environment.                |
| `ADDRESSIQ_INGEST_URL` | Ingest API base URL (location pings).                       |
| `WEBHOOK_SECRET`       | HMAC secret used to verify inbound webhook signatures.      |
| `ENVIRONMENT`          | `production` / `staging` / `local` (default URL presets).   |
| `PORT`                 | HTTP port (default `3333`).                                 |

> The values in `.env.example` are non-production placeholders. Never commit a
> real `.env` — it is gitignored.

## Routes

| Method | Path                         | Description                                                       |
| ------ | ---------------------------- | ----------------------------------------------------------------- |
| `POST` | `/api/session`               | Mint a widget session (server→server with `x-api-key`). Returns `sessionToken`. |
| `POST` | `/api/submit-address`        | Submit a collected address using the session token.               |
| `GET`  | `/api/status/:verificationId`| Fetch verification status.                                        |
| `POST` | `/api/send-pings`            | Forward location pings to the ingest API.                         |
| `POST` | `/api/webhook`               | Receive + HMAC-verify inbound webhooks.                           |
| `GET`  | `/api/webhook/events`        | List recently received webhook events.                            |
| `POST` | `/api/simulate/:verificationId` | Dev shortcut to force a verification status.                   |
| `GET`  | `/`                          | Static browser demo (`public/index.html`).                        |

## CI

`.github/workflows/ci.yml` installs dependencies and syntax-checks the server on
every push/PR. This repo's CI is green independent of any SDK release.
