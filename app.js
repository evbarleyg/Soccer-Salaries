const DATA_URL = "./data/teams.json";

const HIGH_CONFIDENCE = new Set([
  "reported",
  "reported_fuzzy_match",
  "reported_loan",
  "override",
]);

const state = {
  raw: null,
  filtered: [],
  selected: new Set(),
  currency: "GBP",
  league: "All",
  season: "All",
  search: "",
  sortBy: "totalSpend",
};

const elements = {
  table: document.getElementById("clubTable"),
  mobileCards: document.getElementById("mobileClubCards"),
  spendChart: document.getElementById("spendChart"),
  summary: document.getElementById("summaryCards"),
  compareCards: document.getElementById("compareCards"),
  compareHint: document.getElementById("compareHint"),
  leagueControl: document.getElementById("leagueControl"),
  leagueSelect: document.getElementById("leagueSelect"),
  seasonSelect: document.getElementById("seasonSelect"),
  currencySelect: document.getElementById("currencySelect"),
  sortSelect: document.getElementById("sortSelect"),
  searchInput: document.getElementById("searchInput"),
  lastUpdated: document.getElementById("lastUpdated"),
  refreshBtn: document.getElementById("refreshBtn"),
  methodSummary: document.getElementById("methodSummary"),
  contractFallback: document.getElementById("contractFallback"),
  methodNotes: document.getElementById("methodNotes"),
  sourceList: document.getElementById("sourceList"),
};

const formatMoney = (value, currency) => {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
};

const formatPercent = (value) => `${Math.round(value * 100)}%`;

const deriveClub = (club, fx) => {
  const amortizedTransfers = club.transfers_in.reduce((sum, transfer) => {
    const years = transfer.contract_years || 4;
    return sum + transfer.fee / years;
  }, 0);

  const transferOutRevenue = club.transfers_out.reduce((sum, transfer) => sum + transfer.fee, 0);
  const netTransferCost = amortizedTransfers - transferOutRevenue;
  const totalSpend = club.wage_bill + netTransferCost;

  const incomingCount = club.transfers_in.length;
  const reportedContracts = club.transfers_in.filter((transfer) => HIGH_CONFIDENCE.has(transfer.contract_confidence)).length;
  const contractCoverage = incomingCount ? reportedContracts / incomingCount : 1;

  return {
    ...club,
    wageBill: club.wage_bill * fx,
    amortizedTransfers: amortizedTransfers * fx,
    transferOutRevenue: transferOutRevenue * fx,
    netTransferCost: netTransferCost * fx,
    totalSpend: totalSpend * fx,
    incomingCount,
    reportedContracts,
    contractCoverage,
  };
};

const computeFx = (currency) => state.raw.exchange_rates[currency] ?? 1;

const applyFilters = () => {
  const fx = computeFx(state.currency);

  state.filtered = state.raw.clubs
    .filter((club) => (state.league === "All" ? true : club.league === state.league))
    .filter((club) => (state.season === "All" ? true : club.season === state.season))
    .filter((club) => club.team_name.toLowerCase().includes(state.search))
    .map((club) => deriveClub(club, fx))
    .sort((a, b) => b[state.sortBy] - a[state.sortBy]);
};

const coverageClass = (coverage) => {
  if (coverage >= 0.8) return "high";
  if (coverage >= 0.5) return "mid";
  return "low";
};

const syncSelectionFromEvent = (event) => {
  const id = event.target.dataset.id;
  if (event.target.checked) {
    if (state.selected.size >= 4) {
      event.target.checked = false;
      return;
    }
    state.selected.add(id);
  } else {
    state.selected.delete(id);
  }

  renderTable();
  renderMobileCards();
  renderCompare();
};

const bindSelectionInputs = (root) => {
  root.querySelectorAll("input[type='checkbox'][data-id]").forEach((input) => {
    input.addEventListener("change", syncSelectionFromEvent);
  });
};

const renderSummary = () => {
  const totalSpend = state.filtered.reduce((sum, club) => sum + club.totalSpend, 0);
  const totalWages = state.filtered.reduce((sum, club) => sum + club.wageBill, 0);
  const totalNetTransfer = state.filtered.reduce((sum, club) => sum + club.netTransferCost, 0);
  const incoming = state.filtered.reduce((sum, club) => sum + club.incomingCount, 0);
  const reported = state.filtered.reduce((sum, club) => sum + club.reportedContracts, 0);
  const coverage = incoming ? reported / incoming : 1;

  const cards = [
    {
      label: "Total Spend",
      value: formatMoney(totalSpend, state.currency),
      hint: `Across ${state.filtered.length} clubs`,
    },
    {
      label: "Total Wages",
      value: formatMoney(totalWages, state.currency),
      hint: "Estimated gross wage bill",
    },
    {
      label: "Net Transfer Cost",
      value: formatMoney(totalNetTransfer, state.currency),
      hint: "Amortized in minus transfer-out revenue",
    },
    {
      label: "Reported Contract Coverage",
      value: formatPercent(coverage),
      hint: `${reported} of ${incoming} incoming deals`,
    },
  ];

  elements.summary.innerHTML = cards
    .map(
      (card) => `
        <div class="card">
          <h3>${card.label}</h3>
          <div class="value">${card.value}</div>
          <div class="hint">${card.hint}</div>
        </div>
      `
    )
    .join("");
};

const renderTrendChart = () => {
  const topClubs = [...state.filtered].slice(0, 10);
  const maxSpend = topClubs.reduce((max, club) => Math.max(max, club.totalSpend), 0) || 1;

  elements.spendChart.innerHTML = topClubs
    .map((club) => {
      const width = Math.max(6, Math.round((club.totalSpend / maxSpend) * 100));
      return `
        <div class="trend-row">
          <div class="trend-name">${club.team_name}</div>
          <div class="trend-track"><span class="trend-fill" style="width:${width}%"></span></div>
          <div class="trend-value">${formatMoney(club.totalSpend, state.currency)}</div>
        </div>
      `;
    })
    .join("");
};

const renderTable = () => {
  elements.table.innerHTML = state.filtered
    .map((club) => {
      const checked = state.selected.has(club.team_id);
      const coverageClassName = coverageClass(club.contractCoverage);
      return `
        <tr>
          <td>
            <label class="checkbox">
              <input type="checkbox" data-id="${club.team_id}" ${checked ? "checked" : ""} />
            </label>
          </td>
          <td>${club.team_name}</td>
          <td>${formatMoney(club.wageBill, state.currency)}</td>
          <td>${formatMoney(club.amortizedTransfers, state.currency)}</td>
          <td>${formatMoney(club.transferOutRevenue, state.currency)}</td>
          <td>${formatMoney(club.netTransferCost, state.currency)}</td>
          <td>${formatMoney(club.totalSpend, state.currency)}</td>
          <td><span class="coverage ${coverageClassName}">${formatPercent(club.contractCoverage)}</span></td>
        </tr>
      `;
    })
    .join("");

  bindSelectionInputs(elements.table);
};

const renderMobileCards = () => {
  elements.mobileCards.innerHTML = state.filtered
    .map((club) => {
      const checked = state.selected.has(club.team_id);
      const coverageClassName = coverageClass(club.contractCoverage);

      return `
        <article class="mobile-club-card">
          <div class="mobile-club-head">
            <h4>${club.team_name}</h4>
            <label class="checkbox">
              <input type="checkbox" data-id="${club.team_id}" ${checked ? "checked" : ""} />
            </label>
          </div>
          <div class="mobile-club-grid">
            <div class="mobile-metric">
              <span class="mobile-metric-label">Total Spend</span>
              <span class="mobile-metric-value">${formatMoney(club.totalSpend, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">Wages</span>
              <span class="mobile-metric-value">${formatMoney(club.wageBill, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">Amortized In</span>
              <span class="mobile-metric-value">${formatMoney(club.amortizedTransfers, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">Transfer Out</span>
              <span class="mobile-metric-value">${formatMoney(club.transferOutRevenue, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">Net Transfer</span>
              <span class="mobile-metric-value">${formatMoney(club.netTransferCost, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">Contract Coverage</span>
              <span class="coverage ${coverageClassName}">${formatPercent(club.contractCoverage)}</span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  bindSelectionInputs(elements.mobileCards);
};

const renderCompare = () => {
  const clubs = state.filtered.filter((club) => state.selected.has(club.team_id));
  elements.compareHint.textContent = clubs.length
    ? `Comparing ${clubs.length} club${clubs.length > 1 ? "s" : ""}.`
    : "Pick clubs from the table.";

  const maxSpend = clubs.reduce((max, club) => Math.max(max, club.totalSpend), 0) || 1;

  elements.compareCards.innerHTML = clubs
    .map((club) => {
      const width = Math.round((club.totalSpend / maxSpend) * 100);
      return `
        <div class="compare-card">
          <h4>${club.team_name}</h4>
          <div class="compare-metric">
            <span>Total Spend</span>
            <strong>${formatMoney(club.totalSpend, state.currency)}</strong>
          </div>
          <div class="bar"><span style="width:${width}%"></span></div>
          <div class="compare-metric">
            <span>Wages</span>
            <span>${formatMoney(club.wageBill, state.currency)}</span>
          </div>
          <div class="compare-metric">
            <span>Net Transfers</span>
            <span>${formatMoney(club.netTransferCost, state.currency)}</span>
          </div>
          <div class="compare-metric">
            <span>Contract Coverage</span>
            <span>${formatPercent(club.contractCoverage)}</span>
          </div>
        </div>
      `;
    })
    .join("");
};

const renderMethodology = () => {
  const methodology = state.raw.methodology || {};
  const notes = methodology.notes || [];
  const sources = state.raw.sources || [];

  elements.methodSummary.textContent = methodology.summary || "";
  elements.contractFallback.textContent = methodology.contract_length_fallback || "";

  elements.methodNotes.innerHTML = notes.map((note) => `<li>${note}</li>`).join("");
  elements.sourceList.innerHTML = sources
    .map((source) => `<li><a href="${source.url}" target="_blank" rel="noreferrer">${source.name}</a></li>`)
    .join("");
};

const populateFilters = () => {
  const leagues = ["All", ...new Set(state.raw.clubs.map((club) => club.league))];
  const seasons = ["All", ...new Set(state.raw.clubs.map((club) => club.season))];

  elements.leagueSelect.innerHTML = leagues.map((league) => `<option value="${league}">${league}</option>`).join("");
  elements.seasonSelect.innerHTML = seasons.map((season) => `<option value="${season}">${season}</option>`).join("");

  const onlyOneLeague = leagues.length <= 2;
  elements.leagueControl.style.display = onlyOneLeague ? "none" : "flex";
  if (onlyOneLeague) {
    state.league = "All";
  }
};

const render = () => {
  applyFilters();
  renderSummary();
  renderTrendChart();
  renderTable();
  renderMobileCards();
  renderCompare();
  renderMethodology();
};

const loadData = async () => {
  const response = await fetch(`${DATA_URL}?ts=${Date.now()}`);
  if (!response.ok) {
    throw new Error("Unable to load data.");
  }

  state.raw = await response.json();
  elements.lastUpdated.textContent = `Updated ${state.raw.last_updated}`;
  populateFilters();
  render();
};

const bindEvents = () => {
  elements.leagueSelect.addEventListener("change", (event) => {
    state.league = event.target.value;
    render();
  });

  elements.seasonSelect.addEventListener("change", (event) => {
    state.season = event.target.value;
    render();
  });

  elements.currencySelect.addEventListener("change", (event) => {
    state.currency = event.target.value;
    render();
  });

  elements.sortSelect.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    render();
  });

  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.toLowerCase();
    render();
  });

  elements.refreshBtn.addEventListener("click", () => {
    loadData().catch((error) => {
      elements.lastUpdated.textContent = error.message;
    });
  });
};

bindEvents();
loadData().catch((error) => {
  elements.lastUpdated.textContent = error.message;
});
