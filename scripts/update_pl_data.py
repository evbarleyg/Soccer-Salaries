#!/usr/bin/env python3
"""Build multi-league spend dataset from free web sources.

Sources:
- Capology league payrolls pages (club annual wage bills)
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

CLUB_SALARIES_URL = "https://www.capology.com/club/{slug}/salaries/"
TRANSFERS_URL = "https://raw.githubusercontent.com/eordo/transfermarkt-data/master/{league_path}/{season}.csv"

LEAGUES = [
    {
        "id": "premier_league",
        "label": "Premier League",
        "payroll_url": "https://www.capology.com/uk/premier-league/payrolls/",
        "transfer_path": "premier_league",
        "transfer_names": {"premier league"},
    },
    {
        "id": "laliga",
        "label": "LaLiga",
        "payroll_url": "https://www.capology.com/es/la-liga/payrolls/",
        "transfer_path": "laliga",
        "transfer_names": {"laliga", "la liga"},
    },
]

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
    # LaLiga aliases
    "athletic bilbao": "Athletic Club",
    "atletico de madrid": "Atletico Madrid",
    "ca osasuna": "Osasuna",
    "celta de vigo": "Celta Vigo",
    "deportivo alaves": "Alaves",
    "elche cf": "Elche",
    "fc barcelona": "Barcelona",
    "getafe cf": "Getafe",
    "girona fc": "Girona",
    "levante ud": "Levante",
    "rcd espanyol barcelona": "Espanyol",
    "rcd mallorca": "Mallorca",
    "real betis balompie": "Real Betis",
    "sevilla fc": "Sevilla",
    "valencia cf": "Valencia",
    "villarreal cf": "Villarreal",
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
    for attempt in range(5):
        completed = subprocess.run(cmd, capture_output=True, text=True)
        if completed.returncode == 0:
            return completed.stdout
        err = completed.stderr.strip() or f"curl exit code {completed.returncode}"
        errors.append(err)
        wait_seconds = (2 ** attempt) if "429" in err else 1
        time.sleep(wait_seconds)
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
        annual_gross_match = re.search(
            r"'annual_gross_gbp'\s*:\s*accounting\.formatMoney\(\"([0-9.\-]+)\"",
            row,
        )
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
            "annual_gross_gbp": float(annual_gross_match.group(1)) if annual_gross_match else None,
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


def parse_transfers_csv(
    csv_text: str,
    season_year: int,
    canonical_map: Dict[str, str],
    transfer_names: set[str],
) -> Dict[str, dict]:
    by_club: Dict[str, dict] = {}
    reader = csv.DictReader(csv_text.splitlines())
    allowed_names = {name.lower() for name in transfer_names}

    for row in reader:
        row_league = (row.get("league") or "").strip().lower()
        if row_league not in allowed_names:
            continue
        row_season = safe_int(row.get("season") or "")
        if row_season != season_year:
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
            "season": row_season,
            "source": "transfermarkt_data_github",
        }

        by_club.setdefault(club, {"in": [], "out": []})
        by_club[club][movement].append(item)

    return by_club


def merge_transfer_rows(base: Dict[str, dict], extra: Dict[str, dict]) -> None:
    for club, movement_rows in extra.items():
        bucket = base.setdefault(club, {"in": [], "out": []})
        bucket["in"].extend(movement_rows.get("in", []))
        bucket["out"].extend(movement_rows.get("out", []))


def resolve_contract_terms(
    move: dict,
    club: str,
    contracts: Dict[str, dict],
    overrides: Dict[str, dict],
) -> dict:
    player = move["player"]
    fee = move["fee"]
    age = move["age"]
    position = move["position"]

    contract_years: Optional[int] = None
    confidence = "assumed_profile"
    reason = "Profile-based fallback (age/position/fee)."
    contract_record = None

    club_override = overrides.get(normalize_text(club), {})
    player_override = club_override.get(normalize_text(player))
    if player_override and player_override.get("contract_years"):
        contract_years = int(player_override["contract_years"])
        confidence = "override"
        reason = player_override.get("note", "Manual override.")
    else:
        contract_record, match_type = match_player_contract(player, contracts)
        if contract_record:
            reported_years = infer_contract_years_from_dates(
                contract_record.get("signed"), contract_record.get("expiration")
            )
            if reported_years:
                contract_years = reported_years
                confidence = "reported" if match_type == "exact" else "reported_fuzzy_match"
                reason = "Published signed/expiration dates from Capology."
            elif move["is_loan"]:
                contract_years = 1
                confidence = "reported_loan"
                reason = "Loan deal treated as one-year amortization."

    if contract_years is None:
        contract_years = infer_contract_years_from_profile(age, position, fee, move["is_loan"])

    return {
        "contract_years": int(contract_years),
        "contract_confidence": confidence,
        "contract_note": reason,
        "annual_wage_gbp": (
            int(round(float(contract_record.get("annual_gross_gbp") or 0)))
            if contract_record and contract_record.get("annual_gross_gbp") is not None
            else None
        ),
    }


def player_left_club_after_incoming(
    incoming_player: str,
    incoming_season: int,
    outgoing_by_player: Dict[str, List[int]],
    target_season: int,
) -> bool:
    norm = normalize_text(incoming_player)
    out_seasons = outgoing_by_player.get(norm, [])
    for out_season in out_seasons:
        if incoming_season < out_season <= target_season:
            return True
    return False


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


def build_dataset(output_path: Path, season_year: int, overrides_path: Path, history_years: int) -> None:
    fetched_at = dt.datetime.now(dt.timezone.utc)
    transfer_start_year = max(1992, season_year - max(0, history_years))
    season_label = f"{season_year}/{str(season_year + 1)[-2:]}"
    overrides = load_contract_overrides(overrides_path)

    output_clubs: List[dict] = []
    source_rows: List[dict] = []
    loaded_seasons_by_league: Dict[str, List[int]] = {}
    total_incoming = 0
    total_reported = 0

    for league_cfg in LEAGUES:
        league_id = league_cfg["id"]
        league_label = league_cfg["label"]
        payroll_url = league_cfg["payroll_url"]
        transfer_path = league_cfg["transfer_path"]
        transfer_names = set(league_cfg["transfer_names"])

        payroll_page = fetch_text(payroll_url)
        payroll_rows = parse_capology_payrolls(payroll_page)
        if not payroll_rows:
            print(f"Warning: no payroll rows parsed for {league_label}")
            continue

        clubs = sorted({row["club"] for row in payroll_rows})
        canonical_map = {normalize_text(club): club for club in clubs}

        transfer_rows: Dict[str, dict] = {}
        fetched_transfer_seasons: List[int] = []
        for transfer_year in range(transfer_start_year, season_year + 1):
            try:
                transfer_csv = fetch_text(TRANSFERS_URL.format(league_path=transfer_path, season=transfer_year))
                season_rows = parse_transfers_csv(
                    transfer_csv,
                    season_year=transfer_year,
                    canonical_map=canonical_map,
                    transfer_names=transfer_names,
                )
                merge_transfer_rows(transfer_rows, season_rows)
                fetched_transfer_seasons.append(transfer_year)
            except RuntimeError as exc:
                print(f"Warning: skipping {league_label} transfer season {transfer_year}: {exc}")
        loaded_seasons_by_league[league_label] = fetched_transfer_seasons

        salary_contracts: Dict[str, Dict[str, dict]] = {}
        wage_by_club: Dict[str, float] = {}
        slug_by_club: Dict[str, str] = {}

        for row in payroll_rows:
            club = row["club"]
            wage_by_club[club] = row["annual_gross_gbp"]
            slug_by_club[club] = row["slug"]

        for club in clubs:
            slug = slug_by_club[club]
            try:
                salary_page = fetch_text(CLUB_SALARIES_URL.format(slug=slug))
                salary_contracts[club] = parse_capology_salary_contracts(salary_page)
            except RuntimeError as exc:
                print(f"Warning: no salary contracts for {league_label} {club}: {exc}")
                salary_contracts[club] = {}
            time.sleep(0.25)

        for club in clubs:
            all_incoming = transfer_rows.get(club, {}).get("in", [])
            all_outgoing = transfer_rows.get(club, {}).get("out", [])
            incoming = [move for move in all_incoming if int(move.get("season") or 0) == season_year]
            outgoing = [move for move in all_outgoing if int(move.get("season") or 0) == season_year]
            contracts = salary_contracts.get(club, {})
            outgoing_by_player: Dict[str, List[int]] = {}
            for out_move in all_outgoing:
                season = int(out_move.get("season") or 0)
                if season <= 0:
                    continue
                outgoing_by_player.setdefault(normalize_text(out_move["player"]), []).append(season)

            club_in_rows: List[dict] = []
            reported = 0
            fuzzy = 0
            assumed = 0
            overridden = 0

            for move in incoming:
                total_incoming += 1
                terms = resolve_contract_terms(move, club, contracts, overrides)
                contract_years = terms["contract_years"]
                confidence = terms["contract_confidence"]
                reason = terms["contract_note"]
                annual_wage = terms["annual_wage_gbp"]
                annual_amortization = int(round((move["fee"] or 0) / max(1, contract_years)))

                if confidence == "override":
                    overridden += 1
                elif confidence in {"reported", "reported_loan"}:
                    reported += 1
                elif confidence == "reported_fuzzy_match":
                    fuzzy += 1
                elif confidence == "assumed_profile":
                    assumed += 1

                if confidence in {"reported", "reported_fuzzy_match", "reported_loan", "override"}:
                    total_reported += 1

                club_in_rows.append(
                    {
                        "player": move["player"],
                        "fee": int(round(move["fee"])),
                        "contract_years": int(contract_years),
                        "contract_confidence": confidence,
                        "contract_note": reason,
                        "annual_amortization": annual_amortization,
                        "annual_wage_gbp": annual_wage,
                        "age": move["age"],
                        "position": move["position"],
                        "is_loan": move["is_loan"],
                        "window": move["window"],
                        "season": int(move.get("season") or season_year),
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

            amortization_assets: List[dict] = []
            annual_amortization_total = 0
            annual_amortization_current = 0
            annual_amortization_carryover = 0

            for move in all_incoming:
                source_season = int(move.get("season") or 0)
                if source_season <= 0 or source_season > season_year:
                    continue
                if (move.get("fee") or 0) <= 0:
                    continue
                if player_left_club_after_incoming(move["player"], source_season, outgoing_by_player, season_year):
                    continue

                terms = resolve_contract_terms(move, club, contracts, overrides)
                contract_years = int(terms["contract_years"])
                years_elapsed = season_year - source_season
                if years_elapsed < 0 or years_elapsed >= contract_years:
                    continue

                annual_amortization = int(round((move["fee"] or 0) / max(1, contract_years)))
                years_remaining = max(1, contract_years - years_elapsed)
                annual_wage = terms["annual_wage_gbp"]
                total_annual_cost = annual_amortization + (annual_wage or 0)

                annual_amortization_total += annual_amortization
                if source_season == season_year:
                    annual_amortization_current += annual_amortization
                else:
                    annual_amortization_carryover += annual_amortization

                amortization_assets.append(
                    {
                        "player": move["player"],
                        "source_season": source_season,
                        "fee": int(round(move["fee"])),
                        "contract_years": contract_years,
                        "years_elapsed": years_elapsed,
                        "years_remaining": years_remaining,
                        "annual_amortization": annual_amortization,
                        "annual_wage_gbp": annual_wage,
                        "annual_total_cost": total_annual_cost,
                        "contract_confidence": terms["contract_confidence"],
                        "contract_note": terms["contract_note"],
                        "is_loan": move["is_loan"],
                        "window": move["window"],
                        "source": move["source"],
                    }
                )

            club_id = f"{normalize_text(club).replace(' ', '_')}_{league_id}_{season_year}"
            output_clubs.append(
                {
                    "team_id": club_id,
                    "team_name": club,
                    "league": league_label,
                    "season": season_label,
                    "wage_bill": int(round(wage_by_club.get(club, 0))),
                    "wage_source": f"capology_payrolls_{league_id}",
                    "transfers_in": sorted(club_in_rows, key=lambda row: row["fee"], reverse=True),
                    "transfers_out": sorted(club_out_rows, key=lambda row: row["fee"], reverse=True),
                    "amortization_assets": sorted(
                        amortization_assets,
                        key=lambda row: (row["annual_amortization"], row["fee"]),
                        reverse=True,
                    ),
                    "amortization_summary": {
                        "annual_current_window": annual_amortization_current,
                        "annual_prior_windows": annual_amortization_carryover,
                        "annual_total_assets": annual_amortization_total,
                        "active_asset_count": len(amortization_assets),
                    },
                    "confidence_summary": {
                        "reported_contracts": reported,
                        "fuzzy_reported_contracts": fuzzy,
                        "override_contracts": overridden,
                        "assumed_contracts": assumed,
                        "incoming_count": len(club_in_rows),
                    },
                }
            )

        source_rows.append(
            {
                "id": f"capology_payrolls_{league_id}",
                "name": f"Capology {league_label} Payrolls",
                "url": payroll_url,
                "type": "wages",
            }
        )
        source_rows.append(
            {
                "id": f"transfermarkt_data_github_{league_id}",
                "name": f"Transfermarkt Data (GitHub mirror) - {league_label}",
                "url": (
                    "https://raw.githubusercontent.com/eordo/transfermarkt-data/master/"
                    f"{transfer_path}/{transfer_start_year}.csv .. {season_year}.csv"
                ),
                "type": "transfers",
            }
        )

    if not output_clubs:
        raise RuntimeError("No club rows were generated for configured leagues.")

    reported_pct = 0.0
    if total_incoming > 0:
        reported_pct = (total_reported / total_incoming) * 100.0

    loaded_chunks: List[str] = []
    for league_cfg in LEAGUES:
        league_label = league_cfg["label"]
        fetched = loaded_seasons_by_league.get(league_label, [])
        if not fetched:
            loaded_chunks.append(f"{league_label}: none")
            continue
        loaded_chunks.append(f"{league_label}: {min(fetched)}-{max(fetched)} ({len(fetched)} season files)")
    loaded_seasons_text = "; ".join(loaded_chunks)

    active_leagues = [cfg["label"] for cfg in LEAGUES if any(c["league"] == cfg["label"] for c in output_clubs)]
    league_scope_label = " + ".join(active_leagues)

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
            "league": league_scope_label,
            "season": season_label,
            "season_year": season_year,
            "transfer_history_start_year": transfer_start_year,
            "transfer_history_end_year": season_year,
        },
        "methodology": {
            "summary": (
                "Total spend = wage bill + active annual transfer amortization - transfer-out revenue. "
                "Active amortization includes current-window deals plus prior-window signings still "
                "within their inferred contract term and not sold."
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
                f"Transfer history seasons loaded: {loaded_seasons_text}.",
            ],
        },
        "sources": [
            *source_rows,
            {
                "id": "capology_club_salaries",
                "name": "Capology Club Salaries pages",
                "url": "https://www.capology.com/club/arsenal/salaries/",
                "type": "contract_dates",
            },
        ],
        "clubs": sorted(output_clubs, key=lambda row: (row["league"], row["team_name"])),
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Update league spend data (Premier League + LaLiga)")
    parser.add_argument("--season-year", type=int, default=2025, help="Transfer CSV season year (default: 2025)")
    parser.add_argument(
        "--history-years",
        type=int,
        default=6,
        help="How many prior seasons to include for active amortization carryover (default: 6)",
    )
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

    build_dataset(
        output_path=args.output,
        season_year=args.season_year,
        overrides_path=args.overrides,
        history_years=args.history_years,
    )


if __name__ == "__main__":
    main()
