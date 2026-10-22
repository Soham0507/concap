"""AI "quick research" for scanned contacts.

Given a person and/or a company, produce a succinct company summary, a short
list of competitors, a brief on the person, and a best-effort LinkedIn URL —
using OpenAI's hosted ``web_search`` tool (Responses API) so the work happens
*inside the deployed backend*, not in any agent tooling.

Design notes
------------
- The agent's own webSearch/webFetch tools are NOT available at runtime, so we
  rely on OpenAI's hosted web_search tool with the existing OPENAI_API_KEY.
- LinkedIn pages can't be scraped, but web_search results surface the profile
  URL, which is all we store. The field stays user-editable.
- Every public function degrades gracefully: on any failure it returns a dict
  with empty fields and an ``error`` string. It NEVER raises, so a scan/contact
  is never broken by a flaky research call.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any


from ..config import get_settings

logger = logging.getLogger("booth.research")

# Web search + an LLM round-trip is slower than a plain completion; give it
# room but stay bounded so a hung call can't pin a request open forever.
_TIMEOUT = 60.0

# Kept in sync with frontend/industries.js so the model prefers a label the
# Industry dropdown already knows (otherwise it falls into the "Other" bucket).
_INDUSTRY_OPTIONS = [
    "Information Technology", "Software / SaaS", "Manufacturing", "Healthcare",
    "Pharmaceuticals", "Finance & Banking", "Insurance", "Retail", "E-commerce",
    "Education", "Real Estate", "Construction", "Hospitality", "Food & Beverage",
    "Logistics & Transportation", "Automotive", "Energy & Utilities",
    "Agriculture", "Media & Entertainment", "Marketing & Advertising",
    "Consulting", "Legal", "Government", "Non-profit", "Telecommunications",
]

_COMPANY_PROMPT = (
    "Research the company below using web search and return ONLY a JSON object "
    "with EXACTLY these keys: summary, competitors, industry, website.\n"
    "- summary: 2-4 sentences on what the company does, its market, and size if "
    "known. Plain text, no markdown.\n"
    "- competitors: an array (max 6) of objects {{\"name\": str, \"note\": str}} "
    "where note is a short reason they compete. Empty array if you can't find "
    "any.\n"
    "- industry: the company's primary industry. Pick the SINGLE best-fit label "
    "from this list when one applies: " + ", ".join(_INDUSTRY_OPTIONS) + ". If "
    "none fits, give a short custom label (1-3 words). Empty string if unknown.\n"
    "- website: the company's official homepage URL (start with https://). Empty "
    "string if you are not confident — do NOT guess.\n"
    "If the company can't be identified, use empty values. "
    "Output ONLY the JSON object.\n\n"
    "Company: {name}\n"
    "Website hint (may be blank or wrong): {website}"
)

_PERSON_PROMPT = (
    "You are researching a specific professional to find their personal LinkedIn "
    "profile and current employer. Use web search aggressively before you answer "
    "— run SEVERAL queries, don't stop after one.\n"
    "Search strategy: combine the person's name with their company, job title and "
    "email domain, e.g. '\"<name>\" <company> linkedin', '<name> <title> linkedin', "
    "and 'site:linkedin.com/in <name> <company>'. The email domain is a strong "
    "signal of the real employer (e.g. jane@acme.com → Acme).\n"
    "Return ONLY a JSON object with EXACTLY these keys: linkedin_url, "
    "current_company, summary.\n"
    "- linkedin_url: the full URL of THIS person's PERSONAL LinkedIn profile "
    "(a 'https://www.linkedin.com/in/...' URL — never a company page). Accept a "
    "profile when the name matches AND at least one of company, job title, "
    "location, or email domain is consistent with it. Prefer returning a "
    "confident match over an empty answer. Only return an empty string when the "
    "name is genuinely ambiguous (several different people) and nothing lets you "
    "tell them apart — never invent or guess a random profile.\n"
    "- current_company: the name of the person's CURRENT employer based on "
    "their LinkedIn / verified web presence (the organisation in their current "
    "role). Use the full organisation name. The 'Company' hint below was read "
    "off a scanned business card and may be misspelled, outdated or wrong, so "
    "trust the LinkedIn profile and email domain over it. Empty string only if "
    "you genuinely cannot confirm it — do NOT guess.\n"
    "- summary: 2-3 sentences about their professional background / role. Plain "
    "text, no markdown. Empty string if nothing reliable is found.\n"
    "Output ONLY the JSON object.\n\n"
    "Name: {name}\n"
    "Company (from a scanned card — may be misspelled, outdated or wrong): {company}\n"
    "Title: {designation}\n"
    "Email: {email}"
)


def research_available() -> bool:
    return bool(get_settings().openai_api_key)


def _extract_json(text: str) -> dict[str, Any]:
    """Pull the first JSON *object* out of a model response, tolerating code
    fences or stray prose around it. Always returns a dict — if the model
    returns a non-object (array/string/number) or nothing parseable, returns
    {} so callers can safely use ``.get(...)`` without ever raising."""
    if not text:
        return {}
    text = text.strip()
    # Strip ```json ... ``` fences if present.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {}
    return {}


def _web_search_json(prompt: str) -> tuple[dict[str, Any], list[str], str | None]:
    """Run one web_search-enabled Responses call and return (parsed_json,
    source_urls, error). On any failure, error is a human-readable string and
    the other two are empty."""
    settings = get_settings()
    if not settings.openai_api_key:
        return {}, [], "Research is not configured (no OPENAI_API_KEY)."
    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key, timeout=_TIMEOUT)
    resp = None
    last_exc: Exception | None = None
    # web_search is GA in recent SDKs; older deployments expose it as
    # web_search_preview. Try the GA name first, then fall back.
    for tool_type in ("web_search", "web_search_preview"):
        try:
            resp = client.responses.create(
                model=settings.research_model,
                tools=[{"type": tool_type}],
                input=prompt,
            )
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            continue
    if resp is None:
        logger.warning("Research web_search call failed: %s", last_exc)
        return {}, [], f"Web search failed: {last_exc}"

    text = getattr(resp, "output_text", "") or ""
    return _extract_json(text), _collect_sources(resp), None


def _collect_sources(resp: Any) -> list[str]:
    """Best-effort scrape of citation URLs from the response object so the UI
    can show where the research came from. Never raises."""
    urls: list[str] = []
    try:
        for item in getattr(resp, "output", []) or []:
            for content in getattr(item, "content", []) or []:
                for ann in getattr(content, "annotations", []) or []:
                    url = getattr(ann, "url", None)
                    if url and url not in urls:
                        urls.append(url)
    except Exception:  # noqa: BLE001
        pass
    return urls[:8]


def research_company(name: str, website: str | None = None) -> dict[str, Any]:
    """Return {summary, competitors: [{name, note}], industry, website,
    sources, error?}."""
    name = (name or "").strip()
    if not name:
        return {"summary": "", "competitors": [], "industry": "", "website": "", "sources": []}
    try:
        data, sources, error = _web_search_json(
            _COMPANY_PROMPT.format(name=name, website=(website or "—"))
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("research_company failed for %r: %s", name, exc)
        return {"summary": "", "competitors": [], "industry": "", "website": "", "sources": [], "error": str(exc)}

    if error:
        return {"summary": "", "competitors": [], "industry": "", "website": "", "sources": sources, "error": error}

    industry = data.get("industry")
    industry = industry.strip() if isinstance(industry, str) else ""
    research_website = data.get("website")
    research_website = research_website.strip() if isinstance(research_website, str) else ""
    if research_website and not research_website.lower().startswith("http"):
        research_website = "https://" + research_website.lstrip("/")
    summary = data.get("summary")
    summary = summary.strip() if isinstance(summary, str) else ""
    competitors_raw = data.get("competitors")
    competitors: list[dict[str, str]] = []
    if isinstance(competitors_raw, list):
        for c in competitors_raw[:6]:
            if isinstance(c, dict) and (c.get("name") or "").strip():
                competitors.append({
                    "name": str(c["name"]).strip(),
                    "note": str(c.get("note") or "").strip(),
                })
            elif isinstance(c, str) and c.strip():
                competitors.append({"name": c.strip(), "note": ""})
    return {
        "summary": summary,
        "competitors": competitors,
        "industry": industry,
        "website": research_website,
        "sources": sources,
    }


def research_person(
    name: str,
    company: str | None = None,
    email: str | None = None,
    designation: str | None = None,
) -> dict[str, Any]:
    """Return {linkedin_url, current_company, summary, sources, error?}."""
    name = (name or "").strip()
    if not name:
        return {"linkedin_url": "", "current_company": "", "summary": "", "sources": []}
    try:
        data, sources, error = _web_search_json(
            _PERSON_PROMPT.format(
                name=name,
                company=(company or "—"),
                designation=(designation or "—"),
                email=(email or "—"),
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("research_person failed for %r: %s", name, exc)
        return {"linkedin_url": "", "current_company": "", "summary": "", "sources": [], "error": str(exc)}

    if error:
        return {"linkedin_url": "", "current_company": "", "summary": "", "sources": sources, "error": error}

    linkedin = data.get("linkedin_url")
    linkedin = linkedin.strip() if isinstance(linkedin, str) else ""
    if linkedin and "linkedin.com" not in linkedin.lower():
        # The model occasionally returns a non-LinkedIn URL; drop it.
        linkedin = ""
    if linkedin and not linkedin.lower().startswith("http"):
        linkedin = "https://" + linkedin.lstrip("/")
    current_company = data.get("current_company")
    current_company = current_company.strip() if isinstance(current_company, str) else ""
    summary = data.get("summary")
    summary = summary.strip() if isinstance(summary, str) else ""
    return {
        "linkedin_url": linkedin,
        "current_company": current_company,
        "summary": summary,
        "sources": sources,
    }
