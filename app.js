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
  detailClubId: null,
  currency: "GBP",
  league: "All",
  season: "All",
  search: "",
  sortBy: "totalSpend",
};

const elements = {
  table: document.getElementById("clubTable"),
  quickNav: document.getElementById("quickNav"),
  hoverTooltip: document.getElementById("hoverTooltip"),
  mobileCards: document.getElementById("mobileClubCards"),
  spendChart: document.getElementById("spendChart"),
  findingsGrid: document.getElementById("findingsGrid"),
  qualityRows: document.getElementById("qualityRows"),
  detailClubName: document.getElementById("detailClubName"),
  detailSubtitle: document.getElementById("detailSubtitle"),
  detailCoveragePill: document.getElementById("detailCoveragePill"),
  detailAssumedPill: document.getElementById("detailAssumedPill"),
  detailSpendPill: document.getElementById("detailSpendPill"),
  detailIncomingBody: document.getElementById("detailIncomingBody"),
  detailOutgoingBody: document.getElementById("detailOutgoingBody"),
  summary: document.getElementById("summaryCards"),
  periodBadge: document.getElementById("periodBadge"),
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

const supportsHover = window.matchMedia("(hover: hover)").matches;

const formatMoney = (value, currency) => {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
};

const formatPercent = (value) => `${Math.round(value * 100)}%`;

const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

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
  const summaryAssumed = club.confidence_summary ? Number(club.confidence_summary.assumed_contracts || 0) : 0;
  const inferredAssumed = Math.max(incomingCount - reportedContracts, 0);
  const assumedDeals = Math.max(summaryAssumed, inferredAssumed);
  const contractCoverage = incomingCount ? reportedContracts / incomingCount : 1;
  const grossCommitment = club.wage_bill + amortizedTransfers;
  const wageShareOfCommitment = grossCommitment > 0 ? club.wage_bill / grossCommitment : 0;

  return {
    ...club,
    wageBill: club.wage_bill * fx,
    amortizedTransfers: amortizedTransfers * fx,
    transferOutRevenue: transferOutRevenue * fx,
    netTransferCost: netTransferCost * fx,
    totalSpend: totalSpend * fx,
    incomingCount,
    reportedContracts,
    assumedDeals,
    contractCoverage,
    wageShareOfCommitment,
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

const confidenceLabel = (confidence) => {
  switch (confidence) {
    case "reported":
      return "Reported";
    case "reported_fuzzy_match":
      return "Reported (fuzzy)";
    case "reported_loan":
      return "Reported (loan)";
    case "override":
      return "Manual override";
    default:
      return "Assumed";
  }
};

const hideHoverTooltip = () => {
  elements.hoverTooltip.classList.remove("visible");
  elements.hoverTooltip.setAttribute("aria-hidden", "true");
};

const positionHoverTooltip = (x, y) => {
  const box = elements.hoverTooltip;
  const pad = 10;
  const rect = box.getBoundingClientRect();

  let left = x + 16;
  let top = y + 14;

  if (left + rect.width + pad > window.innerWidth) {
    left = x - rect.width - 16;
  }
  if (top + rect.height + pad > window.innerHeight) {
    top = window.innerHeight - rect.height - pad;
  }

  left = Math.max(pad, left);
  top = Math.max(pad, top);

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
};

const hoverRows = (club, fx, movement) => {
  const rows = movement === "in" ? club.transfers_in : club.transfers_out;
  const sorted = [...rows].sort((a, b) => (b.fee || 0) - (a.fee || 0)).slice(0, 3);
  if (!sorted.length) {
    return '<li><span class="hover-name">No deals</span><span class="hover-value">--</span></li>';
  }

  return sorted
    .map((row) => {
      const fee = formatMoney((row.fee || 0) * fx, state.currency);
      const suffix = movement === "in" ? ` | ${row.contract_years || "--"}y` : "";
      return `<li><span class="hover-name">${escapeHtml(row.player || "Unknown")}</span><span class="hover-value">${fee}${suffix}</span></li>`;
    })
    .join("");
};

const showHoverTooltip = (club, event) => {
  const fx = computeFx(state.currency);
  const coverage = formatPercent(club.contractCoverage);
  const net = formatMoney(club.netTransferCost, state.currency);
  const inRows = hoverRows(club, fx, "in");
  const outRows = hoverRows(club, fx, "out");

  elements.hoverTooltip.innerHTML = `
    <p class="hover-title">${escapeHtml(club.team_name)}</p>
    <p class="hover-sub">Net transfer ${net} | Coverage ${coverage}</p>
    <div class="hover-cols">
      <div>
        <h5>Top In</h5>
        <ul class="hover-list">${inRows}</ul>
      </div>
      <div>
        <h5>Top Out</h5>
        <ul class="hover-list">${outRows}</ul>
      </div>
    </div>
    <p class="hover-foot">Click "View players" for the full table.</p>
  `;

  elements.hoverTooltip.classList.add("visible");
  elements.hoverTooltip.setAttribute("aria-hidden", "false");
  positionHoverTooltip(event.clientX, event.clientY);
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

const bindDrillButtons = (root) => {
  root.querySelectorAll(".drill-btn[data-drill-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      state.detailClubId = event.currentTarget.dataset.drillId;
      renderDetail();
    });
  });
};

const bindHoverTargets = (root) => {
  if (!supportsHover) return;

  root.querySelectorAll("[data-hover-id]").forEach((target) => {
    target.addEventListener("mouseenter", (event) => {
      const club = state.filtered.find((entry) => entry.team_id === event.currentTarget.dataset.hoverId);
      if (!club) return;
      showHoverTooltip(club, event);
    });

    target.addEventListener("mousemove", (event) => {
      if (!elements.hoverTooltip.classList.contains("visible")) return;
      positionHoverTooltip(event.clientX, event.clientY);
    });

    target.addEventListener("mouseleave", hideHoverTooltip);
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

const renderPeriodBadge = () => {
  const scope = state.raw.scope || {};
  const currentClubs = state.filtered.length ? state.filtered : state.raw.clubs || [];
  const windows = new Set();

  currentClubs.forEach((club) => {
    club.transfers_in.forEach((transfer) => {
      if (transfer.window) windows.add(String(transfer.window).toLowerCase());
    });
    club.transfers_out.forEach((transfer) => {
      if (transfer.window) windows.add(String(transfer.window).toLowerCase());
    });
  });

  const windowList = [...windows];
  const windowText =
    windowList.length === 0
      ? "Window not tagged"
      : windowList.length === 1
        ? `${capitalize(windowList[0])} window`
        : `${windowList.map(capitalize).join(" + ")} windows`;

  const leagueText = state.league === "All" ? scope.league || "All leagues" : state.league;
  const seasonText = state.season === "All" ? scope.season || "All seasons" : state.season;

  elements.periodBadge.textContent = `${leagueText} ${seasonText} | ${windowText}`;
};

const renderTrendChart = () => {
  const rankedClubs = [...state.filtered].sort((a, b) => b.netTransferCost - a.netTransferCost);
  const maxAbsNet = rankedClubs.reduce((max, club) => Math.max(max, Math.abs(club.netTransferCost)), 0) || 1;

  elements.spendChart.innerHTML = rankedClubs
    .map((club) => {
      const absoluteShare = (Math.abs(club.netTransferCost) / maxAbsNet) * 50;
      const width = Math.max(2, absoluteShare);
      const left = club.netTransferCost >= 0 ? 50 : 50 - width;
      const trendClass = club.netTransferCost >= 0 ? "buy" : "sell";
      const transferTag = club.netTransferCost < 0 ? "Net revenue surplus" : "Net spend";
      return `
        <div class="trend-row">
          <div class="trend-name">${club.team_name}<span class="trend-meta">${transferTag} | Wage share ${formatPercent(
            club.wageShareOfCommitment
          )}</span></div>
          <div class="trend-track"><span class="trend-fill ${trendClass}" style="left:${left}%;width:${width}%"></span></div>
          <div class="trend-value">${formatMoney(club.netTransferCost, state.currency)}</div>
        </div>
      `;
    })
    .join("");
};

const renderFindings = () => {
  if (!state.filtered.length) {
    elements.findingsGrid.innerHTML = "";
    return;
  }

  const bySpend = [...state.filtered].sort((a, b) => b.totalSpend - a.totalSpend);
  const byNetTransfer = [...state.filtered].sort((a, b) => b.netTransferCost - a.netTransferCost);
  const byCoverage = [...state.filtered].sort((a, b) => a.contractCoverage - b.contractCoverage);
  const byWageShare = [...state.filtered].sort((a, b) => b.wageShareOfCommitment - a.wageShareOfCommitment);

  const highestSpend = bySpend[0];
  const highestNetBuyer = byNetTransfer[0];
  const highestNetSeller = byNetTransfer[byNetTransfer.length - 1];
  const lowestCoverage = byCoverage[0];
  const highestWageShare = byWageShare[0];

  const cards = [
    {
      label: "Highest Total Spend",
      value: `${highestSpend.team_name} ${formatMoney(highestSpend.totalSpend, state.currency)}`,
      note: `Wages ${formatMoney(highestSpend.wageBill, state.currency)} and net transfers ${formatMoney(
        highestSpend.netTransferCost,
        state.currency
      )}.`,
    },
    {
      label: "Most Aggressive Net Buyer",
      value: `${highestNetBuyer.team_name} ${formatMoney(highestNetBuyer.netTransferCost, state.currency)}`,
      note: `${highestNetBuyer.assumedDeals} assumed deals across ${highestNetBuyer.incomingCount} incomings.`,
    },
    {
      label: "Largest Net Seller",
      value: `${highestNetSeller.team_name} ${formatMoney(highestNetSeller.netTransferCost, state.currency)}`,
      note: `Transfer-outs currently offset spend by ${formatMoney(
        Math.abs(highestNetSeller.netTransferCost),
        state.currency
      )}.`,
    },
    {
      label: "Highest Assumption Risk",
      value: `${lowestCoverage.team_name} ${formatPercent(lowestCoverage.contractCoverage)} coverage`,
      note: `${lowestCoverage.assumedDeals} assumed contract lengths.`,
    },
    {
      label: "Most Wage-Led Cost Base",
      value: `${highestWageShare.team_name} ${formatPercent(highestWageShare.wageShareOfCommitment)}`,
      note: "Share of wages in wage + amortized transfer commitment.",
    },
  ];

  elements.findingsGrid.innerHTML = cards
    .map(
      (card) => `
        <article class="finding-card">
          <p class="finding-label">${card.label}</p>
          <p class="finding-value">${card.value}</p>
          <p class="finding-note">${card.note}</p>
        </article>
      `
    )
    .join("");
};

const renderQualitySurface = () => {
  const rows = [...state.filtered]
    .map((club) => {
      const assumptionRate = club.incomingCount ? club.assumedDeals / club.incomingCount : 0;
      const pressure = assumptionRate * Math.max(club.incomingCount, 1);
      return { ...club, assumptionRate, pressure };
    })
    .sort((a, b) => b.pressure - a.pressure || a.contractCoverage - b.contractCoverage)
    .slice(0, 10);

  elements.qualityRows.innerHTML = rows
    .map((club) => {
      const coverageWidth = Math.round(Math.max(club.contractCoverage, 0.04) * 100);
      return `
        <div class="quality-row">
          <div class="quality-top">
            <div class="quality-name">${club.team_name}</div>
            <div class="quality-metrics">
              <span>Coverage ${formatPercent(club.contractCoverage)}</span>
              <span>Assumed ${club.assumedDeals}/${club.incomingCount}</span>
            </div>
          </div>
          <div class="quality-track"><span class="quality-fill" style="width:${coverageWidth}%"></span></div>
        </div>
      `;
    })
    .join("");
};

const renderDetail = () => {
  if (!state.filtered.length) {
    elements.detailClubName.textContent = "Club Player Drilldown";
    elements.detailSubtitle.textContent = "No clubs in current filter.";
    elements.detailCoveragePill.textContent = "Coverage --";
    elements.detailAssumedPill.textContent = "Assumed --";
    elements.detailSpendPill.textContent = "Spend --";
    elements.detailIncomingBody.innerHTML = '<tr><td class="detail-empty" colspan="5">No incoming transfers.</td></tr>';
    elements.detailOutgoingBody.innerHTML = '<tr><td class="detail-empty" colspan="4">No outgoing transfers.</td></tr>';
    return;
  }

  const defaultClub = state.filtered[0];
  const selectedClub = state.filtered.find((club) => club.team_id === state.detailClubId) || defaultClub;
  state.detailClubId = selectedClub.team_id;

  const fx = computeFx(state.currency);

  elements.detailClubName.textContent = `${selectedClub.team_name} Player Drilldown`;
  elements.detailSubtitle.textContent =
    "Player-level transfer fees and contract-length confidence used for amortized spend.";
  elements.detailCoveragePill.textContent = `Coverage ${formatPercent(selectedClub.contractCoverage)}`;
  elements.detailAssumedPill.textContent = `Assumed ${selectedClub.assumedDeals}/${selectedClub.incomingCount}`;
  elements.detailSpendPill.textContent = `Total ${formatMoney(selectedClub.totalSpend, state.currency)}`;

  const incomingRows = selectedClub.transfers_in
    .map((transfer) => {
      const fee = formatMoney((transfer.fee || 0) * fx, state.currency);
      return `
        <tr>
          <td>${transfer.player}</td>
          <td>${fee}</td>
          <td>${transfer.contract_years || "--"}</td>
          <td>${confidenceLabel(transfer.contract_confidence)}</td>
          <td>${transfer.is_loan ? "Yes" : "No"}</td>
        </tr>
      `;
    })
    .join("");

  const outgoingRows = selectedClub.transfers_out
    .map((transfer) => {
      const fee = formatMoney((transfer.fee || 0) * fx, state.currency);
      return `
        <tr>
          <td>${transfer.player}</td>
          <td>${fee}</td>
          <td>${transfer.window || "--"}</td>
          <td>${transfer.is_loan ? "Yes" : "No"}</td>
        </tr>
      `;
    })
    .join("");

  elements.detailIncomingBody.innerHTML =
    incomingRows || '<tr><td class="detail-empty" colspan="5">No incoming transfers.</td></tr>';
  elements.detailOutgoingBody.innerHTML =
    outgoingRows || '<tr><td class="detail-empty" colspan="4">No outgoing transfers.</td></tr>';
};

const renderTable = () => {
  hideHoverTooltip();
  elements.table.innerHTML = state.filtered
    .map((club) => {
      const checked = state.selected.has(club.team_id);
      const coverageClassName = coverageClass(club.contractCoverage);
      const isDetail = state.detailClubId === club.team_id;
      return `
        <tr data-hover-id="${club.team_id}" ${isDetail ? 'style="background:#fff7eb;"' : ""}>
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
          <td>${club.assumedDeals}</td>
          <td><button class="mini-btn drill-btn" data-drill-id="${club.team_id}">View players</button></td>
        </tr>
      `;
    })
    .join("");

  bindSelectionInputs(elements.table);
  bindDrillButtons(elements.table);
  bindHoverTargets(elements.table);
};

const renderMobileCards = () => {
  elements.mobileCards.innerHTML = state.filtered
    .map((club) => {
      const checked = state.selected.has(club.team_id);
      const coverageClassName = coverageClass(club.contractCoverage);
      const isDetail = state.detailClubId === club.team_id;

      return `
        <article class="mobile-club-card" ${isDetail ? 'style="border-color:#e3bca4;"' : ""}>
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
            <div class="mobile-metric">
              <span class="mobile-metric-label">Assumed Deals</span>
              <span class="mobile-metric-value">${club.assumedDeals} / ${club.incomingCount}</span>
            </div>
          </div>
          <div style="margin-top:10px;">
            <button class="mini-btn drill-btn" data-drill-id="${club.team_id}">View player table</button>
          </div>
        </article>
      `;
    })
    .join("");

  bindSelectionInputs(elements.mobileCards);
  bindDrillButtons(elements.mobileCards);
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

const bindQuickNav = () => {
  const links = [...elements.quickNav.querySelectorAll(".quick-link")];
  if (links.length) {
    links[0].classList.add("active");
  }

  elements.quickNav.querySelectorAll(".quick-link").forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.dataset.target;
      const target = document.getElementById(targetId);
      if (!target) return;

      elements.quickNav.querySelectorAll(".quick-link").forEach((link) => link.classList.remove("active"));
      button.classList.add("active");

      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
};

const render = () => {
  applyFilters();
  renderPeriodBadge();
  renderSummary();
  renderFindings();
  renderQualitySurface();
  renderTrendChart();
  renderTable();
  renderMobileCards();
  renderDetail();
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

  if (supportsHover) {
    window.addEventListener("scroll", hideHoverTooltip, true);
    window.addEventListener("resize", hideHoverTooltip);
  }
};

bindEvents();
bindQuickNav();
loadData().catch((error) => {
  elements.lastUpdated.textContent = error.message;
});
