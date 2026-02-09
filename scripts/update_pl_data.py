#!/usr/bin/env python3
"""Build Premier League spend dataset from free web sources.

Sources:
- Capology PL payrolls page (club annual wage bills)
- Capology club salary pages (published signed/expiration for contract terms)
- Transfermarkt-derived open CSV mirror (player-level in/out transfer fees)
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import difflib
import json
import math
import re
import subprocess
import time
import unicodedata
from pathlib import Path
from typing import Dict, List, Optional

PAYROLL_URL = "https://www.capology.com/uk/premier-league/payrolls/"
CLUB_SALARIES_URL = "https://www.capology.com/club/{slug}/salaries/"
TRANSFERS_URL = "https://raw.githubusercontent.com/eordo/transfermarkt-data/master/premier_league/{season}.csv"

PL_LEAGUE = "Premier League"
SEASON_LABEL = "2025/26"

CLUB_ALIASES = {
    "afc bournemouth": "Bournemouth",
    "arsenal fc": "Arsenal",
    "aston villa": "Aston Villa",
    "brentford fc": "Brentford",
    "brighton hove albion": "Brighton",
    "burnley fc": "Burnley",
    "chelsea fc": "Chelsea",
    "crystal palace": "Crystal Palace",
    "everton fc": "Everton",
    "fulham fc": "Fulham",
    "leeds united": "Leeds",
    "liverpool fc": "Liverpool",
    "manchester city": "Manchester City",
    "manchester united": "Manchester United",
    "newcastle united": "Newcastle",
    "nottingham forest": "Nottingham Forest",
    "sunderland afc": "Sunderland",
    "tottenham hotspur": "Tottenham",
    "west ham united": "West Ham",
    "wolverhampton wanderers": "Wolverhampton",
}


def fetch_text(url: str) -> str:
    cmd = [
        "curl",
        "-L",
        "--http1.1",
        "--fail",
        "--silent",
        "--show-error",
        "--retry",
        "3",
        "--retry-all-errors",
        "--retry-delay",
        "1",
        "-A",
        (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        ),
        url,
    ]
    errors: List[str] = []
    for _ in range(3):
        completed = subprocess.run(cmd, capture_output=True, text=True)
        if completed.returncode == 0:
            return completed.stdout
        errors.append(completed.stderr.strip() or f"curl exit code {completed.returncode}")
        time.sleep(1)
    raise RuntimeError(f"Unable to fetch {url}: {' | '.join(errors)}")


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    normalized = normalized.lower()
    normalized = normalized.replace("&", " and ")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def extract_js_array_objects(page: str, marker: str = "var data = [") -> List[str]:
    start_idx = page.find(marker)
    if start_idx == -1:
        return []
    arr_start = page.find("[", start_idx)
    if arr_start == -1:
        return []

    depth = 0
    in_string = False
    quote_char = ""
    escaped = False
    arr_end = -1

    for i in range(arr_start, len(page)):
        ch = page[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote_char:
                in_string = False
            continue

        if ch in ('"', "'"):
            in_string = True
            quote_char = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                arr_end = i
                break

    if arr_end == -1:
        return []

    block = page[arr_start + 1 : arr_end]
    return split_top_level_objects(block)


def split_top_level_objects(block: str) -> List[str]:
    objects: List[str] = []
    depth = 0
    in_string = False
    quote_char = ""
    escaped = False
    obj_start = -1

    for i, ch in enumerate(block):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote_char:
                in_string = False
            continue

        if ch in ('"', "'"):
            in_string = True
            quote_char = ch
            continue

        if ch == "{":
            if depth == 0:
                obj_start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and obj_start != -1:
                objects.append(block[obj_start : i + 1])
                obj_start = -1

    return objects


def html_to_text(html_fragment: str) -> str:
    stripped = re.sub(r"<[^>]+>", "", html_fragment)
    return stripped.replace("&#39;", "'").replace("&amp;", "&").strip()


def parse_capology_payrolls(page: str) -> List[dict]:
    rows = extract_js_array_objects(page)
    parsed: List[dict] = []

    for row in rows:
        club_html_match = re.search(r'"club"\s*:\s*"(.*?)"\s*,', row, re.S)
        annual_gbp_match = re.search(
            r'"annual_gross_gbp"\s*:\s*accounting\.formatMoney\("([0-9.\-]+)"', row
        )
        if not club_html_match or not annual_gbp_match:
            continue

        club_html = club_html_match.group(1)
        club_name = html_to_text(club_html)
        slug_match = re.search(r"href='/club/([^/]+)/", club_html)
        if not slug_match:
            continue

        parsed.append(
            {
                "club": club_name,
                "slug": slug_match.group(1),
                "annual_gross_gbp": float(annual_gbp_match.group(1)),
            }
        )

    return parsed


def parse_capology_salary_contracts(page: str) -> Dict[str, dict]:
    rows = extract_js_array_objects(page)
    by_name: Dict[str, dict] = {}

    for row in rows:
        name_match = re.search(r"'name'\s*:\s*\"(.*?)\"\s*,", row, re.S)
        signed_match = re.search(r"'signed'\s*:\s*moment\(\"([^\"]*)\"\)", row)
        expiration_match = re.search(r"'expiration'\s*:\s*moment\(\"([^\"]*)\"\)", row)
        years_match = re.search(r"'years'\s*:\s*\"([^\"]*)\"", row)
        position_match = re.search(r"'position'\s*:\s*\"([^\"]*)\"", row)
        age_match = re.search(r"'age'\s*:\s*Math\.round\(\"([^\"]*)\"\)", row)
        active_match = re.search(r"'active'\s*:\s*\"([^\"]*)\"", row)

        if not name_match:
            continue

        if active_match and active_match.group(1) != "True":
            continue

        player_name = html_to_text(name_match.group(1))
        norm_name = normalize_text(player_name)

        signed = parse_iso_date(signed_match.group(1) if signed_match else "")
        expiration = parse_iso_date(expiration_match.group(1) if expiration_match else "")

        remaining_years = None
        if years_match and years_match.group(1).strip().isdigit():
            remaining_years = int(years_match.group(1).strip())

        age = None
        if age_match and age_match.group(1).strip().isdigit():
            age = int(age_match.group(1).strip())

        by_name[norm_name] = {
            "player": player_name,
            "signed": signed,
            "expiration": expiration,
            "remaining_years": remaining_years,
            "position": position_match.group(1) if position_match else "",
            "age": age,
        }

    return by_name


def parse_iso_date(value: str) -> Optional[dt.date]:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def match_player_contract(
    player_name: str,
    club_contracts: Dict[str, dict],
) -> tuple[Optional[dict], str]:
    norm = normalize_text(player_name)
    if norm in club_contracts:
        return club_contracts[norm], "exact"

    if not club_contracts:
        return None, "none"

    candidates = list(club_contracts.keys())
    matches = difflib.get_close_matches(norm, candidates, n=1, cutoff=0.9)
    if matches:
        return club_contracts[matches[0]], "fuzzy"

    return None, "none"


def infer_contract_years_from_dates(signed: Optional[dt.date], expiration: Optional[dt.date]) -> Optional[int]:
    if not signed or not expiration:
        return None
    days = (expiration - signed).days
    if days <= 0:
        return None
    return max(1, int(round(days / 365.25)))


def infer_contract_years_from_profile(age: Optional[int], position: str, fee: float, is_loan: bool) -> int:
    if is_loan:
        return 1

    if age is None:
        years = 4
    elif age <= 20:
        years = 5
    elif age <= 24:
        years = 5
    elif age <= 28:
        years = 4
    elif age <= 31:
        years = 3
    else:
        years = 2

    if fee >= 60000000 and (age is None or age <= 25):
        years = max(years, 5)

    if fee < 10000000 and age is not None and age >= 29:
        years = min(years, 2)

    if position in {"GK"} and age is not None and age <= 26:
        years = max(years, 5)

    return years


def normalize_club(raw_club: str, canonical_map: Dict[str, str]) -> Optional[str]:
    normalized = normalize_text(raw_club)
    if normalized in CLUB_ALIASES:
        return CLUB_ALIASES[normalized]
    if normalized in canonical_map:
        return canonical_map[normalized]

    best_match = difflib.get_close_matches(normalized, list(canonical_map.keys()), n=1, cutoff=0.85)
    if best_match:
        return canonical_map[best_match[0]]
    return None


def parse_transfers_csv(csv_text: str, season_year: int, canonical_map: Dict[str, str]) -> Dict[str, dict]:
    by_club: Dict[str, dict] = {}
    reader = csv.DictReader(csv_text.splitlines())

    for row in reader:
        if row.get("league") != PL_LEAGUE:
            continue
        if int(row.get("season") or 0) != season_year:
            continue

        club = normalize_club(row.get("club", ""), canonical_map)
        if not club:
            continue

        movement = (row.get("movement") or "").strip().lower()
        if movement not in {"in", "out"}:
            continue

        fee = safe_float(row.get("fee", "0"))
        age = safe_int(row.get("age", ""))
        is_loan = str(row.get("is_loan", "0")).strip() == "1"

        item = {
            "player": (row.get("player_name") or "Unknown").strip(),
            "fee": fee,
            "age": age,
            "position": (row.get("pos") or "").strip(),
            "market_value": safe_float(row.get("market_value", "0")),
            "is_loan": is_loan,
            "window": (row.get("window") or "").strip().lower(),
            "source": "transfermarkt_data_github",
        }

        by_club.setdefault(club, {"in": [], "out": []})
        by_club[club][movement].append(item)

    return by_club


def safe_float(value: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def safe_int(value: str) -> Optional[int]:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def load_contract_overrides(path: Path) -> Dict[str, dict]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    normalized: Dict[str, dict] = {}
    for club, players in raw.items():
        club_key = normalize_text(club)
        normalized[club_key] = {}
        for player_name, payload in players.items():
            normalized[club_key][normalize_text(player_name)] = payload
    return normalized


def build_dataset(output_path: Path, season_year: int, overrides_path: Path) -> None:
    fetched_at = dt.datetime.now(dt.timezone.utc)

    payroll_page = fetch_text(PAYROLL_URL)
    payroll_rows = parse_capology_payrolls(payroll_page)
    if not payroll_rows:
        raise RuntimeError("Could not parse Capology payroll rows.")

    clubs = sorted({row["club"] for row in payroll_rows})
    canonical_map = {normalize_text(club): club for club in clubs}

    transfer_csv = fetch_text(TRANSFERS_URL.format(season=season_year))
    transfer_rows = parse_transfers_csv(transfer_csv, season_year=season_year, canonical_map=canonical_map)

    overrides = load_contract_overrides(overrides_path)

    salary_contracts: Dict[str, Dict[str, dict]] = {}
    wage_by_club: Dict[str, float] = {}
    slug_by_club: Dict[str, str] = {}

    for row in payroll_rows:
        club = row["club"]
        wage_by_club[club] = row["annual_gross_gbp"]
        slug_by_club[club] = row["slug"]

    for club in clubs:
        slug = slug_by_club[club]
        salary_page = fetch_text(CLUB_SALARIES_URL.format(slug=slug))
        salary_contracts[club] = parse_capology_salary_contracts(salary_page)

    output_clubs: List[dict] = []
    total_incoming = 0
    total_reported = 0

    for club in clubs:
        incoming = transfer_rows.get(club, {}).get("in", [])
        outgoing = transfer_rows.get(club, {}).get("out", [])
        contracts = salary_contracts.get(club, {})

        club_in_rows: List[dict] = []
        reported = 0
        fuzzy = 0
        assumed = 0
        overridden = 0

        for move in incoming:
            total_incoming += 1
            player = move["player"]
            fee = move["fee"]
            age = move["age"]
            position = move["position"]

            contract_years: Optional[int] = None
            confidence = "assumed_profile"
            reason = "Profile-based fallback (age/position/fee)."

            club_override = overrides.get(normalize_text(club), {})
            player_override = club_override.get(normalize_text(player))
            if player_override and player_override.get("contract_years"):
                contract_years = int(player_override["contract_years"])
                confidence = "override"
                reason = player_override.get("note", "Manual override.")
                overridden += 1
            else:
                contract_record, match_type = match_player_contract(player, contracts)
                if contract_record:
                    reported_years = infer_contract_years_from_dates(
                        contract_record.get("signed"), contract_record.get("expiration")
                    )
                    if reported_years:
                        contract_years = reported_years
                        if match_type == "exact":
                            confidence = "reported"
                            reported += 1
                        else:
                            confidence = "reported_fuzzy_match"
                            fuzzy += 1
                        reason = "Published signed/expiration dates from Capology."
                    elif move["is_loan"]:
                        contract_years = 1
                        confidence = "reported_loan"
                        reason = "Loan deal treated as one-year amortization."
                        reported += 1

            if contract_years is None:
                contract_years = infer_contract_years_from_profile(age, position, fee, move["is_loan"])
                assumed += 1

            if confidence in {"reported", "reported_fuzzy_match", "reported_loan"}:
                total_reported += 1

            club_in_rows.append(
                {
                    "player": player,
                    "fee": int(round(fee)),
                    "contract_years": int(contract_years),
                    "contract_confidence": confidence,
                    "contract_note": reason,
                    "age": age,
                    "position": position,
                    "is_loan": move["is_loan"],
                    "window": move["window"],
                    "source": move["source"],
                }
            )

        club_out_rows: List[dict] = []
        for move in outgoing:
            club_out_rows.append(
                {
                    "player": move["player"],
                    "fee": int(round(move["fee"])),
                    "is_loan": move["is_loan"],
                    "window": move["window"],
                    "source": move["source"],
                }
            )

        club_id = f"{normalize_text(club).replace(' ', '_')}_{season_year}"
        output_clubs.append(
            {
                "team_id": club_id,
                "team_name": club,
                "league": PL_LEAGUE,
                "season": SEASON_LABEL,
                "wage_bill": int(round(wage_by_club.get(club, 0))),
                "wage_source": "capology_payrolls",
                "transfers_in": sorted(club_in_rows, key=lambda row: row["fee"], reverse=True),
                "transfers_out": sorted(club_out_rows, key=lambda row: row["fee"], reverse=True),
                "confidence_summary": {
                    "reported_contracts": reported,
                    "fuzzy_reported_contracts": fuzzy,
                    "override_contracts": overridden,
                    "assumed_contracts": assumed,
                    "incoming_count": len(club_in_rows),
                },
            }
        )

    reported_pct = 0.0
    if total_incoming > 0:
        reported_pct = (total_reported / total_incoming) * 100.0

    payload = {
        "last_updated": fetched_at.strftime("%Y-%m-%d"),
        "generated_at_utc": fetched_at.isoformat(),
        "base_currency": "GBP",
        "exchange_rates": {
            "GBP": 1.0,
            "EUR": 1.16,
            "USD": 1.28,
        },
        "scope": {
            "league": PL_LEAGUE,
            "season": SEASON_LABEL,
            "season_year": season_year,
        },
        "methodology": {
            "summary": (
                "Total spend = wage bill + amortized transfer-in fees - transfer-out revenue. "
                "Contract length is taken from published signed/expiration dates when available; "
                "otherwise profile-based assumptions are used."
            ),
            "contract_length_fallback": (
                "Assumed contract years by profile: younger/high-fee signings skew longer terms; "
                "older/low-fee signings skew shorter terms; loans default to one year."
            ),
            "contract_coverage_reported_percent": round(reported_pct, 1),
            "notes": [
                "Capology values are estimates and may differ from official club filings.",
                "Transfer fees are sourced from a public Transfermarkt-derived dataset mirror.",
                "Outgoing transfers are treated as immediate revenue offset in net transfer cost.",
            ],
        },
        "sources": [
            {
                "id": "capology_payrolls",
                "name": "Capology Premier League Payrolls",
                "url": PAYROLL_URL,
                "type": "wages",
            },
            {
                "id": "capology_club_salaries",
                "name": "Capology Club Salaries pages",
                "url": "https://www.capology.com/club/arsenal/salaries/",
                "type": "contract_dates",
            },
            {
                "id": "transfermarkt_data_github",
                "name": "Transfermarkt Data (GitHub mirror)",
                "url": TRANSFERS_URL.format(season=season_year),
                "type": "transfers",
            },
        ],
        "clubs": sorted(output_clubs, key=lambda row: row["team_name"]),
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Update Premier League spend data")
    parser.add_argument("--season-year", type=int, default=2025, help="Transfer CSV season year (default: 2025)")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/teams.json"),
        help="Output JSON path (default: data/teams.json)",
    )
    parser.add_argument(
        "--overrides",
        type=Path,
        default=Path("data/contract_overrides.json"),
        help="Manual contract override JSON (default: data/contract_overrides.json)",
    )
    args = parser.parse_args()

    build_dataset(output_path=args.output, season_year=args.season_year, overrides_path=args.overrides)


if __name__ == "__main__":
    main()
