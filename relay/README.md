# Pebble relay

A small message relay so two phones can reach each other when they are not side by side. It has no accounts and stores no profiles. It only ever holds:

| What | Contents | How long |
| --- | --- | --- |
| Mailbox | random 128-bit ID, SHA-256 hash of the owner's read token, last-used time | deleted after 45 days unused |
| Message | mailbox ID, opaque ciphertext (encrypted on the phone), created and expiry times | until read and acknowledged, at most 24 hours |
| Pairing code | six-digit code, opaque ciphertext (emptied when redeemed; the code stays reserved) | at most 2 minutes |

Rate limiting uses a salted hash of the client IP address, made inside the relay's single Durable Object with a random salt held only in memory, and kept only for the length of the limit window. IP addresses are not written to storage. Request logging (Workers Logs) is switched off in `wrangler.toml`. Cloudflare, as the host, still processes IP addresses to deliver requests and keeps its own logs for a limited time under its privacy policy; it does not publish a fixed period.

The relay cannot read messages: they are AES-GCM encrypted on the phone with keys from an ECDH (P-256) exchange, so only the two phones hold them. Every code a phone shows carries a fresh public key; the private key never leaves the phone. Requests are sealed to the key in the code they answer, so neither the relay nor anyone who saw that code can open them.

Six-digit codes are the weak spot. The payload behind a code is encrypted with a key derived from the code, which keeps it from casual reading but not from whoever runs the relay (six digits are easy to brute force). That payload is the same public information a QR code shows, but someone running the relay could swap in their own key and stand in the middle of that one request. A password-authenticated key exchange would close that gap later. QR codes and links don't have this problem.

## API (JSON over HTTPS, version 1)

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /v1/mailboxes/claim` | `{ id, token }` | `200` claimed (or already yours), `409` if the ID wasn't made from this token |
| `POST /v1/mailboxes/{id}/messages` | `{ ct, ttl }` (ttl seconds, 60 to 86400) | `201 { id }`; `404` if nobody has claimed that mailbox |
| `POST /v1/inbox` | `{ boxes: [{ id, token }] }` (up to 100) | `200 { messages: { [mailboxId]: [{ id, ct, created }] }, more? }` (at most 512 KB per reply; `more` means ack and ask again); an unclaimed box is claimed on first read, by its own token only |
| `POST /v1/inbox/ack` | `{ boxes: [{ id, token, messageIds: [] }] }` | `200` deletes those messages |
| `POST /v1/codes` | `{ code, ct }` (the phone picks the code) | `201 { expiresAt }`, `409` if that code is in use |
| `POST /v1/codes/redeem` | `{ code }` | `200 { ct }` once, then `404`; the code can't be created again until it would have expired |

A mailbox ID is the first 128 bits of SHA-256(`pebble-box-v1:` + token), base64url. IDs appear in QR codes and links, so this is what stops someone who saw an ID from claiming the mailbox first.

Limits: request body 16 KB (read with a cap, whatever Content-Length says), ciphertext 12,000 characters, 50 waiting messages per mailbox, 60 sends per mailbox per 10 minutes from all senders together, and per-client budgets per 10 minutes sized for a venue behind one shared address. A client is one IPv4 address or one IPv6 /64. Failed code redeems also share one budget across all clients, which caps online guessing (see `src/core.ts`).

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
