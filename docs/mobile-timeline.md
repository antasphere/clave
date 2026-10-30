# Ordered chat history

`GET /sessions/timeline?id=<session>` returns the available launch transcript and
normalized live events, oldest first. It is additive. `/sessions/history` keeps
its existing desktop behavior and numeric array-offset cursor.

The contract is `@clave/contract/timeline`. A page has `items`, `before`, `cursor`
and `truncated`. Every item has an `event`, optional `at`, and a `position` with a
nonempty `generation` and safe nonnegative integer `sequence`. The cursor names
the highest event captured when the snapshot was taken, including when reading
an older page. Sequence 0 is the empty snapshot. Event stream frames carry the
same optional `position`. Old servers and synthetic pending-request/background
replays can omit it; they provide no ordering identity.

Subscribe and wait for subscription acknowledgement before fetching the snapshot.
Buffer live events while the request is in flight. Replace the conversation from
the snapshot, then apply buffered events in its generation above its watermark,
in sequence order. Drop repeated positions, never repeated text. Reopening or
reconnecting requires a fresh snapshot even when the conversation was already
loaded. A generation different from the snapshot requires another snapshot;
sequences from different generations cannot be compared or deduplicated.

`before` is an exclusive sequence boundary within that generation. Pass it as
`before` on the next request for older events, with optional `limit` from 1 to 2000. Pages respect the existing turn/tool boundaries. `before: null` means
there is no older retained page, not that a full provider transcript is present.
Discard an older page if its generation differs from the conversation being
paged. The default page size is 200 events.

The session manager seeds the launch transcript once, before ready or write can
append to it. Events emitted during that read queue behind the historical
prefix. Events get their position before any subscriber hears them. Raw
`provider_event` payloads and terminal bytes are outside this timeline. No text
comparison, timestamp matching or content hash decides whether an event is new.

The timeline retains at most 2000 events within 1 MiB per session. `truncated`
becomes true when either bound drops events. An individual event over the byte
bound can be delivered live but absent from the next snapshot. Consumers must
show that retained history is incomplete. A stopped daemon session reads its
bounded checkpoint without starting the provider and always reports truncation,
since that checkpoint does not establish a complete provider transcript.

Generations are process-local UUIDs, per session adoption or explicit reattach.
A re-adoption under the same tab id or server restart creates a new generation.
A stopped checkpoint read gets a new process-local generation too. Positions are
not persisted, and there is no cross-generation exactly-once or recovery claim.
After explicit Resume, the provider's available launch transcript is the source
of the new generation. Missing provider history cannot be reconstructed by
matching a previous checkpoint's text. A legacy host that provides no timeline
returns `CapabilityUnavailable`; a seed failure returns `TimelineReadFailed`
without transcript content in the error.

Run the reproducible `@structure-ai/fixtures` scenario and HTTP/push checks with:

```sh
npx vitest run packages/server/src/sessions/timeline.fixtures.test.ts
```

The `sessions/timeline-repeated-messages` scenario creates a run-scoped Echo
session through `StartSession` and sends identical desktop and keyed phone
messages through `WriteSession`. The check holds a real HTTP snapshot response
while new live events arrive, reads catch-up after unsubscribe and reconnection,
and checks legacy history, route validation and authentication. Each run retains
its session id, generation, positions and receipt under
`/tmp/clave-mobile-f/timeline-fixture-*/receipt.json`. Its server and sockets close
at test end; remove only that run's directory to clean up. Echo proves protocol
ordering, not a real provider or native phone.
