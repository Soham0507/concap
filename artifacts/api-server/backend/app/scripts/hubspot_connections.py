"""Operator report: which organizations have connected their own HubSpot portal.

Run from the ``backend/`` directory:

    python -m app.scripts.hubspot_connections

Prints one line per org with its connection state plus a summary. Tokens are
never read or printed — only the connection state derived from the org row.
"""

from __future__ import annotations

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Organization


def _state(org: Organization) -> str:
    if org.hubspot_access_token_enc:
        return "reconnect_required" if org.hubspot_needs_reconnect else "connected"
    if org.hubspot_disabled:
        return "disconnected"
    return "not_connected"


def main() -> None:
    with SessionLocal() as db:
        orgs = db.scalars(select(Organization).order_by(Organization.id)).all()

    rows = [(org.id, org.name, _state(org), org.hubspot_portal_id) for org in orgs]

    print(f"{'ORG':>5}  {'STATE':<18}  {'PORTAL':<12}  NAME")
    print("-" * 60)
    for org_id, name, state, portal in rows:
        print(f"{org_id:>5}  {state:<18}  {str(portal or '-'):<12}  {name}")

    counts: dict[str, int] = {}
    for _, _, state, _ in rows:
        counts[state] = counts.get(state, 0) + 1

    print("-" * 60)
    print(f"total={len(rows)}  " + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))

    needs = counts.get("not_connected", 0) + counts.get("disconnected", 0) + counts.get("reconnect_required", 0)
    if needs:
        print(f"\n{needs} org(s) are not actively syncing — nudge them to connect their own HubSpot portal.")


if __name__ == "__main__":
    main()
