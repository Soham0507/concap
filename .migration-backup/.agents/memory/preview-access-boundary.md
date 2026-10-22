---
name: Preview access boundary
description: Security scope and rationale for password-free preview access.
---

Preview access must use a separate workspace rather than impersonating an existing user or opening their organization’s data. It must not grant access to the published app.

**Why:** The user explicitly requested a login bypass for preview mode only. A preview convenience should not expose existing account data or weaken production authentication.

**How to apply:** Preserve this boundary when extending preview access, changing authentication, or altering launch configuration. Preview credentials must not become valid production credentials.
