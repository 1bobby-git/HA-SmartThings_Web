# Architecture

Phase 1 is a read-only SmartThings Web inspector. A TypeScript bridge owns a Playwright persistent Chromium context, one keeper page at `https://my.smartthings.com/location`, optional interactive pages, read-only network observers, redaction, SQLite persistence, and HTTP health/status routes.

The Home Assistant add-on wraps the bridge with Xvfb, Openbox, x11vnc, noVNC, nginx Ingress, and s6 supervision. The custom Home Assistant integration and entity platforms are intentionally deferred.
