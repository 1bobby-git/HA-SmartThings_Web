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
