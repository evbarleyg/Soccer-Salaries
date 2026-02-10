const DATA_URL = "./data/teams.json";
const FILTERS_COLLAPSED_KEY = "true_spend_filters_collapsed";
const OVERVIEW_README_OPEN_KEY = "true_spend_overview_readme_open";
const THEME_KEY = "true_spend_theme";

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
  clubFilter: new Set(),
  clubFilterInitialized: false,
  clubFilterSearch: "",
  detailClubId: null,
  currency: "GBP",
  transferMode: "pnl_proxy",
  league: "All",
  season: "All",
  sortBy: "totalSpendMetric",
  sortDir: "desc",
  detailIncomingSort: { key: "fee", dir: "desc" },
  detailOutgoingSort: { key: "fee", dir: "desc" },
  detailEconomicsSort: { key: "annual_total_cost", dir: "desc" },
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
  detailClubSelect: document.getElementById("detailClubSelect"),
  detailCoveragePill: document.getElementById("detailCoveragePill"),
  detailAssumedPill: document.getElementById("detailAssumedPill"),
  detailSpendPill: document.getElementById("detailSpendPill"),
  detailIncomingBody: document.getElementById("detailIncomingBody"),
  detailOutgoingBody: document.getElementById("detailOutgoingBody"),
  detailEconomicsBody: document.getElementById("detailEconomicsBody"),
  summary: document.getElementById("summaryCards"),
  periodBadge: document.getElementById("periodBadge"),
  compareCards: document.getElementById("compareCards"),
  compareHint: document.getElementById("compareHint"),
  overviewHelpWrap: document.getElementById("overviewHelpWrap"),
  overviewHelpBtn: document.getElementById("overviewHelpBtn"),
  overviewHelpTooltip: document.getElementById("overviewHelpTooltip"),
  overviewHelpClose: document.getElementById("overviewHelpClose"),
  overviewReadmeToggle: document.getElementById("overviewReadmeToggle"),
  overviewReadmeBody: document.getElementById("overviewReadmeBody"),
  leagueControl: document.getElementById("leagueControl"),
  leagueSelect: document.getElementById("leagueSelect"),
  seasonSelect: document.getElementById("seasonSelect"),
  filtersPanel: document.getElementById("filtersPanel"),
  toggleFiltersBtn: document.getElementById("toggleFiltersBtn"),
  currencySelect: document.getElementById("currencySelect"),
  sortSelect: document.getElementById("sortSelect"),
  viewModeSelect: document.getElementById("viewModeSelect"),
  clubControl: document.getElementById("clubControl"),
  clubFilterTrigger: document.getElementById("clubFilterTrigger"),
  clubFilterMenu: document.getElementById("clubFilterMenu"),
  clubFilterSearch: document.getElementById("clubFilterSearch"),
  clubFilterAllBtn: document.getElementById("clubFilterAllBtn"),
  clubFilterClearBtn: document.getElementById("clubFilterClearBtn"),
  clubFilterOptions: document.getElementById("clubFilterOptions"),
  lastUpdated: document.getElementById("lastUpdated"),
  themeToggle: document.getElementById("themeToggle"),
  refreshBtn: document.getElementById("refreshBtn"),
  trendHint: document.getElementById("trendHint"),
  transferInHeader: document.getElementById("transferInHeader"),
  transferOutHeader: document.getElementById("transferOutHeader"),
  netHeader: document.getElementById("netHeader"),
  totalHeader: document.getElementById("totalHeader"),
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

const defaultSortDir = (key) => {
  if (["team_name", "player", "window", "contract_confidence"].includes(key)) return "asc";
  return "desc";
};

const compareValues = (a, b, key, dir) => {
  const left = a?.[key];
  const right = b?.[key];
  let result = 0;

  if (typeof left === "string" || typeof right === "string") {
    result = String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base" });
  } else if (typeof left === "boolean" || typeof right === "boolean") {
    result = Number(Boolean(left)) - Number(Boolean(right));
  } else {
    result = (Number(left) || 0) - (Number(right) || 0);
  }

  return dir === "asc" ? result : -result;
};

const transferViewConfig = () => {
  if (state.transferMode === "cash") {
    return {
      transferInLabel: "Gross Transfers In",
      transferOutLabel: "Transfer-Out Fees",
      netLabel: "Net Transfer Cash",
      totalLabel: "Cash Spend",
      trendHint: "Solid bars show net transfer cash. Positive is net cash spend, negative is net cash sales.",
      methodologyNote:
        "Cash view uses full transfer fees in and out in the selected season/window and does not amortize incoming fees.",
    };
  }

  return {
    transferInLabel: "Active Amortized Transfers In",
    transferOutLabel: "Transfer-Out Fees",
    netLabel: "Net Transfer Cost",
    totalLabel: "Total Spend",
    trendHint:
      "Solid bars show net transfer cost proxy. Positive is spend, negative is transfer revenue surplus.",
    methodologyNote:
      "P&L proxy view uses active annual amortization (current + prior windows still on books) and offsets with full transfer-out fees (book value of sold players is not modeled).",
  };
};

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const deriveClub = (club, fx) => {
  const grossTransfersIn = club.transfers_in.reduce((sum, transfer) => sum + transfer.fee, 0);
  const fallbackAmortizedCurrent = club.transfers_in.reduce((sum, transfer) => {
    const years = transfer.contract_years || 4;
    return sum + transfer.fee / years;
  }, 0);
  const amortizationSummary = club.amortization_summary || {};
  const amortizedCurrent = Number(amortizationSummary.annual_current_window ?? fallbackAmortizedCurrent);
  const amortizedCarryover = Number(amortizationSummary.annual_prior_windows ?? 0);
  const amortizedTransfers = Number(amortizationSummary.annual_total_assets ?? amortizedCurrent + amortizedCarryover);

  const transferOutRevenue = club.transfers_out.reduce((sum, transfer) => sum + transfer.fee, 0);
  const netTransferCost = amortizedTransfers - transferOutRevenue;
  const grossNetTransfers = grossTransfersIn - transferOutRevenue;

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
    grossTransfersIn: grossTransfersIn * fx,
    amortizedTransfers: amortizedTransfers * fx,
    amortizedCurrent: amortizedCurrent * fx,
    amortizedCarryover: amortizedCarryover * fx,
    transferOutRevenue: transferOutRevenue * fx,
    netTransferCost: netTransferCost * fx,
    grossNetTransfers: grossNetTransfers * fx,
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
    .filter((club) => state.clubFilter.has(club.team_id))
    .map((club) => {
      const derived = deriveClub(club, fx);
      const transferInMetric = state.transferMode === "cash" ? derived.grossTransfersIn : derived.amortizedTransfers;
      const netTransferMetric = state.transferMode === "cash" ? derived.grossNetTransfers : derived.netTransferCost;
      const totalSpendMetric = derived.wageBill + netTransferMetric;
      return {
        ...derived,
        transferInMetric,
        netTransferMetric,
        totalSpendMetric,
      };
    })
    .sort((a, b) => compareValues(a, b, state.sortBy, state.sortDir));
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

let overviewHelpPinned = false;
const showOverviewHelp = () => {
  elements.overviewHelpTooltip.classList.add("visible");
  elements.overviewHelpTooltip.setAttribute("aria-hidden", "false");
  elements.overviewHelpBtn.setAttribute("aria-expanded", "true");
};

const hideOverviewHelp = (force = false) => {
  if (overviewHelpPinned && !force) return;
  elements.overviewHelpTooltip.classList.remove("visible");
  elements.overviewHelpTooltip.setAttribute("aria-hidden", "true");
  elements.overviewHelpBtn.setAttribute("aria-expanded", "false");
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
  const view = transferViewConfig();
  const net = formatMoney(club.netTransferMetric, state.currency);
  const inRows = hoverRows(club, fx, "in");
  const outRows = hoverRows(club, fx, "out");

  elements.hoverTooltip.innerHTML = `
    <p class="hover-title">${escapeHtml(club.team_name)}</p>
    <p class="hover-sub">${view.netLabel} ${net} | Coverage ${coverage}</p>
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
      renderTable();
      renderMobileCards();
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

const setFiltersCollapsed = (collapsed) => {
  elements.filtersPanel.classList.toggle("collapsed", collapsed);
  elements.toggleFiltersBtn.setAttribute("aria-expanded", String(!collapsed));
  elements.toggleFiltersBtn.textContent = collapsed ? "Expand Filters" : "Collapse Filters";
  if (collapsed) {
    toggleClubFilterMenu(false);
  }
  localStorage.setItem(FILTERS_COLLAPSED_KEY, collapsed ? "1" : "0");
};

const setOverviewReadmeOpen = (open) => {
  elements.overviewReadmeBody.toggleAttribute("hidden", !open);
  elements.overviewReadmeToggle.setAttribute("aria-expanded", String(open));
  elements.overviewReadmeToggle.textContent = open ? "Hide detail" : "Click for more detail";
  localStorage.setItem(OVERVIEW_README_OPEN_KEY, open ? "1" : "0");
};

const applyTheme = (theme) => {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", normalized);
  elements.themeToggle.textContent = normalized === "dark" ? "Day Mode" : "Night Mode";
  elements.themeToggle.setAttribute("aria-pressed", String(normalized === "dark"));
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    themeColorMeta.setAttribute("content", normalized === "dark" ? "#0d1426" : "#f4f0ea");
  }
};

const initializeTheme = () => {
  const storedTheme = localStorage.getItem(THEME_KEY);
  if (storedTheme === "light" || storedTheme === "dark") {
    applyTheme(storedTheme);
    return;
  }
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(prefersDark ? "dark" : "light");
};

const scopedClubs = () =>
  (state.raw?.clubs || [])
    .filter((club) => (state.league === "All" ? true : club.league === state.league))
    .filter((club) => (state.season === "All" ? true : club.season === state.season))
    .sort((a, b) => a.team_name.localeCompare(b.team_name, undefined, { sensitivity: "base" }));

const syncClubFilterSelection = ({ forceAll = false } = {}) => {
  const clubs = scopedClubs();
  const scopedIds = new Set(clubs.map((club) => club.team_id));

  if (forceAll || !state.clubFilterInitialized) {
    state.clubFilter = new Set(scopedIds);
    state.clubFilterInitialized = true;
    return clubs;
  }

  const previousCount = state.clubFilter.size;
  const next = new Set([...state.clubFilter].filter((id) => scopedIds.has(id)));

  if (previousCount > 0 && next.size === 0 && scopedIds.size > 0) {
    state.clubFilter = new Set(scopedIds);
  } else {
    state.clubFilter = next;
  }

  return clubs;
};

const renderClubFilter = () => {
  const clubs = syncClubFilterSelection();

  const search = state.clubFilterSearch.trim().toLowerCase();
  const visible = clubs.filter((club) => club.team_name.toLowerCase().includes(search));
  const selectedCount = state.clubFilter.size;
  const scopedCount = clubs.length;
  const allSelected = scopedCount > 0 && selectedCount === scopedCount;

  elements.clubFilterTrigger.textContent =
    scopedCount === 0
      ? "No clubs available"
      : allSelected
      ? `All clubs (${scopedCount})`
      : selectedCount === 0
        ? "No clubs selected"
      : selectedCount === 1
        ? `${clubs.find((club) => state.clubFilter.has(club.team_id))?.team_name || "1 club"}`
        : `${selectedCount} clubs selected`;

  if (!visible.length) {
    elements.clubFilterOptions.innerHTML = '<p class="multi-select-empty">No clubs match that search.</p>';
    return;
  }

  elements.clubFilterOptions.innerHTML = visible
    .map((club) => {
      const checked = state.clubFilter.has(club.team_id);
      return `
        <label class="multi-option">
          <input type="checkbox" data-club-filter-id="${club.team_id}" ${checked ? "checked" : ""} />
          <span>${escapeHtml(club.team_name)}</span>
        </label>
      `;
    })
    .join("");
};

const toggleClubFilterMenu = (open) => {
  const shouldOpen = typeof open === "boolean" ? open : elements.clubFilterMenu.hasAttribute("hidden");
  if (shouldOpen) {
    elements.clubFilterMenu.removeAttribute("hidden");
    elements.clubFilterTrigger.setAttribute("aria-expanded", "true");
    elements.filtersPanel.classList.add("club-menu-open");
  } else {
    elements.clubFilterMenu.setAttribute("hidden", "");
    elements.clubFilterTrigger.setAttribute("aria-expanded", "false");
    elements.filtersPanel.classList.remove("club-menu-open");
  }
};

const renderTableSortState = () => {
  document.querySelectorAll(".sort-btn[data-sort]").forEach((button) => {
    const isActive = button.dataset.sort === state.sortBy;
    button.classList.toggle("active", isActive);
    button.dataset.dir = isActive ? state.sortDir : "";
    button.setAttribute("aria-sort", isActive ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
  });
};

const renderDetailSortState = () => {
  document.querySelectorAll(".detail-sort-btn[data-detail-sort]").forEach((button) => {
    const isActive = button.dataset.detailSort === state.detailIncomingSort.key;
    button.classList.toggle("active", isActive);
    button.dataset.dir = isActive ? state.detailIncomingSort.dir : "";
  });

  document.querySelectorAll(".outgoing-sort-btn[data-outgoing-sort]").forEach((button) => {
    const isActive = button.dataset.outgoingSort === state.detailOutgoingSort.key;
    button.classList.toggle("active", isActive);
    button.dataset.dir = isActive ? state.detailOutgoingSort.dir : "";
  });

  document.querySelectorAll(".econ-sort-btn[data-econ-sort]").forEach((button) => {
    const isActive = button.dataset.econSort === state.detailEconomicsSort.key;
    button.classList.toggle("active", isActive);
    button.dataset.dir = isActive ? state.detailEconomicsSort.dir : "";
  });
};

const renderSummary = () => {
  const view = transferViewConfig();
  const totalSpend = state.filtered.reduce((sum, club) => sum + club.totalSpendMetric, 0);
  const totalWages = state.filtered.reduce((sum, club) => sum + club.wageBill, 0);
  const totalNetTransfer = state.filtered.reduce((sum, club) => sum + club.netTransferMetric, 0);
  const incoming = state.filtered.reduce((sum, club) => sum + club.incomingCount, 0);
  const reported = state.filtered.reduce((sum, club) => sum + club.reportedContracts, 0);
  const coverage = incoming ? reported / incoming : 1;

  const cards = [
    {
      label: view.totalLabel,
      value: formatMoney(totalSpend, state.currency),
      hint: `Across ${state.filtered.length} clubs`,
    },
    {
      label: "Total Wages",
      value: formatMoney(totalWages, state.currency),
      hint: "Estimated gross wage bill",
    },
    {
      label: view.netLabel,
      value: formatMoney(totalNetTransfer, state.currency),
      hint:
        state.transferMode === "cash"
          ? "Gross transfers in minus transfer-out fees"
          : "Active amortization (current + carryover) minus transfer-out fees",
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

const renderTransferViewLabels = () => {
  const view = transferViewConfig();
  elements.transferInHeader.textContent = view.transferInLabel;
  elements.transferOutHeader.textContent = view.transferOutLabel;
  elements.netHeader.textContent = view.netLabel;
  elements.totalHeader.textContent = view.totalLabel;
  elements.trendHint.textContent = view.trendHint;

  const totalOption = elements.sortSelect.querySelector('option[value="totalSpendMetric"]');
  const netOption = elements.sortSelect.querySelector('option[value="netTransferMetric"]');
  const inOption = elements.sortSelect.querySelector('option[value="transferInMetric"]');
  if (totalOption) totalOption.textContent = view.totalLabel;
  if (netOption) netOption.textContent = view.netLabel;
  if (inOption) inOption.textContent = view.transferInLabel;
};

const renderTrendChart = () => {
  const rankedClubs = [...state.filtered].sort((a, b) => b.netTransferMetric - a.netTransferMetric);
  const maxAbsNet = rankedClubs.reduce((max, club) => Math.max(max, Math.abs(club.netTransferMetric)), 0) || 1;

  elements.spendChart.innerHTML = rankedClubs
    .map((club) => {
      const absoluteShare = (Math.abs(club.netTransferMetric) / maxAbsNet) * 50;
      const width = Math.max(2, absoluteShare);
      const left = club.netTransferMetric >= 0 ? 50 : 50 - width;
      const trendClass = club.netTransferMetric >= 0 ? "buy" : "sell";
      const transferTag = club.netTransferMetric < 0 ? "Net revenue surplus" : "Net spend";
      return `
        <div class="trend-row">
          <div class="trend-name">${club.team_name}<span class="trend-meta">${transferTag} | Wage share ${formatPercent(
            club.wageShareOfCommitment
          )}</span></div>
          <div class="trend-track"><span class="trend-fill ${trendClass}" style="left:${left}%;width:${width}%"></span></div>
          <div class="trend-value">${formatMoney(club.netTransferMetric, state.currency)}</div>
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

  const view = transferViewConfig();
  const bySpend = [...state.filtered].sort((a, b) => b.totalSpendMetric - a.totalSpendMetric);
  const byNetTransfer = [...state.filtered].sort((a, b) => b.netTransferMetric - a.netTransferMetric);
  const byCoverage = [...state.filtered].sort((a, b) => a.contractCoverage - b.contractCoverage);
  const byWageShare = [...state.filtered].sort((a, b) => b.wageShareOfCommitment - a.wageShareOfCommitment);

  const highestSpend = bySpend[0];
  const highestNetBuyer = byNetTransfer[0];
  const highestNetSeller = byNetTransfer[byNetTransfer.length - 1];
  const lowestCoverage = byCoverage[0];
  const highestWageShare = byWageShare[0];

  const cards = [
    {
      label: `Highest ${view.totalLabel}`,
      value: `${highestSpend.team_name} ${formatMoney(highestSpend.totalSpendMetric, state.currency)}`,
      note: `Wages ${formatMoney(highestSpend.wageBill, state.currency)} and ${view.netLabel.toLowerCase()} ${formatMoney(
        highestSpend.netTransferMetric,
        state.currency
      )}.`,
    },
    {
      label: "Most Aggressive Net Buyer",
      value: `${highestNetBuyer.team_name} ${formatMoney(highestNetBuyer.netTransferMetric, state.currency)}`,
      note: `${highestNetBuyer.assumedDeals} assumed deals across ${highestNetBuyer.incomingCount} incomings.`,
    },
    {
      label: "Largest Net Seller",
      value: `${highestNetSeller.team_name} ${formatMoney(highestNetSeller.netTransferMetric, state.currency)}`,
      note: `Transfer-outs currently offset spend by ${formatMoney(
        Math.abs(highestNetSeller.netTransferMetric),
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
    .slice(0, 20);

  if (!rows.length) {
    elements.qualityRows.innerHTML = '<tr><td class="detail-empty" colspan="6">No quality rows in current filter.</td></tr>';
    return;
  }

  elements.qualityRows.innerHTML = rows
    .map((club) => {
      return `
        <tr>
          <td>${club.team_name}</td>
          <td><span class="coverage ${coverageClass(club.contractCoverage)}">${formatPercent(club.contractCoverage)}</span></td>
          <td>${club.assumedDeals}</td>
          <td>${club.incomingCount}</td>
          <td>${formatPercent(club.assumptionRate || 0)}</td>
          <td>${(club.pressure || 0).toFixed(1)}</td>
        </tr>
      `;
    })
    .join("");
};

const renderDetail = () => {
  if (!state.filtered.length) {
    elements.detailClubName.textContent = "Club Player Drilldown";
    elements.detailSubtitle.textContent = "No clubs in current filter.";
    elements.detailClubSelect.innerHTML = '<option value="">No clubs</option>';
    elements.detailClubSelect.value = "";
    elements.detailClubSelect.disabled = true;
    elements.detailCoveragePill.textContent = "Coverage --";
    elements.detailAssumedPill.textContent = "Assumed --";
    elements.detailSpendPill.textContent = "Spend --";
    elements.detailIncomingBody.innerHTML = '<tr><td class="detail-empty" colspan="5">No incoming transfers.</td></tr>';
    elements.detailOutgoingBody.innerHTML = '<tr><td class="detail-empty" colspan="4">No outgoing transfers.</td></tr>';
    elements.detailEconomicsBody.innerHTML = '<tr><td class="detail-empty" colspan="7">No player economics rows.</td></tr>';
    renderDetailSortState();
    return;
  }

  const defaultClub = state.filtered[0];
  const selectedClub = state.filtered.find((club) => club.team_id === state.detailClubId) || defaultClub;
  state.detailClubId = selectedClub.team_id;
  elements.detailClubSelect.disabled = false;
  elements.detailClubSelect.innerHTML = [...state.filtered]
    .sort((a, b) => a.team_name.localeCompare(b.team_name, undefined, { sensitivity: "base" }))
    .map((club) => `<option value="${club.team_id}">${escapeHtml(club.team_name)}</option>`)
    .join("");
  elements.detailClubSelect.value = selectedClub.team_id;

  const fx = computeFx(state.currency);

  elements.detailClubName.textContent = `${selectedClub.team_name} Player Drilldown`;
  elements.detailSubtitle.textContent =
    "Player-level view of transfers and annual player cost (wage + active amortization, including prior windows).";
  elements.detailCoveragePill.textContent = `Coverage ${formatPercent(selectedClub.contractCoverage)}`;
  elements.detailAssumedPill.textContent = `Assumed ${selectedClub.assumedDeals}/${selectedClub.incomingCount}`;
  elements.detailSpendPill.textContent = `Amortized ${formatMoney(selectedClub.amortizedTransfers, state.currency)}`;

  const incomingRows = [...selectedClub.transfers_in]
    .sort((a, b) => compareValues(a, b, state.detailIncomingSort.key, state.detailIncomingSort.dir))
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

  const outgoingRows = [...selectedClub.transfers_out]
    .sort((a, b) => compareValues(a, b, state.detailOutgoingSort.key, state.detailOutgoingSort.dir))
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

  const economicsRows = [...(selectedClub.amortization_assets || [])]
    .sort((a, b) => compareValues(a, b, state.detailEconomicsSort.key, state.detailEconomicsSort.dir))
    .map((asset) => {
      const annualWage =
        asset.annual_wage_gbp == null ? "--" : formatMoney((asset.annual_wage_gbp || 0) * fx, state.currency);
      const annualAmortization = formatMoney((asset.annual_amortization || 0) * fx, state.currency);
      const annualTotalCost = formatMoney((asset.annual_total_cost || 0) * fx, state.currency);
      const seasonStart = Number(asset.source_season || 0);
      const seasonLabel =
        seasonStart > 0 ? `${seasonStart}/${String(seasonStart + 1).slice(2)}` : String(asset.source_season || "--");
      return `
        <tr>
          <td>${asset.player || "--"}</td>
          <td>${annualWage}</td>
          <td>${annualAmortization}</td>
          <td>${annualTotalCost}</td>
          <td>${seasonLabel}</td>
          <td>${asset.years_remaining || "--"}</td>
          <td>${confidenceLabel(asset.contract_confidence)}</td>
        </tr>
      `;
    })
    .join("");

  elements.detailIncomingBody.innerHTML =
    incomingRows || '<tr><td class="detail-empty" colspan="5">No incoming transfers.</td></tr>';
  elements.detailOutgoingBody.innerHTML =
    outgoingRows || '<tr><td class="detail-empty" colspan="4">No outgoing transfers.</td></tr>';
  elements.detailEconomicsBody.innerHTML =
    economicsRows || '<tr><td class="detail-empty" colspan="7">No active amortization assets for this club.</td></tr>';
  renderDetailSortState();
};

const renderTable = () => {
  hideHoverTooltip();
  elements.table.innerHTML = state.filtered
    .map((club) => {
      const checked = state.selected.has(club.team_id);
      const coverageClassName = coverageClass(club.contractCoverage);
      const isDetail = state.detailClubId === club.team_id;
      const detailClassName = isDetail ? "is-detail-row" : "";
      return `
        <tr class="${detailClassName}" data-hover-id="${club.team_id}">
          <td>
            <label class="checkbox">
              <input type="checkbox" data-id="${club.team_id}" ${checked ? "checked" : ""} />
            </label>
          </td>
          <td>${club.team_name}</td>
          <td>${formatMoney(club.wageBill, state.currency)}</td>
          <td>${formatMoney(club.transferInMetric, state.currency)}</td>
          <td>${formatMoney(club.transferOutRevenue, state.currency)}</td>
          <td>${formatMoney(club.netTransferMetric, state.currency)}</td>
          <td>${formatMoney(club.totalSpendMetric, state.currency)}</td>
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
  renderTableSortState();
};

const renderMobileCards = () => {
  elements.mobileCards.innerHTML = state.filtered
    .map((club) => {
      const checked = state.selected.has(club.team_id);
      const coverageClassName = coverageClass(club.contractCoverage);
      const isDetail = state.detailClubId === club.team_id;
      const detailClassName = isDetail ? "is-detail-card" : "";

      return `
        <article class="mobile-club-card ${detailClassName}">
          <div class="mobile-club-head">
            <h4>${club.team_name}</h4>
            <label class="checkbox">
              <input type="checkbox" data-id="${club.team_id}" ${checked ? "checked" : ""} />
            </label>
          </div>
          <div class="mobile-club-grid">
            <div class="mobile-metric">
              <span class="mobile-metric-label">${state.transferMode === "cash" ? "Cash Spend" : "Total Spend"}</span>
              <span class="mobile-metric-value">${formatMoney(club.totalSpendMetric, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">Wages</span>
              <span class="mobile-metric-value">${formatMoney(club.wageBill, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">${state.transferMode === "cash" ? "Gross In" : "Active Amortized In"}</span>
              <span class="mobile-metric-value">${formatMoney(club.transferInMetric, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">Transfer Out</span>
              <span class="mobile-metric-value">${formatMoney(club.transferOutRevenue, state.currency)}</span>
            </div>
            <div class="mobile-metric">
              <span class="mobile-metric-label">Net Transfer</span>
              <span class="mobile-metric-value">${formatMoney(club.netTransferMetric, state.currency)}</span>
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

  const maxSpend = clubs.reduce((max, club) => Math.max(max, club.totalSpendMetric), 0) || 1;

  elements.compareCards.innerHTML = clubs
    .map((club) => {
      const width = Math.round((club.totalSpendMetric / maxSpend) * 100);
      return `
        <div class="compare-card">
          <h4>${club.team_name}</h4>
          <div class="compare-metric">
            <span>${state.transferMode === "cash" ? "Cash Spend" : "Total Spend"}</span>
            <strong>${formatMoney(club.totalSpendMetric, state.currency)}</strong>
          </div>
          <div class="bar"><span style="width:${width}%"></span></div>
          <div class="compare-metric">
            <span>Wages</span>
            <span>${formatMoney(club.wageBill, state.currency)}</span>
          </div>
          <div class="compare-metric">
            <span>Net Transfers</span>
            <span>${formatMoney(club.netTransferMetric, state.currency)}</span>
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
  const view = transferViewConfig();

  elements.methodSummary.textContent = `${methodology.summary || ""} ${view.methodologyNote}`;
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

  syncClubFilterSelection({ forceAll: true });
  elements.sortSelect.value = state.sortBy;
  renderClubFilter();
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
  if (!state.raw) return;
  applyFilters();
  renderClubFilter();
  renderTransferViewLabels();
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
  const savedFiltersCollapsed = localStorage.getItem(FILTERS_COLLAPSED_KEY) === "1";
  const savedReadmeOpen = localStorage.getItem(OVERVIEW_README_OPEN_KEY) === "1";
  initializeTheme();
  setFiltersCollapsed(savedFiltersCollapsed);
  setOverviewReadmeOpen(savedReadmeOpen);

  elements.toggleFiltersBtn.addEventListener("click", () => {
    const collapsed = elements.filtersPanel.classList.contains("collapsed");
    setFiltersCollapsed(!collapsed);
  });

  elements.themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const nextTheme = isDark ? "light" : "dark";
    applyTheme(nextTheme);
    localStorage.setItem(THEME_KEY, nextTheme);
  });

  elements.overviewHelpBtn.addEventListener("mouseenter", () => {
    if (!overviewHelpPinned) showOverviewHelp();
  });

  elements.overviewHelpWrap.addEventListener("mouseleave", () => {
    hideOverviewHelp();
  });

  elements.overviewHelpBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    overviewHelpPinned = !overviewHelpPinned;
    if (overviewHelpPinned) {
      showOverviewHelp();
    } else {
      hideOverviewHelp(true);
    }
  });

  elements.overviewHelpClose.addEventListener("click", (event) => {
    event.stopPropagation();
    overviewHelpPinned = false;
    hideOverviewHelp(true);
  });

  elements.overviewReadmeToggle.addEventListener("click", () => {
    const isOpen = !elements.overviewReadmeBody.hasAttribute("hidden");
    setOverviewReadmeOpen(!isOpen);
  });

  elements.clubFilterTrigger.addEventListener("click", () => {
    toggleClubFilterMenu();
    if (!elements.clubFilterMenu.hasAttribute("hidden")) {
      elements.clubFilterSearch.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (!elements.overviewHelpWrap.contains(event.target)) {
      overviewHelpPinned = false;
      hideOverviewHelp(true);
    }
    if (!elements.clubControl.contains(event.target)) {
      toggleClubFilterMenu(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      overviewHelpPinned = false;
      hideOverviewHelp(true);
    }
  });

  elements.clubFilterSearch.addEventListener("input", (event) => {
    state.clubFilterSearch = event.target.value;
    renderClubFilter();
  });

  elements.clubFilterOptions.addEventListener("change", (event) => {
    const id = event.target.dataset.clubFilterId;
    if (!id) return;
    if (event.target.checked) {
      state.clubFilter.add(id);
    } else {
      state.clubFilter.delete(id);
    }
    render();
  });

  elements.clubFilterAllBtn.addEventListener("click", () => {
    state.clubFilter = new Set(scopedClubs().map((club) => club.team_id));
    render();
  });

  elements.clubFilterClearBtn.addEventListener("click", () => {
    state.clubFilter.clear();
    render();
  });

  elements.leagueSelect.addEventListener("change", (event) => {
    state.league = event.target.value;
    syncClubFilterSelection();
    render();
  });

  elements.seasonSelect.addEventListener("change", (event) => {
    state.season = event.target.value;
    syncClubFilterSelection();
    render();
  });

  elements.currencySelect.addEventListener("change", (event) => {
    state.currency = event.target.value;
    render();
  });

  elements.viewModeSelect.addEventListener("change", (event) => {
    state.transferMode = event.target.value;
    render();
  });

  elements.sortSelect.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    state.sortDir = defaultSortDir(state.sortBy);
    render();
  });

  elements.detailClubSelect.addEventListener("change", (event) => {
    state.detailClubId = event.target.value;
    renderTable();
    renderMobileCards();
    renderDetail();
  });

  document.querySelectorAll(".sort-btn[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (!key) return;
      if (state.sortBy === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortBy = key;
        state.sortDir = defaultSortDir(key);
      }
      elements.sortSelect.value = state.sortBy;
      render();
    });
  });

  document.querySelectorAll(".detail-sort-btn[data-detail-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.detailSort;
      if (!key) return;
      if (state.detailIncomingSort.key === key) {
        state.detailIncomingSort.dir = state.detailIncomingSort.dir === "asc" ? "desc" : "asc";
      } else {
        state.detailIncomingSort = { key, dir: defaultSortDir(key) };
      }
      renderDetail();
    });
  });

  document.querySelectorAll(".outgoing-sort-btn[data-outgoing-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.outgoingSort;
      if (!key) return;
      if (state.detailOutgoingSort.key === key) {
        state.detailOutgoingSort.dir = state.detailOutgoingSort.dir === "asc" ? "desc" : "asc";
      } else {
        state.detailOutgoingSort = { key, dir: defaultSortDir(key) };
      }
      renderDetail();
    });
  });

  document.querySelectorAll(".econ-sort-btn[data-econ-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.econSort;
      if (!key) return;
      if (state.detailEconomicsSort.key === key) {
        state.detailEconomicsSort.dir = state.detailEconomicsSort.dir === "asc" ? "desc" : "asc";
      } else {
        state.detailEconomicsSort = { key, dir: defaultSortDir(key) };
      }
      renderDetail();
    });
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
