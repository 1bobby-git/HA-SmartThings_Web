# Session Behavior

Session restore has not been validated with a real Samsung account. The Phase 1 runtime keeps a headed Chromium profile under `/data/chromium-profile` and does not assume cookies restore login after browser restart.

Manual testing must record logout, restart, and host reboot behavior before any compatibility claim.

The SmartThings Web setting text says login is maintained while the web page remains open and may end when the browser closes. Phase 1 therefore treats the live Chromium process and keeper tab as runtime requirements rather than assuming persisted cookies are sufficient.

Current evidence verifies only that a controlled Chrome session reached the SmartThings location page after manual Samsung login and produced a bounded reload sample. Keep-login durability, browser restart restore, host reboot restore, long idle behavior, and background delivery remain unverified.
