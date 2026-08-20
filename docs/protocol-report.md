# Protocol Report

No synthetic SmartThings protocol payloads are included. Protocol notes must come from sanitized real captures only.

Current implemented observation surfaces:

- Playwright request and response metadata.
- Playwright WebSocket open/frame/close metadata.
- Service worker lifecycle metadata.
- CDP WebSocket frames.
- CDP EventSource messages.
- Bounded XHR/fetch response body copies.

Unknown binary frames are represented by metadata rather than raw payload content.

Current bounded evidence:

- 111 requests were observed during a controlled Chrome reload sample.
- One Socket.IO WebSocket connection to `my.smartthings.com` was observed.
- 25 received and 18 sent frames were observed.
- Sent event families included authenticate, find, get, create, and subscription response shapes.
- Snapshot-shaped aggregates included 2 locations, 9 rooms, 4 scenes, 205 device-card records, 206 unique state device IDs, 1557 capability-attribute state rows, and 212 health records.
- No `api.smartthings.com` request appeared in the bounded sample.

Raw frame bodies and raw identifiers were not persisted to the repository. This evidence does not yet prove triggered live device-change semantics, dedupe, restart resume, background durability, command confirmation, or complete API independence.
