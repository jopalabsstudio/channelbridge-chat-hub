# Architecture notes

## Problem

Incoming messages arrive in unrelated vendor-specific schemas. An agent should not need to understand each provider's webhook format before responding.

## Core flow

```
Telegram webhook ─┐
WhatsApp webhook ─┼──> signature/secret verification ──> normalize() ──> InboxStore
Messenger webhook ┘                                               │
                                                                  v
                                                       ChannelBridge inbox
                                                                  │
                                                            Agent reply
                                                                  │
                                                 route to original channel
                                                                  │
                                               provider acknowledgement/error
```

## Why these boundaries?

- **Providers:** isolate vendor payload parsing and outbound HTTP calls.
- **Domain:** stable `Incoming`, `Thread`, and `ChatMessage` types.
- **Store:** one place to define deduplication, ordering, and persistence.
- **Service:** the only place coordinating a reply with the provider.
- **UI:** no access to provider credentials; receives normalized records.

## Identity and isolation

A thread is identified by `[mode, channel, accountId, externalUserId]`, not by display name. Two people called Alex, or one user contacting two separate provider accounts, must never be conflated. Demo messages cannot attach to live threads.

## Reliability rules

1. Reject unsigned Meta webhooks and Telegram webhooks with a missing or incorrect shared secret.
2. Deduplicate provider event IDs before inserting messages.
3. Record outgoing attempts as `pending`, then `sent` or `failed`.
4. Do not auto-retry a failed send: provider timeouts can be ambiguous; blind retries risk duplicates.
5. Do not send free-form Meta replies outside the allowed customer messaging window.
6. Never run AI automatically on incoming messages. Human replies are explicit.

## Intentional limits

This is a single-process portfolio/MVP application, NOT a multi-tenant production helpdesk. JSON persistence is not safe for multiple server processes. Add per-user authentication and authorization, PostgreSQL, a transactional outbox, retry rules, metrics, webhook forwarding protections, retention policies, provider permission review, and rate limiting for real production use.

No ChatAware source code, schemas, proprietary orchestration, or internal tenant systems are used.
