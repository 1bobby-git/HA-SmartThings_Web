# SmartThings Web Bridge

Open the add-on Ingress panel, use the noVNC browser view, and sign in to Samsung manually. The bridge keeps `https://my.smartthings.com/location` open and records only sanitized network metadata for feasibility review.

This Phase 1 build does not create Home Assistant entities and does not control devices.

AppArmor runtime enforcement has not been validated on a live Home Assistant Supervisor install. The bundled profile is a minimal static policy for the headed Chromium bridge paths, but live Supervisor enforcement still needs runtime validation on target hardware.

Before Phase 2, collect sanitized evidence for login completion, keep-login behavior, location-only push events, background delivery, network outage recovery, add-on restart, Home Assistant Core restart, and redaction. If the protocol evidence remains unavailable, keep the gate at STOP.
