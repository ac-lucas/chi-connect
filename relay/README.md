# Pebble relay

A small message relay so two phones can reach each other when they are not side by side. It has no accounts and stores no profiles. It only ever holds:

| What | Contents | How long |
| --- | --- | --- |
| Mailbox | random 128-bit ID, SHA-256 hash of the owner's read token, last-used time | deleted after 45 days unused |
| Message | mailbox ID, opaque ciphertext (encrypted on the phone), created and expiry times | until read and acknowledged, at most 24 hours |
| Pairing code | six-digit code, opaque ciphertext | until redeemed, at most 2 minutes |

Rate limiting uses a salted hash of the client IP address, kept in memory only for the length of the limit window. IP addresses are not written to storage. Request logging is switched off in `wrangler.toml` (verify the platform's own logs and retention).

The relay cannot read messages: they are AES-GCM encrypted on the phone with keys only the two people hold. Pairing-code payloads are encrypted with a key derived from the six-digit code, which protects them from casual reading but not from the relay operator (a six-digit code is easy to brute force). A password-authenticated key exchange would close that gap later.

## API (JSON over HTTPS, version 1)

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /v1/mailboxes/claim` | `{ id, token }` | `200` claimed (or already yours), `409` someone else's |
| `POST /v1/mailboxes/{id}/messages` | `{ ct, ttl }` (ttl seconds, 60 to 86400) | `201 { id }` |
| `POST /v1/inbox` | `{ boxes: [{ id, token }] }` (up to 100) | `200 { messages: { [mailboxId]: [{ id, ct, created }] } }`; unclaimed boxes are claimed by the first reader |
| `POST /v1/inbox/ack` | `{ boxes: [{ id, token, messageIds: [] }] }` | `200` deletes those messages |
| `POST /v1/codes` | `{ code, ct }` (the phone picks the code) | `201 { expiresAt }`, `409` if that code is in use |
| `POST /v1/codes/redeem` | `{ code }` | `200 { ct }` once, then `404` |

Limits: request body 16 KB, ciphertext 12,000 characters, 50 waiting messages per mailbox, per-client request budgets per 10 minutes (see `src/core.ts`).

## Develop and deploy
The logic lives in `src/core.ts` and is tested with Node's built-in SQLite (`npm test` from the repository root). `src/worker.ts` adapts it to Cloudflare Workers with a SQLite-backed Durable Object.

To deploy (needs a Cloudflare account; no secrets live in this repository):
```
cd relay
npm install
npx wrangler login
npx wrangler deploy
```
Then set `VITE_RELAY_URL` for the app build to the deployed URL, and add the app's origin to `ALLOWED_ORIGINS` in `wrangler.toml`.
