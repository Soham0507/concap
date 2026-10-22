---
name: Artifact command working directory
description: Development commands run from the artifact directory, not the workspace root.
---

Artifact development commands start in the artifact's own directory. Use local
paths or workspace-aware package commands, not workspace-root-relative paths.

**Why:** During the Concap port, both Python services failed before startup
because their development commands repeated the artifact directory prefix.
The files existed, but the command's working directory was already that directory.

**How to apply:** When adapting a non-Node service to an artifact, make its
launcher resolve the workspace root from its own location and configure the
development command relative to the artifact directory.
