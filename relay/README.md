# Pebble relay

A small message relay so two phones can reach each other when they are not side by side. It has no accounts and stores no profiles. It is built for a venue of thousands: every device has its own small relay object (its "home"), so there is no single bottleneck, and a sync is one request to one object.

It only ever holds:

| What | Where | Contents | How long |
| --- | --- | --- | --- |
| Mailbox | the device's home | a random 128-bit mailbox ID | until the device stops listing it (a removed connection, an expired code), or 45 days unused |
| Message | the device's home | mailbox ID, opaque ciphertext (encrypted on the phone), created and expiry times | until acknowledged, at most 24 hours |
| Last used | the device's home | one timestamp, refreshed at most once a day | the home is deleted entirely after 45 days unused |
| Pairing code | one of 10 code shards | six-digit code, opaque ciphertext (emptied when redeemed; the code stays reserved) | at most 2 minutes |

A home's ID is the first 128 bits of SHA-256(`pebble-home-v1:` + the device's secret home token), base64url. The relay checks ownership by hashing the token; it never stores it. A mailbox address is `<home ID>.<mailbox ID>`: codes and messages carry addresses, never the token.

The relay can see which mailboxes belong to one device (they live in its home, and the device asks for them together). It can't read anything in them.

Rate limits are per device (inside its home) and per target mailbox, so a whole venue sharing a few Wi-Fi addresses is fine. Six-digit code limits are per shard. The only per-address limit is a high flood ceiling at the edge, kept in memory per worker isolate. IP addresses are not written to storage; code shards key their limits on a salted hash held in memory only. Request logging (Workers Logs) is switched off in `wrangler.toml`. Cloudflare, as the host, still processes IP addresses to deliver requests and keeps its own logs for a limited time under its privacy policy; it does not publish a fixed period.

The relay cannot read messages: they are AES-GCM encrypted on the phone with keys from an ECDH (P-256) exchange, so only the two phones hold them. Every code a phone shows carries a fresh public key; the private key never leaves the phone. Requests are sealed to the key in the code they answer, so neither the relay nor anyone who saw that code can open them.

Six-digit codes are the weak spot. The payload behind a code is encrypted with a key derived from the code, which keeps it from casual reading but not from whoever runs the relay (six digits are easy to brute force). That payload is the same public information a QR code shows, but someone running the relay could swap in their own key and stand in the middle of that one request. A password-authenticated key exchange would close that gap later. QR codes and links don't have this problem.

## API (JSON over HTTPS, version 2)

Requests are sent as `text/plain` (a CORS "simple" request: no preflight); the body is JSON.

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /v2/homes/{home}/sync` | `{ token, add?, keep?, ack? }` | `200 { messages: { [mailboxId]: [{ id, ct, created }] }, more? }`. `add` registers mailboxes; `keep`, if given, is the full list still in use (others are dropped with their mail); `ack` deletes handled messages before fetching. At most 512 KB per reply, shared fairly between mailboxes; `more` means sync again. `403` if the token doesn't own the home. |
| `POST /v2/homes/{home}/boxes/{box}/messages` | `{ ct, ttl }` (ttl seconds, 60 to 86400) | `201 { id }`; `404` if that mailbox isn't registered; `429` if the mailbox or home is full or flooded |
| `POST /v2/codes` | `{ code, ct }` (the phone picks the code) | `201 { expiresAt }`, `409` if that code is in use |
| `POST /v2/codes/redeem` | `{ code }` | `200 { ct }` once, then `404`; the code can't be created again until it would have expired |

Limits (see `src/core.ts`): request body 16 KB (read with a cap, whatever Content-Length says), ciphertext 12,000 characters, 50 waiting messages per mailbox and 1,000 per home, 60 sends per mailbox and 600 per home per 10 minutes from all senders together, 300 syncs per device per 10 minutes, 300 code creations and redeems per client address per 10 minutes, 2,000 failed redeems per code shard per 10 minutes.

Each object wakes only when something needs cleaning up (its next expiry, or the 45-day idle clean-up), so an idle relay costs nothing; an empty home deletes itself.

## Develop and deploy
The logic lives in `src/core.ts` (`HomeCore`, `CodesCore`) and is tested with Node's built-in SQLite (`npm test` from the repository root). `src/worker.ts` adapts it to Cloudflare Workers with SQLite-backed Durable Objects (`HomeObject`, `CodesObject`). `src/dev-server.ts` runs the same logic locally on port 8787.

To deploy (needs a Cloudflare account; no secrets live in this repository):
```
cd relay
npm install
npx wrangler login
npx wrangler deploy
```
Then set `VITE_RELAY_URL` for the app build to the deployed URL, and add the app's origin to `ALLOWED_ORIGINS` in `wrangler.toml`. The `v2` migration in `wrangler.toml` replaces the old single relay object (its data is dropped).

For a large event, use the paid Workers plan for that month (the free plan's daily request allowance won't cover thousands of phones; figures to verify).
