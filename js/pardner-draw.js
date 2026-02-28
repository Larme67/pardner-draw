/* js/pardner-draw.js
   Pardner Draw — v6
   - Editable hand value + editable draw day
   - Payee Edit Modal
   - ✅ requestedDrawDates per hand (array length matches hands)

   Data model:
   payee: {
     id, name, hands,
     requestedDrawDates: string[], // length = hands, values are "" or "YYYY-MM-DD"
     notes,
     hasDrawn, drawDate, drawAmount
   }

   Backwards compatible:
   - If older data has requestedDrawDate, it is converted into requestedDrawDates[0].
*/

(() => {
  "use strict";

  const STORAGE_KEY = "pardner_draw_v6";
  const PAGES = ["dashboard", "payees", "payments", "draws", "weekly", "settings"];
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
    x.setDate(x.getDate() + n);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function uid(prefix = "id") {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
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

  function dayName(dow) {
    const map = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return map[((Number(dow) % 7) + 7) % 7];
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

  // -----------------------------
  // State
  // -----------------------------
  function defaultState() {
    return {
      settings: {
        handValue: 50,
        payoutDow: 2, // Tuesday
        cycleStartDate: isoDate(new Date()),
        nLocked: 0, // compatibility only
      },
      payees: [],
      contributions: [],
      draws: [],
      activity: [],
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

      // settings defaults
      s.settings.handValue = clampInt(s.settings.handValue, 1);
      s.settings.payoutDow = ((clampInt(s.settings.payoutDow, 0) % 7) + 7) % 7;
      s.settings.cycleStartDate = s.settings.cycleStartDate || isoDate(new Date());
      s.settings.nLocked = safeNumber(s.settings.nLocked, 0);

      // migrate payees to requestedDrawDates[]
      s.payees = s.payees.map((p) => {
        const hands = clampInt(p.hands, 1);
        let arr = [];

        // New format
        if (Array.isArray(p.requestedDrawDates)) {
          arr = p.requestedDrawDates.map(normalizeDateOrBlank);
        } else {
          // Old format: requestedDrawDate (single)
          arr = [normalizeDateOrBlank(p.requestedDrawDate || "")];
        }

        // Ensure length = hands
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

      // contributions: ensure hands computed
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

      // draws: normalize
      s.draws = s.draws.map((d) => ({
        ...d,
        id: d.id || uid("d"),
        date: String(d.date || ""),
        handOwnerPayeeId: d.handOwnerPayeeId || d.payeeId || "",
        amount: safeNumber(d.amount, 0),
        note: String(d.note || ""),
        createdAt: safeNumber(d.createdAt, Date.now()),
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
  // Schedule helpers (based on chosen draw day)
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

  function prevPayoutDay(from = new Date()) {
    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const target = payoutDow();
    const delta = (day - target + 7) % 7;
    d.setDate(d.getDate() - delta);
    return d;
  }

  function thisPayoutDay() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return isPayoutDay(today) ? today : nextPayoutDay(today);
  }

  // 7-day window ending on payout day
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
  // Cycle math (hands-based)
  // -----------------------------
  function totalCommittedHands() {
    return state.payees.reduce((sum, p) => sum + clampInt(p.hands, 1), 0);
  }

  function basePot() {
    return totalCommittedHands() * handValue();
  }

  function totalPaidAllTime() {
    return state.contributions.reduce((sum, c) => sum + safeNumber(c.amount, 0), 0);
  }

  function totalHandsPaidAllTime() {
    return totalPaidAllTime() / handValue();
  }

  function drawsCompleted() {
    return state.draws.length;
  }

  function drawsRemainingHands() {
    return Math.max(0, totalCommittedHands() - drawsCompleted());
  }

  function getCycleStartDate() {
    const d = parseISODate(state.settings.cycleStartDate);
    return d || thisPayoutDay();
  }

  function getCycleEndDate() {
    return addDays(getCycleStartDate(), totalCommittedHands() * 7);
  }

  function getLastPayoutDate() {
    return addDays(getCycleStartDate(), Math.max(0, (totalCommittedHands() - 1) * 7));
  }

  // -----------------------------
  // Payments / pots
  // -----------------------------
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
        .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (safeNumber(b.createdAt, 0) - safeNumber(a.createdAt, 0)))[0];

      if (last) {
        p.drawDate = last.date;
        p.drawAmount = safeNumber(last.amount, 0);
      }
    }
  }

  function estimateFundingRatePayoutsPerWeek() {
    const handsTotal = totalCommittedHands();
    if (handsTotal <= 0) return null;

    const end0 = prevPayoutDay(new Date());
    let weeks = 0;
    let handsSum = 0;

    for (let i = 0; i < 10 && weeks < 6; i++) {
      const end = addDays(end0, -7 * i);
      const endStr = isoDate(end);
      const pot = weekPotForEnd(endStr);
      if (pot <= 0) continue;
      weeks++;
      handsSum += pot / handValue();
    }
    if (weeks === 0) return null;

    const avgHandsPerWeek = handsSum / weeks;
    const rate = avgHandsPerWeek / handsTotal;
    return Math.min(1, Math.max(0, rate));
  }

  // -----------------------------
  // Navigation
  // -----------------------------
  function showPage(page) {
    PAGES.forEach((p) => {
      const el = $("page-" + p);
      if (!el) return;
      el.style.display = p === page ? "block" : "none";
    });

    document.querySelectorAll(".nav button[data-page]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.page === page);
    });

    const payoutName = dayName(payoutDow());
    const hv = handValue();

    const map = {
      dashboard: ["Dashboard", `Hands-based cycle • Payouts every ${payoutName}.`],
      payees: ["Payees", "Edit requested draw dates per hand."],
      payments: ["Add Payment", `Payments must be multiples of £${hv} (hands).`],
      draws: ["Record Draw", `Each ${payoutName} pays out ONE hand.`],
      weekly: ["Weekly Summary", `7-day window ending on ${payoutName}.`],
      settings: ["Settings", "Edit hand value, draw day, cycle start; export/import; reset."],
    };

    if ($("pageTitle")) $("pageTitle").textContent = map[page]?.[0] || "Pardner Draw";
    if ($("pageSubtitle")) $("pageSubtitle").textContent = map[page]?.[1] || "";

    renderAll();
  }

  // -----------------------------
  // Payee Edit Modal (multi requested dates)
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
    inputs.forEach((inp) => {
      arr.push(normalizeDateOrBlank(inp.value));
    });
    return arr;
  }

  function openPayeeModal(payeeId) {
    const p = state.payees.find((x) => x.id === payeeId);
    if (!p) return;

    editingPayeeId = payeeId;

    $("editPayeeName").value = p.name || "";
    $("editPayeeHands").value = String(clampInt(p.hands, 1));
    $("editPayeeNotes").value = p.notes || "";

    // Build requested dates list to match hands
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

    const name = ($("editPayeeName").value || "").trim();
    const hands = clampInt($("editPayeeHands").value, 1);
    const notes = ($("editPayeeNotes").value || "").trim();

    if (!name) return toast("Invalid", "Name cannot be blank.");

    // Get requested dates from modal; force length to hands
    let reqArr = readRequestedDatesFromModal().map(normalizeDateOrBlank);
    while (reqArr.length < hands) reqArr.push("");
    if (reqArr.length > hands) reqArr = reqArr.slice(0, hands);

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

  // When hands changes inside modal, rebuild date inputs to match
  function onModalHandsChange() {
    if (!editingPayeeId) return;
    const p = state.payees.find((x) => x.id === editingPayeeId);
    if (!p) return;

    const hands = clampInt($("editPayeeHands")?.value, 1);

    // preserve what user already typed
    const current = readRequestedDatesFromModal();
    buildRequestedDatesInputs(hands, current.length ? current : p.requestedDrawDates);
  }

  // -----------------------------
  // Rendering
  // -----------------------------
  function renderDashboard() {
    refreshPayeeDrawFlags();

    const hv = handValue();
    const payoutName = dayName(payoutDow());

    const handsTotal = totalCommittedHands();
    const base = basePot();

    const nextPay = thisPayoutDay();
    const nextPayStr = isoDate(nextPay);
    const weekPot = weekPotForEnd(nextPayStr);

    if ($("kpiTotalHands")) $("kpiTotalHands").textContent =
      totalHandsPaidAllTime().toLocaleString("en-GB", { maximumFractionDigits: 0 });
    if ($("kpiTotalMoney")) $("kpiTotalMoney").textContent = `${fmtGBP(totalPaidAllTime())} total`;
    if ($("kpiN")) $("kpiN").textContent = String(handsTotal);

    const funded = handsTotal > 0 ? Math.floor(totalHandsPaidAllTime() / handsTotal) : 0;
    if ($("kpiFundedDraws")) $("kpiFundedDraws").textContent = String(funded);
    if ($("kpiFundedSub")) $("kpiFundedSub").textContent = `${funded} / ${handsTotal || 0}`;

    if ($("kpiCompletedDraws")) $("kpiCompletedDraws").textContent = String(drawsCompleted());
    if ($("kpiRemainingSub")) $("kpiRemainingSub").textContent = `Remaining: ${drawsRemainingHands()}`;
    if ($("kpiAvailableDraws")) $("kpiAvailableDraws").textContent = String(Math.max(0, funded - drawsCompleted()));

    if ($("thisTuesdayPill")) {
      $("thisTuesdayPill").textContent =
        `This ${payoutName}: ${nextPay.toLocaleDateString("en-GB", { weekday: "short", year: "numeric", month: "short", day: "2-digit" })}`;
    }

    if ($("potPill")) $("potPill").textContent = `This week’s pot: ${fmtGBP(weekPot)}`;
    if ($("basePotPill")) $("basePotPill").textContent = `Base pot (hands×£${hv}): ${fmtGBP(base)}`;

    const fundingPill = $("fundingPill");
    if (fundingPill) {
      if (handsTotal <= 0) {
        fundingPill.className = "pill danger";
        fundingPill.textContent = "No hands set";
      } else if (weekPot >= base && base > 0) {
        fundingPill.className = "pill success";
        fundingPill.textContent = "Funded for this payout ✅";
      } else {
        fundingPill.className = "pill warn";
        fundingPill.textContent = "Not fully funded ⚠️";
      }
    }

    const start = getCycleStartDate();
    const last = getLastPayoutDate();
    const end = getCycleEndDate();
    if ($("cycleStartPill")) $("cycleStartPill").textContent = `Cycle start: ${isoDate(start)}`;
    if ($("lastPayoutPill")) $("lastPayoutPill").textContent = `Last payout: ${isoDate(last)}`;
    if ($("cycleEndPill")) $("cycleEndPill").textContent = `Cycle end: ${isoDate(end)}`;

    const rate = estimateFundingRatePayoutsPerWeek();
    if ($("ratePill")) $("ratePill").textContent = rate == null ? "Funding rate: —" : `Funding rate: ${rate.toFixed(2)} payouts/week`;

    const sel = $("dashRecipient");
    if (sel) {
      const list = state.payees
        .filter((p) => payeeHandsRemaining(p.id) > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      sel.innerHTML = list.length
        ? list.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (hands left: ${payeeHandsRemaining(p.id)})</option>`).join("")
        : `<option value="">All hands paid out</option>`;
    }

    if ($("dashDrawAmount") && !$("dashDrawAmount").value) {
      $("dashDrawAmount").value = String(weekPot > 0 ? weekPot : base);
    }

    // Not drawn table: show next requested date if any
    const notDrawnTable = $("notDrawnTable");
    if (notDrawnTable) {
      const rows = state.payees
        .filter((p) => payeeHandsRemaining(p.id) > 0)
        .sort((a, b) => a.name.localeCompare(b.name));

      notDrawnTable.innerHTML =
        rows
          .map((p) => {
            const t = payeeTotals(p.id);
            const committed = clampInt(p.hands, 1);
            const left = payeeHandsRemaining(p.id);

            const reqs = Array.isArray(p.requestedDrawDates) ? p.requestedDrawDates.filter(Boolean) : [];
            const nextReq = reqs.length ? reqs.slice().sort()[0] : "";

            return `<tr>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td class="muted">${nextReq ? escapeHtml(nextReq) : "—"}</td>
              <td class="mono">${t.handsPaid.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</td>
              <td>${fmtGBP(t.paid)}</td>
              <td class="muted">${(p.notes || "").trim() ? `📝 (${committed} hands, left ${left})` : `(${committed} hands, left ${left})`}</td>
            </tr>`;
          })
          .join("") || `<tr><td colspan="5" class="muted">Everyone has been paid out 🎉</td></tr>`;
    }

    const activityTable = $("activityTable");
    if (activityTable) {
      const rows = [...state.activity].sort((a, b) => safeNumber(b.at, 0) - safeNumber(a.at, 0)).slice(0, 25);
      activityTable.innerHTML =
        rows
          .map((a) => `<tr>
            <td class="muted">${new Date(a.at).toLocaleString("en-GB")}</td>
            <td><span class="pill">${escapeHtml(a.type)}</span></td>
            <td>${escapeHtml(a.details)}</td>
          </tr>`)
          .join("") || `<tr><td colspan="3" class="muted">No activity yet.</td></tr>`;
    }
  }

  function populatePayeeSelects() {
    const hv = handValue();

    const paymentPayee = $("paymentPayee");
    if (paymentPayee) {
      paymentPayee.innerHTML =
        state.payees
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
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
      rows
        .map((p) => {
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
              <button class="btn" data-act="pay" data-id="${p.id}">Add payment</button>
              <button class="btn" data-act="edit" data-id="${p.id}">Edit</button>
              <button class="btn danger" data-act="del" data-id="${p.id}">Delete</button>
            </td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="8" class="muted">No payees found.</td></tr>`;

    payeesTable.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        const p = state.payees.find((x) => x.id === id);
        if (!p) return;

        if (act === "pay") {
          showPage("payments");
          if ($("paymentPayee")) $("paymentPayee").value = id;
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

  function renderPayments() {
    if ($("paymentDate") && !$("paymentDate").value) $("paymentDate").value = isoDate(new Date());
    updateHandsHelp();
    populatePayeeSelects();

    const paymentsTable = $("paymentsTable");
    if (!paymentsTable) return;

    const rows = [...state.contributions]
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (safeNumber(b.createdAt, 0) - safeNumber(a.createdAt, 0)))
      .slice(0, 80);

    paymentsTable.innerHTML =
      rows
        .map((c) => {
          const p = state.payees.find((x) => x.id === c.payeeId);
          return `<tr>
            <td class="muted">${escapeHtml(c.date)}</td>
            <td>${escapeHtml(p ? p.name : "Unknown")}</td>
            <td>${fmtGBP(c.amount)}</td>
            <td class="mono">${safeNumber(c.hands, 0).toLocaleString("en-GB", { maximumFractionDigits: 0 })}</td>
            <td class="muted">${escapeHtml(c.note || "")}</td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="5" class="muted">No payments yet.</td></tr>`;
  }

  function renderDraws() {
    refreshPayeeDrawFlags();
    populatePayeeSelects();

    if ($("drawDate") && !$("drawDate").value) $("drawDate").value = isoDate(thisPayoutDay());

    const dateStr = $("drawDate")?.value;
    if ($("drawAmount") && dateStr && !$("drawAmount").value) {
      const pot = weekPotForEnd(dateStr);
      $("drawAmount").value = String(pot > 0 ? pot : basePot());
    }

    const drawsTable = $("drawsTable");
    if (!drawsTable) return;

    const rows = [...state.draws]
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (safeNumber(b.createdAt, 0) - safeNumber(a.createdAt, 0)))
      .slice(0, 160);

    drawsTable.innerHTML =
      rows
        .map((d) => {
          const p = state.payees.find((x) => x.id === d.handOwnerPayeeId);
          return `<tr>
            <td class="muted">${escapeHtml(d.date)}</td>
            <td><strong>${escapeHtml(p ? p.name : "Unknown")}</strong></td>
            <td>${fmtGBP(d.amount)}</td>
            <td class="muted">${escapeHtml(d.note || "")}</td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="4" class="muted">No draws yet.</td></tr>`;
  }

  function renderWeekly() {
    if ($("weekEnding") && !$("weekEnding").value) $("weekEnding").value = isoDate(thisPayoutDay());

    const endStr = $("weekEnding")?.value;
    if (!endStr) return;

    const hv = handValue();
    const weekCons = contributionsInWeek(endStr);
    const totalWeekPaid = weekCons.reduce((s, c) => s + safeNumber(c.amount, 0), 0);
    const totalWeekHands = totalWeekPaid / hv;

    const handsTotal = totalCommittedHands();
    const funded = handsTotal > 0 && totalWeekHands >= handsTotal;
    const carry = handsTotal > 0 ? Math.max(0, totalWeekHands - handsTotal) : 0;

    if ($("wkTotalMoney")) $("wkTotalMoney").textContent = fmtGBP(totalWeekPaid);
    if ($("wkTotalHands")) $("wkTotalHands").textContent = totalWeekHands.toLocaleString("en-GB", { maximumFractionDigits: 0 });
    if ($("wkCarryHands")) $("wkCarryHands").textContent = carry.toLocaleString("en-GB", { maximumFractionDigits: 0 });

    if ($("wkFundingText")) {
      $("wkFundingText").textContent =
        handsTotal > 0 ? (funded ? `Funded ✅ (need ${handsTotal} hands)` : `Not funded ⚠️ (need ${handsTotal} hands)`) : "Add payees to calculate hands";
    }
    if ($("wkHandsText")) $("wkHandsText").textContent = handsTotal > 0 ? `${totalWeekHands.toFixed(0)} / ${handsTotal} hands` : "—";
    if ($("wkCarryText")) $("wkCarryText").textContent = `Hands above total`;

    const byPayee = new Map();
    for (const c of weekCons) {
      const cur = byPayee.get(c.payeeId) || { amount: 0, dates: new Set(), notes: [] };
      cur.amount += safeNumber(c.amount, 0);
      if (c.date) cur.dates.add(c.date);
      if ((c.note || "").trim()) cur.notes.push(String(c.note).trim());
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
    if ($("setHandValue")) $("setHandValue").value = String(handValue());
    if ($("setDrawDay")) $("setDrawDay").value = String(payoutDow());
    if ($("setCycleStart")) $("setCycleStart").value = state.settings.cycleStartDate || "";
    if ($("setNLocked")) $("setNLocked").value = String(safeNumber(state.settings.nLocked, 0));
  }

  function renderAll() {
    renderDashboard();
    renderPayees();
    renderPayments();
    renderDraws();
    renderWeekly();
    renderSettings();
  }

  // -----------------------------
  // Handlers
  // -----------------------------
  function attachHandlers() {
    // NAV (capture)
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

    // Add payee: initial requestedDrawDates[] created blank to match hands
    $("addPayeeBtn")?.addEventListener("click", () => {
      const name = ($("payeeName")?.value || "").trim();
      const hands = clampInt($("payeeHands")?.value, 1);
      const reqSingle = normalizeDateOrBlank($("payeeReqDate")?.value || "");
      const notes = ($("payeeNotes")?.value || "").trim();

      if (!name) return toast("Missing", "Please enter a payee name.");

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

      if ($("payeeName")) $("payeeName").value = "";
      if ($("payeeHands")) $("payeeHands").value = "1";
      if ($("payeeReqDate")) $("payeeReqDate").value = "";
      if ($("payeeNotes")) $("payeeNotes").value = "";

      logActivity("Payee added", `${name} added (${hands} hands)`);
      saveState();
      renderAll();
      toast("Added", `${name} (${hands} hands)`);
    });

    $("paymentAmount")?.addEventListener("input", updateHandsHelp);

    $("savePaymentBtn")?.addEventListener("click", () => {
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

      if ($("paymentAmount")) $("paymentAmount").value = "";
      if ($("paymentNote")) $("paymentNote").value = "";
      updateHandsHelp();

      saveState();
      renderAll();
      toast("Saved", `${p ? p.name : "Payee"} • ${fmtGBP(amount)} • ${hands} hands`);
    });

    $("saveDrawBtn")?.addEventListener("click", () => {
      const date = normalizeDateOrBlank($("drawDate")?.value || "");
      const payeeId = $("drawPayee")?.value || "";
      const amount = safeNumber($("drawAmount")?.value, 0);
      const note = ($("drawNote")?.value || "").trim();

      if (!date) return toast("Missing", "Please choose a valid payout date.");
      if (!payeeId) return toast("Missing", "Please choose a recipient.");
      if (!validMultipleOfHandValue(amount)) return toast("Invalid", `Payout amount must be a multiple of £${handValue()}.`);

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
      if ($("drawNote")) $("drawNote").value = "";

      saveState();
      renderAll();
      toast("Recorded", `${p.name} • ${fmtGBP(amount)} • ${date}`);
    });

    $("dashRecordDraw")?.addEventListener("click", () => {
      const payeeId = $("dashRecipient")?.value || "";
      const amount = safeNumber($("dashDrawAmount")?.value, 0);
      const date = isoDate(thisPayoutDay());

      if (!payeeId) return toast("Missing", "No available recipients.");
      if (!validMultipleOfHandValue(amount)) return toast("Invalid", `Must be a multiple of £${handValue()}.`);

      if ($("drawDate")) $("drawDate").value = date;
      if ($("drawPayee")) $("drawPayee").value = payeeId;
      if ($("drawAmount")) $("drawAmount").value = String(amount);
      if ($("drawNote")) $("drawNote").value = "Recorded from Dashboard";

      showPage("draws");
      $("saveDrawBtn")?.click();
    });

    $("refreshWeekBtn")?.addEventListener("click", renderWeekly);
    $("weekEnding")?.addEventListener("change", renderWeekly);

    $("prevWeekBtn")?.addEventListener("click", () => {
      const cur = parseISODate($("weekEnding")?.value);
      if (!cur) return;
      $("weekEnding").value = isoDate(addDays(cur, -7));
      renderWeekly();
    });

    $("nextWeekBtn")?.addEventListener("click", () => {
      const cur = parseISODate($("weekEnding")?.value);
      if (!cur) return;
      $("weekEnding").value = isoDate(addDays(cur, 7));
      renderWeekly();
    });

    $("saveSettingsBtn")?.addEventListener("click", () => {
      const newHandValue = clampInt($("setHandValue")?.value, 1);
      const newDow = ((clampInt($("setDrawDay")?.value, 0) % 7) + 7) % 7;
      const start = normalizeDateOrBlank($("setCycleStart")?.value || "");
      const nLocked = safeNumber($("setNLocked")?.value, 0);

      state.settings.handValue = newHandValue;
      state.settings.payoutDow = newDow;
      if (start) state.settings.cycleStartDate = start;
      state.settings.nLocked = nLocked;

      // Recompute contribution hands using new HV (amounts unchanged)
      const hv = handValue();
      state.contributions = state.contributions.map((c) => ({ ...c, hands: safeNumber(c.amount, 0) / hv }));

      logActivity("Settings", `Hand £${hv}, draw day ${dayName(newDow)}`);
      saveState();
      renderAll();
      toast("Saved", `Hand £${hv} • Draw day ${dayName(newDow)}`);
    });

    $("exportBtn")?.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `pardner-draw-backup-${isoDate(new Date())}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
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

        // Import into this script’s storage key
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

    $("drawDate")?.addEventListener("change", () => {
      const dateStr = normalizeDateOrBlank($("drawDate")?.value || "");
      if (!dateStr || !$("drawAmount")) return;
      const pot = weekPotForEnd(dateStr);
      $("drawAmount").value = String(pot > 0 ? pot : basePot());
    });

    // Modal wiring
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
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    attachHandlers();
    populatePayeeSelects();

    if ($("drawDate")) $("drawDate").value = isoDate(thisPayoutDay());
    if ($("weekEnding")) $("weekEnding").value = isoDate(thisPayoutDay());

    renderAll();
    showPage("dashboard");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(console.error);
  });
}
})();