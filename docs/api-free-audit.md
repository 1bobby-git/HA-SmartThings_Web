# API-Free Audit

Local static checks currently prohibit SmartThings API dependencies and direct source references to `api.smartthings.com`, PAT, OAuth, SmartApp, installedAppId, subscription creation, and webhook code.

Runtime traffic separation still requires real add-on execution and outbound observation. Browser-owned SmartThings Web traffic must be classified separately from bridge-owned traffic.
