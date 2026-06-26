"""Google Maps link → GPX waypoint — a standalone utility router.

Unrelated to the bridge's folder store: this owns no files, storage, or
versioning. It just turns a Google Maps link (or the share text Google produces)
into a one-`<wpt>` GPX document. Ported from
github.com/bramveen1/garmin-nav-exporter/blob/main/api/convert.js and mounted by
``main.py`` via ``app.include_router``.
"""

from __future__ import annotations

import html
import re
import urllib.parse
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class ConvertBody(BaseModel):
    input: str = Field(
        description=(
            "A Google Maps link, or the whole 'share' text Google produces (a "
            "label followed by a link). Both a full URL with coordinates and a "
            "short `maps.app.goo.gl/…` link are accepted."
        )
    )


class ConvertResult(BaseModel):
    lat: float = Field(description="Resolved latitude.")
    lng: float = Field(description="Resolved longitude.")
    name: str | None = Field(default=None, description="Place name parsed from the link, or null.")
    source: str | None = Field(default=None, description="The (resolved) source URL the coords came from.")
    gpx: str = Field(description="A standalone GPX document with a single `<wpt>` for the place.")


# --------------------------------------------------------------------------- #
# Coordinates live in a Google Maps URL in one of three shapes, tried in order:
#   @lat,lng      — the map viewport center (also carries a trailing zoom token)
#   !3d…!4d…       — the pin's exact lat/lng inside the URL's encoded place data
#   ?q=lat,lng     — an explicit query point
# A "share" short link (maps.app.goo.gl) carries *none* of these; it 302s to the
# real URL, so we must follow the redirect server-side (a browser can't — the
# redirect is opaque cross-origin). Place-share URLs sometimes still lack coords
# in the final URL, so we also scrape them from the fetched page body, and fall
# back to geocoding a `q=<address>`.
# --------------------------------------------------------------------------- #
_AT = re.compile(r"@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,\d+(?:\.\d+)?[zmt])?")
_BANG = re.compile(r"!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)")
_Q = re.compile(r"[?&]q=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)")
# A bare "share this place" pin resolves to /maps/search/<lat>,<lng> (the comma
# is often followed by a URL-encoded space, i.e. '+'). Require a decimal point so
# this doesn't grab unrelated integer pairs. (Not in convert.js.)
_SEARCH = re.compile(r"/(?:search|dir|place)/(-?\d{1,3}\.\d+),[\s+]*(-?\d{1,3}\.\d+)")
# Pull the first http(s) URL out of pasted share text (Google prefixes the link
# with a human label). Stop at whitespace — URLs don't contain unescaped spaces.
_URL_IN_TEXT = re.compile(r"https?://\S+")
# Place name from a /place/<Name>/ path segment (decoded, '+' → space below).
_PLACE = re.compile(r"/place/([^/@]+)")

# Maps serves a stripped-down page (with coords in the bootstrap) to mobile UAs.
_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"


def _valid_coord(lat: float, lng: float) -> bool:
    return -90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0


def _parse_lat_lng(text: str) -> tuple[float, float] | None:
    # Pin (!3d!4d) before viewport center (@lat,lng) before /search/ and ?q=: we
    # want the exact place, not the map center. (convert.js tries @ first because
    # its route hack doesn't need pin precision; a POI waypoint does.)
    for rx in (_BANG, _AT, _SEARCH, _Q):
        m = rx.search(text)
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if _valid_coord(lat, lng):
                return lat, lng
    return None


def _parse_name(url: str) -> str | None:
    m = _PLACE.search(url)
    if not m:
        return None
    name = urllib.parse.unquote_plus(m.group(1)).strip()
    return name or None


def _resolve(url: str) -> tuple[str, str]:
    """Follow redirects (mobile UA) → (final_url, response_body).

    The body is returned so the caller can scrape coords from it without a second
    fetch. Network/HTTP failures are translated into a clean 502 rather than a 500.
    """
    try:
        with httpx.Client(follow_redirects=True, timeout=10.0) as client:
            res = client.get(url, headers={"User-Agent": _MOBILE_UA})
            res.raise_for_status()
            return str(res.url), res.text
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"couldn't reach Google Maps to resolve the link: {exc}")


def _geocode(query: str) -> tuple[float, float] | None:
    """Best-effort Nominatim lookup for a `q=<address>` that isn't coordinates.

    Mirrors convert.js's progressive simplification: try the whole query, then
    drop the leading business-name segment, then the trailing postcode, so a
    "Cafe, 123 Main St, 90210" style address still resolves to its street.
    """
    candidates = [query]
    parts = [p.strip() for p in query.split(",") if p.strip()]
    if len(parts) > 1:
        candidates.append(", ".join(parts[1:]))  # drop business name
        candidates.append(", ".join(parts[1:-1]) or parts[1])  # drop postcode too
    for cand in candidates:
        try:
            with httpx.Client(timeout=10.0) as client:
                res = client.get(
                    "https://nominatim.openstreetmap.org/search",
                    params={"q": cand, "format": "json", "limit": 1},
                    headers={"User-Agent": "gpx.studio-bridge/0.1 (POC)"},
                )
                res.raise_for_status()
                hits = res.json()
        except (httpx.HTTPError, ValueError):
            continue
        if hits:
            lat, lng = float(hits[0]["lat"]), float(hits[0]["lon"])
            if _valid_coord(lat, lng):
                return lat, lng
    return None


def _build_wpt(lat: float, lng: float, name: str | None, source: str | None) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    wpt_name = html.escape(name.strip()) if name and name.strip() else "Google Maps Pin"
    link = f'\n    <link href="{html.escape(source)}"><text>Source</text></link>' if source else ""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="gpx.studio-bridge" '
        'xmlns="http://www.topografix.com/GPX/1/1" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 '
        'http://www.topografix.com/GPX/1/1/gpx.xsd">\n'
        f"  <metadata>\n    <name>{wpt_name}</name>\n    <time>{ts}</time>\n  </metadata>\n"
        f'  <wpt lat="{lat:.6f}" lon="{lng:.6f}">\n'
        f"    <name>{wpt_name}</name>{link}\n"
        "  </wpt>\n"
        "</gpx>\n"
    )


@router.post("/convert", response_model=ConvertResult)
def convert(body: ConvertBody) -> ConvertResult:
    """Turn a Google Maps link (or share text) into a single-waypoint GPX.

    Extracts the maps URL from ``input``, reads the coordinates from the URL
    (``@lat,lng`` / ``!3d!4d`` / ``?q=``), and if the link is a short share link
    or a place page without inline coords, **follows the redirect server-side**
    and scrapes the resolved page, then falls back to geocoding a ``q=<address>``.
    Returns ``{lat, lng, name, source, gpx}`` where ``gpx`` is a standalone
    document holding one ``<wpt>``. **400** if no URL is found, **422** if no
    coordinates can be resolved.
    """
    m = _URL_IN_TEXT.search(body.input or "")
    url = m.group(0) if m else (body.input or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "no Google Maps link found in the input")

    source = url
    name = _parse_name(url)

    coords = _parse_lat_lng(url)
    if coords is None:
        # Short link / coordless place page → resolve and scrape the real page.
        resolved, body_text = _resolve(url)
        # Google bounces server/EU IPs through consent.google.com, which keeps the
        # real destination in its `continue=` param — unwrap it so the coord regexes
        # (and the reported source) see the actual maps URL, not the consent page.
        cont = urllib.parse.parse_qs(urllib.parse.urlparse(resolved).query).get("continue")
        source = cont[0] if cont and "consent.google" in resolved else resolved
        name = name or _parse_name(source)
        coords = _parse_lat_lng(source) or _parse_lat_lng(body_text)
    if coords is None:
        # Last resort: geocode an address-style ?q= parameter.
        q = urllib.parse.parse_qs(urllib.parse.urlparse(source).query).get("q", [None])[0]
        if q:
            coords = _geocode(q)
            name = name or q.split(",")[0].strip()
    if coords is None:
        raise HTTPException(422, "couldn't find coordinates in that link")

    lat, lng = coords
    return ConvertResult(lat=lat, lng=lng, name=name, source=source, gpx=_build_wpt(lat, lng, name, source))
