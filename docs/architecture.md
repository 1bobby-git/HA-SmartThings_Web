# Architecture

The limited-alpha system is a SmartThings Web observer and push-confirmed controller. A TypeScript bridge owns a Playwright persistent Chromium context, one observation-only keeper page at `https://my.smartthings.com/location`, short-lived separate command pages, network observers, redaction, normalized SQLite inventory, a private browser profile, and authenticated local HTTP/SSE routes. Device state comes only from SmartThings Web Socket.IO snapshots/events; DOM text and image pixels are never state sources.

The Home Assistant add-on wraps the bridge with Xvfb, Openbox, x11vnc, noVNC, nginx Ingress, and s6 supervision. The custom integration consumes the local full inventory and `/api/v1/events` stream, atomically merges inventory markers, resynchronizes on reconnect/sequence gaps, rejects stale `updatedAt` values, and exposes sensor, binary sensor, switch, light, button, number, fan, media player, scene, alarm panel, and image platforms without SmartThings polling.

Camera handling is deliberately still-image only. Signed media URLs are observed transiently, fetched only from allowlisted HTTPS SmartThings/Samsung media hosts, and discarded; the Bridge persists private image bytes and non-secret metadata, then serves them through its authenticated local image route.
