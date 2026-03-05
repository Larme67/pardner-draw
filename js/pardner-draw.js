/* js/pardner-draw.js
   Pardner Draw — v9 (localStorage)
   ✅ Editable Hand value + Draw day + Cycle start (saved)
   ✅ Target weekly pot / Remaining funding / Progress bar (dashboard)
   ✅ Payees can have requested draw dates PER HAND (requestedDrawDates[])
   ✅ Prevent duplicate requested draw dates across ALL payees/hands
   ✅ Dashboard: “Next due draws” window (who + due date + hand #)
   ✅ Draw amount ALWAYS equals the selected week’s pot (readonly + enforced)
   ✅ Dashboard quick draw amount ALWAYS equals THIS week’s pot (readonly + enforced)
   ✅ Paid Out Summary table + fully paid rows green
   ✅ “Cycle Completed” banner (green) + Start New Cycle button
   ✅ Auto-lock when complete (blocks payments/draws until new cycle)
   ✅ Keeps payment/draw history by archiving cycles into History “spreadsheet” (CSV export)

   Requires your HTML:
   - Draw amount input should be readonly (recommended), but JS enforces anyway.
   - Dashboard quick draw amount input exists: #dashDrawAmount (JS enforces readonly anyway)
   - Next due table exists: #nextDueTable (tbody)
   - Paid out table exists: #paidOutTable (tbody)
   - History table exists: #historyTable (tbody) + optional #exportHistoryCsvBtn
*/

(() => {
  "use strict";

  const STORAGE_KEY = "pardner_draw_v9";
  const PAGES = ["dashboard", "payees", "payments", "draws", "weekly", "settings", "history"];
  const $ = (id) => document.getElementById(id);

  // -----------------------------
  // Helpers
  // -----------------------------
  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  const fmtGBP = (n) =>
    "£" + (Number(n || 0)).toLocaleString("en-GB", { maximumFractionDigits: 0 });

  function isoDate(d) {
    return new Date(d).toISOString().slice(0, 10);
  }

  function parseISODate(s) {
    if (!s) return null;
    const d = new Date(String(s) + "T00:00:00");
    return isNaN(d) ? null : d;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() + n);
    return x;
  }

  function uid(prefix = "id") {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  function safeNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clampInt(n, min) {
    return Math.max(min, Math.floor(safeNumber(n, min)));
  }

  function normalizeDateOrBlank(s) {
    const v = String(s || "").trim();
    if (!v) return "";
    return parseISODate(v) ? v : "";
  }

  function dayName(dow) {
    const map = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return map[((Number(dow) % 7) + 7) % 7];
  }

  function toast(title, msg) {
    const el = $("toast");
    if (!el) return;
    const t = $("toastTitle");
    const m = $("toastMsg");
    if (t) t.textContent = title;
    if (m) m.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2400);
  }

  function downloadText(filename, text, mime = "text/plain") {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // CSV helpers
  function csvEscape(v) {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  }
  function toCSV(rows) {
    return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  }

  // -----------------------------
  // State
  // -----------------------------
  function defaultState() {
    return {
      settings: {
        handValue: 50,
        payoutDow: 2, // Tuesday
        cycleStartDate: isoDate(new Date()),
        nLocked: 0,
        cycleLocked: false,
      },
      payees: [],
      contributions: [],
      draws: [],
      activity: [],
      history: [],
    };
  }

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const s = defaultState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        return s;
      }

      const s = JSON.parse(raw);
      if (!s || !s.settings || !Array.isArray(s.payees)) throw new Error("Bad state");

      s.contributions = Array.isArray(s.contributions) ? s.contributions : [];
      s.draws = Array.isArray(s.draws) ? s.draws : [];
      s.activity = Array.isArray(s.activity) ? s.activity : [];
      s.history = Array.isArray(s.history) ? s.history : [];

      // settings defaults
      s.settings.handValue = clampInt(s.settings.handValue, 1);
      s.settings.payoutDow = ((clampInt(s.settings.payoutDow, 0) % 7) + 7) % 7;
      s.settings.cycleStartDate = s.settings.cycleStartDate || isoDate(new Date());
      s.settings.nLocked = safeNumber(s.settings.nLocked, 0);
      s.settings.cycleLocked = !!s.settings.cycleLocked;

      // payees migrate requestedDrawDate -> requestedDrawDates[]
      s.payees = s.payees.map((p) => {
        const hands = clampInt(p.hands, 1);
        let arr = [];

        if (Array.isArray(p.requestedDrawDates)) {
          arr = p.requestedDrawDates.map(normalizeDateOrBlank);
        } else {
          arr = [normalizeDateOrBlank(p.requestedDrawDate || "")];
        }
        while (arr.length < hands) arr.push("");
        if (arr.length > hands) arr = arr.slice(0, hands);

        return {
          ...p,
          id: p.id || uid("p"),
          name: String(p.name || ""),
          hands,
          requestedDrawDates: arr,
          notes: String(p.notes || ""),
          hasDrawn: !!p.hasDrawn,
          drawDate: String(p.drawDate || ""),
          drawAmount: safeNumber(p.drawAmount, 0),
          createdAt: safeNumber(p.createdAt, Date.now()),
        };
      });

      // contributions ensure hands computed
      const hv = s.settings.handValue;
      s.contributions = s.contributions.map((c) => {
        const amount = safeNumber(c.amount, 0);
        const hands = Number.isFinite(Number(c.hands)) ? Number(c.hands) : amount / hv;
        return {
          ...c,
          id: c.id || uid("c"),
          payeeId: c.payeeId,
          date: String(c.date || ""),
          amount,
          hands,
          note: String(c.note || ""),
          createdAt: safeNumber(c.createdAt, Date.now()),
        };
      });

      // draws normalize
      s.draws = s.draws.map((d) => ({
        ...d,
        id: d.id || uid("d"),
        date: String(d.date || ""),
        handOwnerPayeeId: d.handOwnerPayeeId || d.payeeId || "",
        amount: safeNumber(d.amount, 0),
        note: String(d.note || ""),
        createdAt: safeNumber(d.createdAt, Date.now()),
      }));

      // history normalize minimal
      s.history = s.history.map((h) => ({
        id: h.id || uid("h"),
        title: String(h.title || "Archived cycle"),
        started: String(h.started || ""),
        ended: String(h.ended || ""),
        payoutDow: Number.isFinite(Number(h.payoutDow)) ? Number(h.payoutDow) : s.settings.payoutDow,
        handValue: clampInt(h.handValue, 1),
        payeeSnapshot: Array.isArray(h.payeeSnapshot) ? h.payeeSnapshot : [],
        contributions: Array.isArray(h.contributions) ? h.contributions : [],
        draws: Array.isArray(h.draws) ? h.draws : [],
        totals: h.totals || {},
        createdAt: safeNumber(h.createdAt, Date.now()),
      }));

      return s;
    } catch (e) {
      console.warn("Resetting state:", e);
      const s = defaultState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      return s;
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function logActivity(type, details) {
    state.activity.push({ id: uid("a"), at: Date.now(), type, details });
    if (state.activity.length > 200) state.activity = state.activity.slice(-200);
  }

  // -----------------------------
  // Settings getters
  // -----------------------------
  function handValue() {
    return clampInt(state.settings.handValue, 1);
  }
  function payoutDow() {
    return ((clampInt(state.settings.payoutDow, 0) % 7) + 7) % 7;
  }

  // -----------------------------
  // Duplicate requested-date prevention
  // -----------------------------
  function collectAllRequestedDates({ excludePayeeId = null } = {}) {
    // Map dateStr -> { payeeId, payeeName, index }
    const used = new Map();
    for (const p of state.payees) {
      if (excludePayeeId && p.id === excludePayeeId) continue;
      const arr = Array.isArray(p.requestedDrawDates) ? p.requestedDrawDates : [];
      arr.forEach((d, idx) => {
        const dateStr = normalizeDateOrBlank(d);
        if (!dateStr) return;
        if (!used.has(dateStr)) used.set(dateStr, { payeeId: p.id, payeeName: p.name, index: idx });
      });
    }
    return used;
  }

  function hasDuplicateDatesInArray(arr) {
    const set = new Set();
    for (const d of arr.map(normalizeDateOrBlank).filter(Boolean)) {
      if (set.has(d)) return true;
      set.add(d);
    }
    return false;
  }

  // -----------------------------
  // Lock / Completion
  // -----------------------------
  function totalCommittedHands() {
    return state.payees.reduce((sum, p) => sum + clampInt(p.hands, 1), 0);
  }
  function drawsCompleted() {
    return state.draws.length;
  }
  function drawsRemainingHands() {
    return Math.max(0, totalCommittedHands() - drawsCompleted());
  }
  function isCycleComplete() {
    return totalCommittedHands() > 0 && drawsRemainingHands() === 0;
  }
  function isCycleLocked() {
    return !!state.settings.cycleLocked;
  }
  function setCycleLocked(locked) {
    state.settings.cycleLocked = !!locked;
  }

  // -----------------------------
  // Schedule helpers
  // -----------------------------
  function isPayoutDay(d) {
    return d.getDay() === payoutDow();
  }
  function nextPayoutDay(from = new Date()) {
    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const target = payoutDow();
    const delta = (target - day + 7) % 7;
    if (delta === 0) return d;
    d.setDate(d.getDate() + delta);
    return d;
  }
  function thisPayoutDay() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return isPayoutDay(today) ? today : nextPayoutDay(today);
  }

  function weekBoundsForPayoutEnd(endStr) {
    const endDay = parseISODate(endStr);
    if (!endDay) return null;
    const end = new Date(endDay);
    end.setHours(23, 59, 59, 999);
    const start = addDays(endDay, -6);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }

  // -----------------------------
  // Cycle math / pots
  // -----------------------------
  function basePot() {
    return totalCommittedHands() * handValue(); // target weekly pot
  }
  function totalPaidAllTime() {
    return state.contributions.reduce((sum, c) => sum + safeNumber(c.amount, 0), 0);
  }
  function totalHandsPaidAllTime() {
    return totalPaidAllTime() / handValue();
  }

  function getCycleStartDate() {
    const d = parseISODate(state.settings.cycleStartDate);
    return d || thisPayoutDay();
  }
  function getCycleEndDateEstimated() {
    return addDays(getCycleStartDate(), totalCommittedHands() * 7);
  }
  function getLastPayoutDateEstimated() {
    return addDays(getCycleStartDate(), Math.max(0, (totalCommittedHands() - 1) * 7));
  }
  function getActualCycleEndDateFromDraws() {
    if (!state.draws.length) return null;
    const last = [...state.draws].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    return parseISODate(last?.date) ? last.date : null;
  }

  function validMultipleOfHandValue(amount) {
    const a = safeNumber(amount, NaN);
    const hv = handValue();
    return Number.isFinite(a) && a > 0 && a % hv === 0;
  }

  function contributionsInWeek(endStr) {
    const b = weekBoundsForPayoutEnd(endStr);
    if (!b) return [];
    return state.contributions.filter((c) => {
      const d = parseISODate(c.date);
      if (!d) return false;
      return d >= b.start && d <= b.end;
    });
  }

  function weekPotForEnd(endStr) {
    return contributionsInWeek(endStr).reduce((s, c) => s + safeNumber(c.amount, 0), 0);
  }

  function payeeTotals(payeeId) {
    const paid = state.contributions
      .filter((c) => c.payeeId === payeeId)
      .reduce((s, c) => s + safeNumber(c.amount, 0), 0);
    return { paid, handsPaid: paid / handValue() };
  }

  function payeeHandsPaidOut(payeeId) {
    return state.draws.filter((d) => d.handOwnerPayeeId === payeeId).length;
  }

  function payeeHandsRemaining(payeeId) {
    const p = state.payees.find((x) => x.id === payeeId);
    if (!p) return 0;
    return Math.max(0, clampInt(p.hands, 1) - payeeHandsPaidOut(payeeId));
  }

  function refreshPayeeDrawFlags() {
    for (const p of state.payees) {
      const committed = clampInt(p.hands, 1);
      const remaining = payeeHandsRemaining(p.id);
      p.hasDrawn = committed > 0 && remaining === 0;

      const last = state.draws
        .filter((d) => d.handOwnerPayeeId === p.id)
        .sort((a, b) => (b.date || "").localeCompare(a.date || "") || safeNumber(b.createdAt, 0) - safeNumber(a.createdAt, 0))[0];

      if (last) {
        p.drawDate = last.date;
        p.drawAmount = safeNumber(last.amount, 0);
      } else {
        p.drawDate = p.drawDate || "";
        p.drawAmount = safeNumber(p.drawAmount, 0);
      }
    }
  }

  // -----------------------------
  // Funding widgets (in header)
  // -----------------------------
  function ensureFundingWidgets() {
    const host = document.querySelector(".topbar-right") || $("page-dashboard");
    if (!host) return;
    if ($("fundingWidget")) return;

    const wrap = document.createElement("div");
    wrap.id = "fundingWidget";
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "8px";
    wrap.style.minWidth = "260px";

    const line = document.createElement("div");
    line.style.display = "flex";
    line.style.gap = "10px";
    line.style.flexWrap = "wrap";
    line.innerHTML = `
      <span class="pill" id="targetWeeklyPotPill">Target weekly pot: £0</span>
      <span class="pill warn" id="remainingFundingPill">Remaining funding: £0</span>
    `;

    const barOuter = document.createElement("div");
    barOuter.style.border = "1px solid rgba(148,163,184,.18)";
    barOuter.style.borderRadius = "999px";
    barOuter.style.height = "12px";
    barOuter.style.overflow = "hidden";
    barOuter.style.background = "rgba(2,6,23,.35)";

    const barInner = document.createElement("div");
    barInner.id = "fundingProgressBar";
    barInner.style.height = "100%";
    barInner.style.width = "0%";
    barInner.style.background = "rgba(56,189,248,.55)";
    barOuter.appendChild(barInner);

    const caption = document.createElement("div");
    caption.id = "fundingProgressText";
    caption.className = "muted";
    caption.style.fontSize = "12px";
    caption.textContent = "Progress: —";

    wrap.appendChild(line);
    wrap.appendChild(barOuter);
    wrap.appendChild(caption);

    host.appendChild(wrap);
  }

  function renderFundingWidgets({ weekPot, targetPot }) {
    ensureFundingWidgets();

    const target = Math.max(0, safeNumber(targetPot, 0));
    const pot = Math.max(0, safeNumber(weekPot, 0));
    const remaining = Math.max(0, target - pot);
    const pct = target > 0 ? Math.min(1, pot / target) : 0;

    const targetEl = $("targetWeeklyPotPill");
    const remEl = $("remainingFundingPill");
    const bar = $("fundingProgressBar");
    const txt = $("fundingProgressText");

    if (targetEl) targetEl.textContent = `Target weekly pot: ${fmtGBP(target)}`;
    if (remEl) {
      remEl.className = remaining === 0 ? "pill success" : "pill warn";
      remEl.textContent = `Remaining funding: ${fmtGBP(remaining)}`;
    }
    if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
    if (txt) txt.textContent = `Progress: ${Math.round(pct * 100)}% (${fmtGBP(pot)} / ${fmtGBP(target)})`;
  }

  // -----------------------------
  // Navigation
  // -----------------------------
  function showPage(page) {
    const safePage = PAGES.includes(page) ? page : "dashboard";

    PAGES.forEach((p) => {
      const el = $("page-" + p);
      if (!el) return;
      el.style.display = p === safePage ? "block" : "none";
    });

    document.querySelectorAll(".nav button[data-page]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.page === safePage);
    });

    const payoutName = dayName(payoutDow());
    const hv = handValue();

    const map = {
      dashboard: ["Dashboard", `Hands-based cycle • Payouts every ${payoutName}.`],
      payees: ["Payees", "Edit requested draw dates per hand (no duplicates allowed)."],
      payments: ["Add Payment", `Payments must be multiples of £${hv} (hands).`],
      draws: ["Record Draw", `Draw amount is auto-set to that week’s pot.`],
      weekly: ["Weekly Summary", `7-day window ending on ${payoutName}.`],
      settings: ["Settings", "Edit hand value, draw day, cycle start; export/import; reset."],
      history: ["History", "Archived cycles: export to CSV for spreadsheet use."],
    };

    if ($("pageTitle")) $("pageTitle").textContent = map[safePage]?.[0] || "Pardner Draw";
    if ($("pageSubtitle")) $("pageSubtitle").textContent = map[safePage]?.[1] || "";

    renderAll();
  }

  // -----------------------------
  // Payee Edit Modal
  // -----------------------------
  let editingPayeeId = null;

  function buildRequestedDatesInputs(count, existingArr) {
    const wrap = $("editPayeeReqDatesWrap");
    if (!wrap) return;

    const arr = Array.isArray(existingArr) ? existingArr.slice() : [];
    while (arr.length < count) arr.push("");
    if (arr.length > count) arr.length = count;

    wrap.innerHTML = "";

    for (let i = 0; i < count; i++) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "10px";
      row.style.alignItems = "center";

      const label = document.createElement("div");
      label.className = "muted";
      label.style.minWidth = "72px";
      label.textContent = `Hand ${i + 1}`;

      const input = document.createElement("input");
      input.type = "date";
      input.dataset.reqIndex = String(i);
      input.value = normalizeDateOrBlank(arr[i]);

      row.appendChild(label);
      row.appendChild(input);
      wrap.appendChild(row);
    }
  }

  function readRequestedDatesFromModal() {
    const wrap = $("editPayeeReqDatesWrap");
    if (!wrap) return [];
    const inputs = wrap.querySelectorAll("input[type='date'][data-req-index]");
    const arr = [];
    inputs.forEach((inp) => arr.push(normalizeDateOrBlank(inp.value)));
    return arr;
  }

  function openPayeeModal(payeeId) {
    const p = state.payees.find((x) => x.id === payeeId);
    if (!p) return;

    editingPayeeId = payeeId;
    $("editPayeeName") && ($("editPayeeName").value = p.name || "");
    $("editPayeeHands") && ($("editPayeeHands").value = String(clampInt(p.hands, 1)));
    $("editPayeeNotes") && ($("editPayeeNotes").value = p.notes || "");

    buildRequestedDatesInputs(clampInt(p.hands, 1), p.requestedDrawDates);

    const m = $("payeeModal");
    if (!m) return;
    m.style.display = "block";
    m.setAttribute("aria-hidden", "false");
    setTimeout(() => $("editPayeeName")?.focus(), 0);
  }

  function closePayeeModal() {
    editingPayeeId = null;
    const m = $("payeeModal");
    if (!m) return;
    m.style.display = "none";
    m.setAttribute("aria-hidden", "true");
  }

  function savePayeeModal() {
    if (!editingPayeeId) return;
    const p = state.payees.find((x) => x.id === editingPayeeId);
    if (!p) return;

    const name = ($("editPayeeName")?.value || "").trim();
    const hands = clampInt($("editPayeeHands")?.value, 1);
    const notes = ($("editPayeeNotes")?.value || "").trim();

    if (!name) return toast("Invalid", "Name cannot be blank.");

    let reqArr = readRequestedDatesFromModal().map(normalizeDateOrBlank);
    while (reqArr.length < hands) reqArr.push("");
    if (reqArr.length > hands) reqArr = reqArr.slice(0, hands);

    // 1) no duplicates inside same payee
    if (hasDuplicateDatesInArray(reqArr)) {
      return toast("Duplicate date", "This payee has the same requested date more than once. Each hand must have a different date.");
    }

    // 2) no duplicates across other payees
    const used = collectAllRequestedDates({ excludePayeeId: editingPayeeId });
    for (const d of reqArr.filter(Boolean)) {
      if (used.has(d)) {
        const who = used.get(d);
        return toast("Date already taken", `${d} is already requested by ${who.payeeName}. Pick a different date.`);
      }
    }

    p.name = name;
    p.hands = hands;
    p.notes = notes;
    p.requestedDrawDates = reqArr;

    logActivity("Payee edited", `${name} updated (hands: ${hands})`);
    saveState();
    closePayeeModal();
    renderAll();
    toast("Saved", `${name} updated`);
  }

  function onModalHandsChange() {
    if (!editingPayeeId) return;
    const hands = clampInt($("editPayeeHands")?.value, 1);
    const current = readRequestedDatesFromModal();
    buildRequestedDatesInputs(hands, current);
  }

  // -----------------------------
  // Cycle completed banner + lock + start new cycle
  // -----------------------------
  function renderCycleCompletedBanner() {
    const banner = $("cycleCompleteBanner");
    const dateEl = $("cycleCompleteDate");
    if (!banner || !dateEl) return;

    const complete = isCycleComplete();

    // auto-lock when complete
    if (complete && !isCycleLocked()) {
      setCycleLocked(true);
      logActivity("Cycle", "Cycle completed → auto-locked");
      saveState();
    }

    if (!complete) {
      banner.style.display = "none";
      return;
    }

    banner.style.display = "block";
    const actualEnd = getActualCycleEndDateFromDraws();
    dateEl.textContent = actualEnd || isoDate(getCycleEndDateEstimated());
  }

  function applyLockUI() {
    const locked = isCycleLocked();
    const idsToDisable = [
      "quickAddPayment",
      "quickRecordDraw",
      "savePaymentBtn",
      "saveDrawBtn",
      "dashRecordDraw",
      "paymentPayee",
      "paymentDate",
      "paymentAmount",
      "paymentNote",
      "drawDate",
      "drawPayee",
      "drawAmount",
      "drawNote",
      "dashRecipient",
      "dashDrawAmount",
    ];

    idsToDisable.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.disabled = locked;
      el.style.opacity = locked ? "0.6" : "1";
      el.style.pointerEvents = locked ? "none" : "auto";
      el.title = locked ? "Cycle is completed and locked. Start a new cycle to continue." : "";
    });
  }

  function archiveCurrentCycleAndReset() {
    const hv = handValue();
    const dow = payoutDow();

    const started = state.settings.cycleStartDate || "";
    const ended = getActualCycleEndDateFromDraws() || isoDate(getCycleEndDateEstimated());

    const payeeSnapshot = state.payees.map((p) => ({
      id: p.id,
      name: p.name,
      hands: clampInt(p.hands, 1),
      notes: p.notes || "",
      requestedDrawDates: Array.isArray(p.requestedDrawDates) ? p.requestedDrawDates.slice() : [],
    }));

    const totalContrib = state.contributions.reduce((s, c) => s + safeNumber(c.amount, 0), 0);
    const totalDrawsAmt = state.draws.reduce((s, d) => s + safeNumber(d.amount, 0), 0);

    const entry = {
      id: uid("h"),
      title: `Cycle ${started || "?"} → ${ended || "?"}`,
      started,
      ended,
      payoutDow: dow,
      handValue: hv,
      payeeSnapshot,
      contributions: state.contributions.map((c) => ({ ...c })),
      draws: state.draws.map((d) => ({ ...d })),
      totals: {
        committedHands: totalCommittedHands(),
        totalContributions: totalContrib,
        totalDraws: totalDrawsAmt,
      },
      createdAt: Date.now(),
    };

    state.history.unshift(entry);

    // Reset flow (keep roster)
    state.contributions = [];
    state.draws = [];
    state.settings.cycleStartDate = isoDate(thisPayoutDay());
    setCycleLocked(false);

    logActivity("Cycle", `New cycle started (${state.settings.cycleStartDate}); archived previous cycle`);
    saveState();
  }

  // -----------------------------
  // Rendering utilities
  // -----------------------------
  function populatePayeeSelects() {
    const hv = handValue();

    const paymentPayee = $("paymentPayee");
    if (paymentPayee) {
      paymentPayee.innerHTML =
        state.payees.slice().sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${clampInt(p.hands, 1)} hands)</option>`)
          .join("") || `<option value="">No payees</option>`;
    }

    const drawPayee = $("drawPayee");
    if (drawPayee) {
      const list = state.payees
        .filter((p) => payeeHandsRemaining(p.id) > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      drawPayee.innerHTML =
        list.length
          ? list.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (hands left: ${payeeHandsRemaining(p.id)})</option>`).join("")
          : `<option value="">All hands paid out</option>`;
    }

    if ($("paymentAmount")) {
      $("paymentAmount").setAttribute("step", String(hv));
      $("paymentAmount").setAttribute("placeholder", `${hv}, ${hv * 2}, ${hv * 3}...`);
    }
  }

  function updateHandsHelp() {
    const amtEl = $("paymentAmount");
    const helpEl = $("paymentHandsHelp");
    if (!amtEl || !helpEl) return;

    const hv = handValue();
    const amt = safeNumber(amtEl.value, 0);
    const hands = amt / hv;

    helpEl.textContent = `Hands: ${Number.isFinite(hands) ? hands : 0}`;
    if (amt && !(Number.isFinite(amt) && amt > 0 && amt % hv === 0)) amtEl.classList.add("danger-outline");
    else amtEl.classList.remove("danger-outline");
  }

  // -----------------------------
  // New Dashboard panels
  // -----------------------------
  function renderNextDueDraws() {
    const tbody = $("nextDueTable");
    if (!tbody) return;

    refreshPayeeDrawFlags();

    const rows = [];
    for (const p of state.payees) {
      const committed = clampInt(p.hands, 1);
      const paidOut = payeeHandsPaidOut(p.id);
      const remaining = Math.max(0, committed - paidOut);
      if (remaining <= 0) continue;

      const nextHandIndex = Math.min(paidOut, committed - 1); // next unpaid hand
      const reqDates = Array.isArray(p.requestedDrawDates) ? p.requestedDrawDates : [];
      const due = normalizeDateOrBlank(reqDates[nextHandIndex] || "");

      rows.push({
        name: p.name,
        due,
        handNo: nextHandIndex + 1,
      });
    }

    rows.sort((a, b) => {
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      return a.name.localeCompare(b.name);
    });

    tbody.innerHTML =
      rows
        .map((r) => {
          const status = r.due ? `<span class="pill">Due</span>` : `<span class="pill warn">No date</span>`;
          return `<tr>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td class="muted">${r.due ? escapeHtml(r.due) : "—"}</td>
            <td class="mono">${r.handNo}</td>
            <td>${status}</td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="4" class="muted">No payees due (everyone paid out).</td></tr>`;
  }

  function renderPaidOutSummary() {
    const table = $("paidOutTable");
    if (!table) return;

    const rows = state.payees
      .map((p) => {
        const paidHands = payeeHandsPaidOut(p.id);
        if (paidHands === 0) return null;

        const totalPaid = state.draws
          .filter((d) => d.handOwnerPayeeId === p.id)
          .reduce((sum, d) => sum + safeNumber(d.amount, 0), 0);

        const lastDraw = state.draws
          .filter((d) => d.handOwnerPayeeId === p.id)
          .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];

        const fullyPaid = payeeHandsRemaining(p.id) === 0;

        return `<tr class="${fullyPaid ? "paid-complete" : ""}">
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td class="mono">${paidHands}</td>
          <td>${fmtGBP(totalPaid)}</td>
          <td class="muted">${lastDraw ? escapeHtml(lastDraw.date) : "—"}</td>
        </tr>`;
      })
      .filter(Boolean);

    table.innerHTML = rows.join("") || `<tr><td colspan="4" class="muted">No payouts recorded yet.</td></tr>`;
  }

  // -----------------------------
  // History “spreadsheet”
  // -----------------------------
  function renderHistory() {
    const tbody = $("historyTable");
    if (!tbody) return;

    const rows = state.history
      .slice()
      .sort((a, b) => safeNumber(b.createdAt, 0) - safeNumber(a.createdAt, 0))
      .map((h) => {
        const title = h.title || `Cycle ${h.started || "?"} → ${h.ended || "?"}`;
        const committedHands = safeNumber(h.totals?.committedHands, 0);
        const totalContrib = safeNumber(h.totals?.totalContributions, 0);
        const totalDrawsAmt = safeNumber(h.totals?.totalDraws, 0);
        return `<tr>
          <td><strong>${escapeHtml(title)}</strong><div class="help">Draw day: ${escapeHtml(dayName(h.payoutDow))} • Hand: £${escapeHtml(h.handValue)}</div></td>
          <td class="muted">${escapeHtml(h.started || "—")}</td>
          <td class="muted">${escapeHtml(h.ended || "—")}</td>
          <td class="mono">${committedHands}</td>
          <td>${fmtGBP(totalContrib)}</td>
          <td>${fmtGBP(totalDrawsAmt)}</td>
          <td><button class="btn" type="button" data-hist="csv" data-id="${escapeHtml(h.id)}">Export CSV</button></td>
        </tr>`;
      });

    tbody.innerHTML = rows.join("") || `<tr><td colspan="7" class="muted">No archived cycles yet.</td></tr>`;

    tbody.querySelectorAll("button[data-hist='csv']").forEach((btn) => {
      btn.addEventListener("click", () => exportSingleCycleCsv(btn.dataset.id));
    });
  }

  function exportSingleCycleCsv(historyId) {
    const h = state.history.find((x) => x.id === historyId);
    if (!h) return toast("Not found", "History item not found.");

    const payeeNameById = new Map((h.payeeSnapshot || []).map((p) => [p.id, p.name]));
    const lines = [];
    lines.push(`Cycle,${csvEscape(h.title || "")}`);
    lines.push(`Started,${csvEscape(h.started || "")}`);
    lines.push(`Ended,${csvEscape(h.ended || "")}`);
    lines.push(`DrawDay,${csvEscape(dayName(h.payoutDow))}`);
    lines.push(`HandValue,${csvEscape(h.handValue)}`);
    lines.push("");

    lines.push("Contributions");
    lines.push(toCSV([["Date", "Payee", "Amount", "Hands", "Note"]]));
    const contribRows = (h.contributions || [])
      .slice()
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .map((c) => [c.date || "", payeeNameById.get(c.payeeId) || "Unknown", c.amount ?? "", c.hands ?? "", c.note || ""]);
    lines.push(toCSV(contribRows));
    lines.push("");

    lines.push("Draws");
    lines.push(toCSV([["Date", "Recipient", "Amount", "Note"]]));
    const drawRows = (h.draws || [])
      .slice()
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .map((d) => [d.date || "", payeeNameById.get(d.handOwnerPayeeId) || "Unknown", d.amount ?? "", d.note || ""]);
    lines.push(toCSV(drawRows));

    const filenameSafe = (h.title || "cycle").replace(/[^\w\- ]+/g, "").replace(/\s+/g, "_").slice(0, 60);
    downloadText(`${filenameSafe}_history.csv`, lines.join("\n"), "text/csv");
    toast("Exported", "Downloaded cycle history CSV.");
  }

  function exportAllHistoryCsv() {
    const rows = [
      ["Title", "Started", "Ended", "Draw Day", "Hand Value", "Committed Hands", "Total Contributions", "Total Draws"],
    ];
    for (const h of state.history) {
      rows.push([
        h.title || "",
        h.started || "",
        h.ended || "",
        dayName(h.payoutDow),
        String(h.handValue),
        String(safeNumber(h.totals?.committedHands, 0)),
        String(safeNumber(h.totals?.totalContributions, 0)),
        String(safeNumber(h.totals?.totalDraws, 0)),
      ]);
    }
    downloadText(`pardner-draw-history-index-${isoDate(new Date())}.csv`, toCSV(rows), "text/csv");
    toast("Exported", "Downloaded history index CSV.");
  }

  // -----------------------------
  // Draw amount enforcement
  // -----------------------------
  function setDrawAmountFromWeekPot(dateStr) {
    const d = normalizeDateOrBlank(dateStr);
    if (!d) return 0;
    const pot = weekPotForEnd(d);

    if ($("drawAmount")) {
      $("drawAmount").value = String(pot);
      $("drawAmount").readOnly = true;
    }
    return pot;
  }

  function setDashboardQuickDrawAmountFromThisWeekPot() {
    const d = isoDate(thisPayoutDay());
    const pot = weekPotForEnd(d);

    if ($("dashDrawAmount")) {
      $("dashDrawAmount").value = String(pot);
      $("dashDrawAmount").readOnly = true;
    }
    return pot;
  }

  // -----------------------------
  // Rendering main pages
  // -----------------------------
  function renderDashboard() {
    refreshPayeeDrawFlags();

    const hv = handValue();
    const payoutName = dayName(payoutDow());

    const handsTotal = totalCommittedHands();
    const target = basePot();
    const nextPay = thisPayoutDay();
    const nextPayStr = isoDate(nextPay);
    const weekPot = weekPotForEnd(nextPayStr);

    $("kpiTotalHands") && ($("kpiTotalHands").textContent = totalHandsPaidAllTime().toLocaleString("en-GB", { maximumFractionDigits: 0 }));
    $("kpiTotalMoney") && ($("kpiTotalMoney").textContent = `${fmtGBP(totalPaidAllTime())} total`);
    $("kpiN") && ($("kpiN").textContent = String(handsTotal));

    const funded = handsTotal > 0 ? Math.floor(totalHandsPaidAllTime() / handsTotal) : 0;
    $("kpiFundedDraws") && ($("kpiFundedDraws").textContent = String(funded));
    $("kpiFundedSub") && ($("kpiFundedSub").textContent = `${funded} / ${handsTotal || 0}`);

    $("kpiCompletedDraws") && ($("kpiCompletedDraws").textContent = String(drawsCompleted()));
    $("kpiRemainingSub") && ($("kpiRemainingSub").textContent = `Remaining: ${drawsRemainingHands()}`);
    $("kpiAvailableDraws") && ($("kpiAvailableDraws").textContent = String(Math.max(0, funded - drawsCompleted())));

    if ($("thisTuesdayPill")) {
      $("thisTuesdayPill").textContent =
        `This ${payoutName}: ${nextPay.toLocaleDateString("en-GB", { weekday: "short", year: "numeric", month: "short", day: "2-digit" })}`;
    }
    $("potPill") && ($("potPill").textContent = `This week’s pot: ${fmtGBP(weekPot)}`);
    $("basePotPill") && ($("basePotPill").textContent = `Base/Target (hands×£${hv}): ${fmtGBP(target)}`);

    renderFundingWidgets({ weekPot, targetPot: target });

    const fundingPill = $("fundingPill");
    if (fundingPill) {
      if (handsTotal <= 0) {
        fundingPill.className = "pill danger";
        fundingPill.textContent = "No hands set";
      } else if (weekPot >= target && target > 0) {
        fundingPill.className = "pill success";
        fundingPill.textContent = "Funded for this payout ✅";
      } else {
        fundingPill.className = "pill warn";
        fundingPill.textContent = "Not fully funded ⚠️";
      }
    }

    const start = getCycleStartDate();
    const last = getLastPayoutDateEstimated();
    const endEst = getCycleEndDateEstimated();
    $("cycleStartPill") && ($("cycleStartPill").textContent = `Cycle start: ${isoDate(start)}`);
    $("lastPayoutPill") && ($("lastPayoutPill").textContent = `Last payout: ${isoDate(last)}`);
    $("cycleEndPill") && ($("cycleEndPill").textContent = `Cycle end: ${isoDate(endEst)}`);

    // Quick draw selector
    const sel = $("dashRecipient");
    if (sel) {
      const list = state.payees
        .filter((p) => payeeHandsRemaining(p.id) > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      sel.innerHTML = list.length
        ? list.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (hands left: ${payeeHandsRemaining(p.id)})</option>`).join("")
        : `<option value="">All hands paid out</option>`;
    }

    // ✅ quick draw amount = this week pot (readonly)
    setDashboardQuickDrawAmountFromThisWeekPot();

    // Tables
    renderNextDueDraws();
    renderPaidOutSummary();

    // Not fully paid out table
    const notDrawnTable = $("notDrawnTable");
    if (notDrawnTable) {
      const rows = state.payees
        .filter((p) => payeeHandsRemaining(p.id) > 0)
        .sort((a, b) => a.name.localeCompare(b.name));

      notDrawnTable.innerHTML =
        rows.map((p) => {
          const t = payeeTotals(p.id);
          const committed = clampInt(p.hands, 1);
          const left = payeeHandsRemaining(p.id);

          const paidOut = payeeHandsPaidOut(p.id);
          const reqDates = Array.isArray(p.requestedDrawDates) ? p.requestedDrawDates : [];
          const nextHandIndex = Math.min(paidOut, committed - 1);
          const nextReq = normalizeDateOrBlank(reqDates[nextHandIndex] || "");

          return `<tr>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td class="muted">${nextReq ? escapeHtml(nextReq) : "—"}</td>
            <td class="mono">${t.handsPaid.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</td>
            <td>${fmtGBP(t.paid)}</td>
            <td class="muted">${(p.notes || "").trim() ? `📝 (${committed} hands, left ${left})` : `(${committed} hands, left ${left})`}</td>
          </tr>`;
        }).join("") || `<tr><td colspan="5" class="muted">Everyone has been paid out 🎉</td></tr>`;
    }

    // Activity
    const activityTable = $("activityTable");
    if (activityTable) {
      const rows = [...state.activity].sort((a, b) => safeNumber(b.at, 0) - safeNumber(a.at, 0)).slice(0, 25);
      activityTable.innerHTML =
        rows.map((a) => `<tr>
          <td class="muted">${new Date(a.at).toLocaleString("en-GB")}</td>
          <td><span class="pill">${escapeHtml(a.type)}</span></td>
          <td>${escapeHtml(a.details)}</td>
        </tr>`).join("") || `<tr><td colspan="3" class="muted">No activity yet.</td></tr>`;
    }

    renderCycleCompletedBanner();
  }

  function renderPayees() {
    refreshPayeeDrawFlags();
    const payeesTable = $("payeesTable");
    if (!payeesTable) return;

    const search = ($("payeeSearch")?.value || "").toLowerCase().trim();
    const filter = $("payeeFilter")?.value || "all";

    let rows = state.payees.slice();
    if (search) rows = rows.filter((p) => (p.name || "").toLowerCase().includes(search));
    if (filter === "drawn") rows = rows.filter((p) => !!p.hasDrawn);
    if (filter === "notdrawn") rows = rows.filter((p) => !p.hasDrawn);

    rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    payeesTable.innerHTML =
      rows.map((p) => {
        const t = payeeTotals(p.id);
        const committed = clampInt(p.hands, 1);
        const left = payeeHandsRemaining(p.id);

        const reqs = Array.isArray(p.requestedDrawDates) ? p.requestedDrawDates.filter(Boolean) : [];
        const reqText = reqs.length ? reqs.slice().sort().join(", ") : "—";

        const trClass = p.hasDrawn ? "drawn" : "";
        const status = p.hasDrawn ? `<span class="pill success">Paid out</span>` : `<span class="pill">Pending</span>`;

        return `<tr class="${trClass}">
          <td>
            <strong>${escapeHtml(p.name)}</strong>
            <div class="help">${committed} hands • left ${left}</div>
          </td>
          <td>${status}</td>
          <td class="muted" title="${escapeHtml(reqText)}">${escapeHtml(reqText)}</td>
          <td class="muted">${p.drawDate ? escapeHtml(p.drawDate) : "—"}</td>
          <td class="mono">${t.handsPaid.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</td>
          <td>${fmtGBP(t.paid)}</td>
          <td class="muted">${(p.notes || "").trim() ? "📝" : "—"}</td>
          <td>
            <button class="btn" data-act="pay" data-id="${p.id}" type="button">Add payment</button>
            <button class="btn" data-act="edit" data-id="${p.id}" type="button">Edit</button>
            <button class="btn danger" data-act="del" data-id="${p.id}" type="button">Delete</button>
          </td>
        </tr>`;
      }).join("") || `<tr><td colspan="8" class="muted">No payees found.</td></tr>`;

    payeesTable.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        const p = state.payees.find((x) => x.id === id);
        if (!p) return;

        if (act === "pay") {
          showPage("payments");
          $("paymentPayee") && ($("paymentPayee").value = id);
          return;
        }
        if (act === "edit") {
          openPayeeModal(id);
          return;
        }
        if (act === "del") {
          if (!confirm(`Delete payee "${p.name}"? (History remains.)`)) return;
          state.payees = state.payees.filter((x) => x.id !== id);
          logActivity("Payee deleted", `Deleted ${p.name}`);
          saveState();
          renderAll();
        }
      });
    });

    populatePayeeSelects();
  }

  function renderPayments() {
    $("paymentDate") && !$("paymentDate").value && ($("paymentDate").value = isoDate(new Date()));
    updateHandsHelp();
    populatePayeeSelects();

    const paymentsTable = $("paymentsTable");
    if (!paymentsTable) return;

    const rows = [...state.contributions]
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || safeNumber(b.createdAt, 0) - safeNumber(a.createdAt, 0))
      .slice(0, 80);

    paymentsTable.innerHTML =
      rows.map((c) => {
        const p = state.payees.find((x) => x.id === c.payeeId);
        return `<tr>
          <td class="muted">${escapeHtml(c.date)}</td>
          <td>${escapeHtml(p ? p.name : "Unknown")}</td>
          <td>${fmtGBP(c.amount)}</td>
          <td class="mono">${safeNumber(c.hands, 0).toLocaleString("en-GB", { maximumFractionDigits: 0 })}</td>
          <td class="muted">${escapeHtml(c.note || "")}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="5" class="muted">No payments yet.</td></tr>`;
  }

  function renderDraws() {
    refreshPayeeDrawFlags();
    populatePayeeSelects();

    $("drawDate") && !$("drawDate").value && ($("drawDate").value = isoDate(thisPayoutDay()));

    const dateStr = $("drawDate")?.value || "";
    // ✅ enforce draw amount from pot
    setDrawAmountFromWeekPot(dateStr);

    const drawsTable = $("drawsTable");
    if (!drawsTable) return;

    const rows = [...state.draws]
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || safeNumber(b.createdAt, 0) - safeNumber(a.createdAt, 0))
      .slice(0, 160);

    drawsTable.innerHTML =
      rows.map((d) => {
        const p = state.payees.find((x) => x.id === d.handOwnerPayeeId);
        return `<tr>
          <td class="muted">${escapeHtml(d.date)}</td>
          <td><strong>${escapeHtml(p ? p.name : "Unknown")}</strong></td>
          <td>${fmtGBP(d.amount)}</td>
          <td class="muted">${escapeHtml(d.note || "")}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="4" class="muted">No draws yet.</td></tr>`;
  }

  function renderWeekly() {
    $("weekEnding") && !$("weekEnding").value && ($("weekEnding").value = isoDate(thisPayoutDay()));
    const endStr = $("weekEnding")?.value;
    if (!endStr) return;

    const hv = handValue();
    const weekCons = contributionsInWeek(endStr);
    const totalWeekPaid = weekCons.reduce((s, c) => s + safeNumber(c.amount, 0), 0);
    const totalWeekHands = totalWeekPaid / hv;

    const handsTotal = totalCommittedHands();
    const funded = handsTotal > 0 && totalWeekHands >= handsTotal;
    const carry = handsTotal > 0 ? Math.max(0, totalWeekHands - handsTotal) : 0;

    $("wkTotalMoney") && ($("wkTotalMoney").textContent = fmtGBP(totalWeekPaid));
    $("wkTotalHands") && ($("wkTotalHands").textContent = totalWeekHands.toLocaleString("en-GB", { maximumFractionDigits: 0 }));
    $("wkCarryHands") && ($("wkCarryHands").textContent = carry.toLocaleString("en-GB", { maximumFractionDigits: 0 }));

    if ($("wkFundingText")) {
      $("wkFundingText").textContent =
        handsTotal > 0 ? (funded ? `Funded ✅ (need ${handsTotal} hands)` : `Not funded ⚠️ (need ${handsTotal} hands)`) : "Add payees to calculate hands";
    }
    $("wkHandsText") && ($("wkHandsText").textContent = handsTotal > 0 ? `${totalWeekHands.toFixed(0)} / ${handsTotal} hands` : "—");
    $("wkCarryText") && ($("wkCarryText").textContent = `Hands above total`);

    const byPayee = new Map();
    for (const c of weekCons) {
      const cur = byPayee.get(c.payeeId) || { amount: 0, dates: new Set(), notes: [] };
      cur.amount += safeNumber(c.amount, 0);
      c.date && cur.dates.add(c.date);
      (c.note || "").trim() && cur.notes.push(String(c.note).trim());
      byPayee.set(c.payeeId, cur);
    }

    const weeklyTable = $("weeklyTable");
    if (!weeklyTable) return;

    const rows = state.payees
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => {
        const r = byPayee.get(p.id);
        if (!r) return null;
        const hands = r.amount / hv;
        const dates = Array.from(r.dates).sort().join(", ");
        const notes = r.notes.join(" • ");
        return `<tr>
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td class="muted">${escapeHtml(dates || "—")}</td>
          <td>${fmtGBP(r.amount)}</td>
          <td class="mono">${hands.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</td>
          <td class="muted">${escapeHtml(notes)}</td>
        </tr>`;
      })
      .filter(Boolean);

    weeklyTable.innerHTML = rows.join("") || `<tr><td colspan="5" class="muted">No payments recorded for this week.</td></tr>`;
  }

  function renderSettings() {
    $("setHandValue") && ($("setHandValue").value = String(handValue()));
    $("setDrawDay") && ($("setDrawDay").value = String(payoutDow()));
    $("setCycleStart") && ($("setCycleStart").value = state.settings.cycleStartDate || "");
    $("setNLocked") && ($("setNLocked").value = String(safeNumber(state.settings.nLocked, 0)));
  }

  function renderAll() {
    renderDashboard();
    renderPayees();
    renderPayments();
    renderDraws();
    renderWeekly();
    renderSettings();
    renderHistory();
    applyLockUI();
  }

  // -----------------------------
  // Handlers
  // -----------------------------
  function attachHandlers() {
    // NAV
    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target.closest(".nav button[data-page]");
        if (!btn) return;
        e.preventDefault();
        showPage(btn.dataset.page);
      },
      true
    );

    $("quickAddPayment")?.addEventListener("click", () => showPage("payments"));
    $("quickRecordDraw")?.addEventListener("click", () => showPage("draws"));

    $("payeeSearch")?.addEventListener("input", renderPayees);
    $("payeeFilter")?.addEventListener("change", renderPayees);

    // Add Payee
    $("addPayeeBtn")?.addEventListener("click", () => {
      const name = ($("payeeName")?.value || "").trim();
      const hands = clampInt($("payeeHands")?.value, 1);
      const reqSingle = normalizeDateOrBlank($("payeeReqDate")?.value || "");
      const notes = ($("payeeNotes")?.value || "").trim();

      if (!name) return toast("Missing", "Please enter a payee name.");

      // duplicate date prevention (first requested date)
      if (reqSingle) {
        const used = collectAllRequestedDates();
        if (used.has(reqSingle)) {
          const who = used.get(reqSingle);
          return toast("Date already taken", `${reqSingle} is already requested by ${who.payeeName}. Choose a different date.`);
        }
      }

      const reqArr = Array.from({ length: hands }, (_, i) => (i === 0 ? reqSingle : ""));

      state.payees.push({
        id: uid("p"),
        name,
        hands,
        requestedDrawDates: reqArr,
        notes,
        hasDrawn: false,
        drawDate: "",
        drawAmount: 0,
        createdAt: Date.now(),
      });

      $("payeeName") && ($("payeeName").value = "");
      $("payeeHands") && ($("payeeHands").value = "1");
      $("payeeReqDate") && ($("payeeReqDate").value = "");
      $("payeeNotes") && ($("payeeNotes").value = "");

      logActivity("Payee added", `${name} added (${hands} hands)`);
      saveState();
      renderAll();
      toast("Added", `${name} (${hands} hands)`);
    });

    // Payments
    $("paymentAmount")?.addEventListener("input", updateHandsHelp);

    $("savePaymentBtn")?.addEventListener("click", () => {
      if (isCycleLocked()) return toast("Locked", "Cycle is completed and locked. Start a new cycle to continue.");

      const payeeId = $("paymentPayee")?.value || "";
      const date = normalizeDateOrBlank($("paymentDate")?.value || "");
      const amount = safeNumber($("paymentAmount")?.value, 0);
      const note = ($("paymentNote")?.value || "").trim();

      if (!payeeId) return toast("Missing", "Please select a payee.");
      if (!date) return toast("Missing", "Please choose a valid payment date.");
      if (!validMultipleOfHandValue(amount)) return toast("Invalid", `Amount must be a positive multiple of £${handValue()}.`);

      const hv = handValue();
      const hands = amount / hv;

      state.contributions.push({
        id: uid("c"),
        payeeId,
        date,
        amount,
        hands,
        note,
        createdAt: Date.now(),
      });

      const p = state.payees.find((x) => x.id === payeeId);
      logActivity("Payment", `${p ? p.name : "Payee"} paid ${fmtGBP(amount)} (${hands} hands)`);

      $("paymentAmount") && ($("paymentAmount").value = "");
      $("paymentNote") && ($("paymentNote").value = "");
      updateHandsHelp();

      saveState();
      renderAll();
      toast("Saved", `${p ? p.name : "Payee"} • ${fmtGBP(amount)} • ${hands} hands`);
    });

    // Draw date change -> update drawAmount from pot
    $("drawDate")?.addEventListener("change", () => {
      const dateStr = normalizeDateOrBlank($("drawDate")?.value || "");
      setDrawAmountFromWeekPot(dateStr);
    });

    // Draws save (amount forced from pot)
    $("saveDrawBtn")?.addEventListener("click", () => {
      if (isCycleLocked()) return toast("Locked", "Cycle is completed and locked. Start a new cycle to continue.");

      const date = normalizeDateOrBlank($("drawDate")?.value || "");
      const payeeId = $("drawPayee")?.value || "";
      const note = ($("drawNote")?.value || "").trim();

      if (!date) return toast("Missing", "Please choose a valid payout date.");
      if (!payeeId) return toast("Missing", "Please choose a recipient.");

      const amount = weekPotForEnd(date); // ✅ enforced
      if (amount <= 0) return toast("No pot", "This week’s pot is £0. Record payments first before paying out.");
      if (!validMultipleOfHandValue(amount)) {
        // This can happen if payments were entered not matching handValue after a settings change
        return toast("Pot not valid", `Week pot (${fmtGBP(amount)}) is not a multiple of £${handValue()}. Check payments/hand value.`);
      }

      const p = state.payees.find((x) => x.id === payeeId);
      if (!p) return toast("Error", "Payee not found.");
      if (payeeHandsRemaining(payeeId) <= 0) return toast("No hands left", `${p.name} has no hands remaining.`);

      state.draws.push({
        id: uid("d"),
        date,
        handOwnerPayeeId: payeeId,
        amount,
        note,
        createdAt: Date.now(),
      });

      logActivity("Payout", `${p.name} paid 1 hand on ${date} (${fmtGBP(amount)})`);
      $("drawNote") && ($("drawNote").value = "");

      saveState();
      renderAll();
      toast("Recorded", `${p.name} • ${fmtGBP(amount)} • ${date}`);
    });

    // Dashboard quick draw (amount = this week's pot)
    $("dashRecordDraw")?.addEventListener("click", () => {
      if (isCycleLocked()) return toast("Locked", "Cycle is completed and locked. Start a new cycle to continue.");

      const payeeId = $("dashRecipient")?.value || "";
      const date = isoDate(thisPayoutDay());

      if (!payeeId) return toast("Missing", "No available recipients.");

      const amount = weekPotForEnd(date); // ✅ enforced
      if (amount <= 0) return toast("No pot", "This week’s pot is £0. Record payments first before paying out.");
      if (!validMultipleOfHandValue(amount)) return toast("Pot not valid", `Week pot (${fmtGBP(amount)}) is not a multiple of £${handValue()}.`);

      $("drawDate") && ($("drawDate").value = date);
      $("drawPayee") && ($("drawPayee").value = payeeId);
      $("drawAmount") && ($("drawAmount").value = String(amount));
      $("drawNote") && ($("drawNote").value = "Recorded from Dashboard");

      showPage("draws");
      $("saveDrawBtn")?.click();
    });

    // Weekly navigation
    $("refreshWeekBtn")?.addEventListener("click", renderWeekly);
    $("weekEnding")?.addEventListener("change", renderWeekly);

    $("prevWeekBtn")?.addEventListener("click", () => {
      const cur = parseISODate($("weekEnding")?.value);
      if (!cur) return;
      $("weekEnding") && ($("weekEnding").value = isoDate(addDays(cur, -7)));
      renderWeekly();
    });

    $("nextWeekBtn")?.addEventListener("click", () => {
      const cur = parseISODate($("weekEnding")?.value);
      if (!cur) return;
      $("weekEnding") && ($("weekEnding").value = isoDate(addDays(cur, 7)));
      renderWeekly();
    });

    // Save Settings
    $("saveSettingsBtn")?.addEventListener("click", () => {
      const hv = clampInt($("setHandValue")?.value, 1);
      const dowRaw = safeNumber($("setDrawDay")?.value, 2);
      const dow = ((Math.floor(dowRaw) % 7) + 7) % 7;
      const start = normalizeDateOrBlank($("setCycleStart")?.value || "");
      const nLocked = safeNumber($("setNLocked")?.value, 0);

      state.settings.handValue = hv;
      state.settings.payoutDow = dow;
      if (start) state.settings.cycleStartDate = start;
      state.settings.nLocked = nLocked;

      // Recalculate hands for existing payments (amounts unchanged)
      state.contributions = state.contributions.map((c) => ({
        ...c,
        hands: safeNumber(c.amount, 0) / hv,
      }));

      logActivity("Settings", `Hand £${hv}, draw day ${dayName(dow)}`);
      saveState();
      renderAll();
      toast("Saved", `Hand value £${hv} • Target pot ${fmtGBP(basePot())}`);
    });

    // Export / Import / Reset
    $("exportBtn")?.addEventListener("click", () => {
      downloadText(`pardner-draw-backup-${isoDate(new Date())}.json`, JSON.stringify(state, null, 2), "application/json");
      toast("Exported", "Downloaded JSON backup.");
    });

    $("importFile")?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.settings || !Array.isArray(data.payees) || !Array.isArray(data.contributions) || !Array.isArray(data.draws)) {
          throw new Error("JSON does not look like Pardner Draw data.");
        }
        if (!confirm("Import will replace current data in this browser. Continue?")) return;

        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        state = loadState();
        saveState();
        renderAll();
        toast("Imported", "Data restored from JSON.");
      } catch (err) {
        console.error(err);
        toast("Import failed", String(err.message || err));
      } finally {
        e.target.value = "";
      }
    });

    $("resetBtn")?.addEventListener("click", () => {
      if (!confirm("Reset ALL data in this browser? (Export first if needed.)")) return;
      state = defaultState();
      saveState();
      renderAll();
      toast("Reset", "All data cleared.");
    });

    // Modal handlers
    $("payeeModalCloseBtn")?.addEventListener("click", closePayeeModal);
    $("payeeModalCancelBtn")?.addEventListener("click", closePayeeModal);
    $("payeeModalSaveBtn")?.addEventListener("click", savePayeeModal);
    $("editPayeeHands")?.addEventListener("input", onModalHandsChange);

    $("payeeModal")?.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.close === "1") closePayeeModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const m = $("payeeModal");
      if (m && m.style.display !== "none") closePayeeModal();
    });

    // Start New Cycle
    $("startNewCycleBtn")?.addEventListener("click", () => {
      if (!confirm("Start a new cycle?\n\nThis will ARCHIVE the current cycle (payments & draws) into History, then reset the current payments/draws to empty.\nPayees/hands/notes will be kept.")) return;
      archiveCurrentCycleAndReset();
      renderAll();
      showPage("dashboard");
      toast("New cycle", "Previous cycle archived into History.");
    });

    // Export all history CSV (optional)
    $("exportHistoryCsvBtn")?.addEventListener("click", exportAllHistoryCsv);
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    attachHandlers();
    populatePayeeSelects();

    // defaults
    $("drawDate") && ($("drawDate").value = isoDate(thisPayoutDay()));
    $("weekEnding") && ($("weekEnding").value = isoDate(thisPayoutDay()));

    // enforce readonly amounts on load
    $("drawAmount") && ($("drawAmount").readOnly = true);
    $("dashDrawAmount") && ($("dashDrawAmount").readOnly = true);

    renderAll();
    showPage("dashboard");

    // PWA service worker (optional)
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js").catch(() => {});
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();