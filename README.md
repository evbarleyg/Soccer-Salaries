# True Spend: Premier League Dashboard

Static dashboard for comparing Premier League squad spend using:

- Wage bill (estimated gross annual payroll)
- Active annual amortization (current + prior-window incomings still on books)
- Transfer-out revenue
- Net transfer cost and total spend

## Data Sources

- Capology payrolls page for club wage bills: https://www.capology.com/uk/premier-league/payrolls/
- Capology club salary pages for signed/expiration dates: https://www.capology.com/club/arsenal/salaries/
- Transfermarkt-derived transfer dataset (GitHub mirror), multi-season history: https://raw.githubusercontent.com/eordo/transfermarkt-data/master/premier_league/2025.csv

## Method

`Total Spend = Wage Bill + Active Annual Amortization - Transfer-Out Revenue`

Contract years are assigned in this order:

1. Published signed + expiration dates from Capology (highest confidence)
2. Manual overrides in `data/contract_overrides.json`
3. Profile-based assumptions (age/position/fee; loans default to 1 year)

Active amortization includes prior-window incoming fees still being recognized in the selected season.

## Local Run

```bash
python3 scripts/update_pl_data.py --season-year 2025 --output data/teams.json
python3 -m http.server
```

Optional: set lookback window for prior transfer seasons.

```bash
python3 scripts/update_pl_data.py --season-year 2025 --history-years 6 --output data/teams.json
```

Open `http://localhost:8000`.

## GitHub Pages

Workflows included:

- `.github/workflows/update-data.yml`: refreshes `data/teams.json` weekly and on manual trigger
- `.github/workflows/deploy-pages.yml`: deploys static site to GitHub Pages on push to `main`

In GitHub repository settings:

1. Go to `Settings -> Pages`
2. Set source to `GitHub Actions`

Then push `main` and the site will deploy automatically.
