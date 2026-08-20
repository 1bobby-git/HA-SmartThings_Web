# SmartThings Web Bridge Add-on

Phase 1 add-on skeleton for a headed Chromium SmartThings Web inspector.

The add-on uses Home Assistant Ingress on port `8099`, keeps VNC/noVNC bound inside the container, and exposes `/health/live` for the Supervisor watchdog.
