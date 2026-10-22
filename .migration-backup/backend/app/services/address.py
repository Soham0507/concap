"""Best-effort parsing of a single combined address line into city / state /
country.

Business cards print one free-text address ("M403, Mega Center, Hadapsar,
Pune - 411028"), but the Company record stores city / state / country
separately. This module splits the line so those columns get populated when a
card is scanned.

It is deterministic and India-aware (the product's primary market — GST,
+91 phones, 6-digit PIN codes): the city is the token printed before the PIN
code, the state is read from an explicit state name or inferred from the PIN
code's postal circle, and the country is "India" whenever a valid PIN code (or
the literal word) appears. Anything it can't determine is returned as ``None``
so callers never overwrite good data with a guess.
"""
from __future__ import annotations

import re

# Indian states + union territories, for explicit name detection in the line.
_INDIAN_STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
    "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
    "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
    "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim",
    "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
    "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
    "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir",
    "Ladakh", "Lakshadweep", "Puducherry",
]
_STATE_LOOKUP = {s.lower(): s for s in _INDIAN_STATES}

# First two digits of an Indian PIN code → state (postal circle). Best-effort:
# a few circles span more than one state at the district level, so this is a
# fallback used only when no state name is printed on the card.
_PIN2_STATE = {
    "11": "Delhi",
    "12": "Haryana", "13": "Haryana",
    "14": "Punjab", "15": "Punjab", "16": "Punjab",
    "17": "Himachal Pradesh",
    "18": "Jammu and Kashmir", "19": "Jammu and Kashmir",
    "20": "Uttar Pradesh", "21": "Uttar Pradesh", "22": "Uttar Pradesh",
    "23": "Uttar Pradesh", "24": "Uttar Pradesh", "25": "Uttar Pradesh",
    "26": "Uttar Pradesh", "27": "Uttar Pradesh", "28": "Uttar Pradesh",
    "30": "Rajasthan", "31": "Rajasthan", "32": "Rajasthan", "33": "Rajasthan",
    "34": "Rajasthan",
    "36": "Gujarat", "37": "Gujarat", "38": "Gujarat", "39": "Gujarat",
    "40": "Maharashtra", "41": "Maharashtra", "42": "Maharashtra",
    "43": "Maharashtra", "44": "Maharashtra",
    "45": "Madhya Pradesh", "46": "Madhya Pradesh", "47": "Madhya Pradesh",
    "48": "Madhya Pradesh",
    "49": "Chhattisgarh",
    "50": "Telangana", "51": "Andhra Pradesh", "52": "Andhra Pradesh",
    "53": "Andhra Pradesh",
    "56": "Karnataka", "57": "Karnataka", "58": "Karnataka", "59": "Karnataka",
    "60": "Tamil Nadu", "61": "Tamil Nadu", "62": "Tamil Nadu",
    "63": "Tamil Nadu", "64": "Tamil Nadu",
    "67": "Kerala", "68": "Kerala", "69": "Kerala",
    "70": "West Bengal", "71": "West Bengal", "72": "West Bengal",
    "73": "West Bengal", "74": "West Bengal",
    "75": "Odisha", "76": "Odisha", "77": "Odisha",
    "78": "Assam", "79": "Arunachal Pradesh",
    "80": "Bihar", "81": "Bihar", "82": "Bihar", "83": "Bihar", "84": "Bihar",
    "85": "Jharkhand",
}

# A 6-digit Indian PIN, optionally written as "411 028".
_PIN_RE = re.compile(r"\b(\d{3})\s?(\d{3})\b")


def parse_address(address: str | None) -> tuple[str | None, str | None, str | None]:
    """Return ``(city, state, country)`` parsed from a combined address line.

    Any component that can't be confidently determined is ``None``.
    """
    if not address or not address.strip():
        return None, None, None
    text = address.strip()
    low = text.lower()

    pin_match = _PIN_RE.search(text)
    pin = (pin_match.group(1) + pin_match.group(2)) if pin_match else None

    # State: prefer an explicitly printed name, else infer from the PIN circle.
    state: str | None = None
    for name_lower, name in _STATE_LOOKUP.items():
        if re.search(rf"\b{re.escape(name_lower)}\b", low):
            state = name
            break
    if state is None and pin:
        state = _PIN2_STATE.get(pin[:2])

    # Country: India whenever a valid PIN or the word itself is present.
    country = "India" if (pin or re.search(r"\bindia\b", low)) else None

    # City: strictly PIN-anchored to avoid guessing. We only accept the token
    # the PIN is printed on (with the digits stripped) or, failing that, the
    # single token immediately before it. Anything else — and any address with
    # no PIN at all — yields no city rather than a wrong one.
    city: str | None = None
    if pin_match:
        parts = [p.strip() for p in re.split(r"[,\n]", text) if p.strip()]
        for i, part in enumerate(parts):
            if not _PIN_RE.search(part):
                continue
            candidate = _PIN_RE.sub("", part).strip(" -–—,")
            if _is_place_token(candidate):
                city = candidate
            elif i > 0 and _is_place_token(parts[i - 1].strip(" -–—,")):
                city = parts[i - 1].strip(" -–—,")
            break

    return city, state, country


def _is_place_token(token: str) -> bool:
    """True when a token looks like a real place name — not a state, the
    country, a bare/empty fragment, or something containing a PIN code."""
    t = (token or "").strip()
    if not t or _PIN_RE.search(t):
        return False
    tl = t.lower()
    if tl in _STATE_LOOKUP or tl == "india":
        return False
    return any(ch.isalpha() for ch in t)
