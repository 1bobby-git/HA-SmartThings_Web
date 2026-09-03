# Local brand assets

This integration ships its Home Assistant brand images in:

```text
custom_components/smartthings_web/brand/
```

Included files:

- `icon.png` — 256×256 transparent PNG
- `icon@2x.png` — 512×512 transparent PNG
- `logo.png` and `logo@2x.png` — light-theme SmartThings wordmark
- `dark_logo.png` and `dark_logo@2x.png` — dark-theme SmartThings wordmark

Home Assistant 2026.3 and later serves these files through the local Brands Proxy API. The integration-local assets take precedence over legacy CDN assets.

The v0.1.161 refresh reapplies the final SmartThings icon to the integration package and provides the same design as a 128×128 transparent add-on icon. No external Brands repository is required at runtime.
