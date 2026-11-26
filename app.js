// ==========================================
    // 1. STORAGE ARCHITECTURE (ZERO SERVER DB)
    // - Booking data -> sessionStorage (auto-wiped on tab/browser close)
    // - Products, Customers, Policies -> IndexedDB (persists until user clears)
    // ==========================================
    const SESSION_KEY = "omf_session_data_v1";
    const DB_NAME = "omf_browser_master_db";
    const DB_VERSION = 1;

    let state = {
      importedFiles: [],
      bookings: [],
      bookingDetails: [],
      customers: [],
      products: [],
      bonusPolicies: []
    };

    let charts = {};

    // Theme state is initialized once at startup and persisted between visits.
    const THEME_KEY = "omf_minimal_theme_v1";
    function getSavedTheme() {
      try { return localStorage.getItem(THEME_KEY) || "light"; }
      catch (error) { return "light"; }
    }
    function applyTheme(theme) {
      const isDark = theme === "dark";
      document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
      const btn = document.getElementById("btn-theme-toggle");
      if (btn) {
        const icon = btn.querySelector(".theme-icon");
        const label = btn.querySelector(".theme-label");
        if (icon) icon.textContent = isDark ? "☀" : "☾";
        if (label) label.textContent = isDark ? "Light mode" : "Dark mode";
        btn.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
        btn.title = isDark ? "Switch to light mode" : "Switch to dark mode";
      }
      try { localStorage.setItem(THEME_KEY, isDark ? "dark" : "light"); }
      catch (error) { console.warn("Theme preference could not be saved:", error); }
      if (typeof charts !== "undefined" && document.getElementById("tab-analytics")?.style.display === "block") renderCharts();
    }

    // Apply the saved preference before the rest of the interface initializes.
    applyTheme(getSavedTheme());
    document.getElementById("btn-theme-toggle")?.addEventListener("click", () => {
      const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
      applyTheme(currentTheme === "dark" ? "light" : "dark");
    });


    function showToast(msg, isError = false) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.className = "toast-box";
      el.style.backgroundColor = isError ? "var(--danger)" : "var(--success)";
      el.style.color = "#ffffff";
      el.style.display = "block";
      el.classList.remove("hidden");
      setTimeout(() => { el.classList.add("hidden"); el.style.display = "none"; }, 3500);
    }

    // IndexedDB Wrapper for Master Data (Products, Customers, Bonus Policies)
    function openMasterDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("master")) {
            db.createObjectStore("master");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async function saveMasterKey(key, value) {
      const db = await openMasterDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("master", "readwrite");
        tx.objectStore("master").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async function loadMasterKey(key) {
      const db = await openMasterDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("master", "readonly");
        const req = tx.objectStore("master").get(key);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }

    async function clearMasterStore() {
      const db = await openMasterDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("master", "readwrite");
        tx.objectStore("master").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // Session Storage for Booking Data (auto-clears on tab/window close)
    function saveSessionBookings() {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        importedFiles: state.importedFiles,
        bookings: state.bookings,
        bookingDetails: state.bookingDetails
      }));
    }

    function loadSessionBookings() {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          state.importedFiles = parsed.importedFiles || [];
          state.bookings = parsed.bookings || [];
          state.bookingDetails = parsed.bookingDetails || [];
        }
      } catch (e) {
        console.warn("Session restore skipped:", e);
      }
    }

    // ==========================================
    // 2. CSV & OMF PARSERS (CLIENT-SIDE)
    // ==========================================
    function stripLeadingZeros(code) {
      const s = String(code || "").trim().replace(/^0+/, "");
      return s || "0";
    }

    function parseCSV(text) {
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) return [];
      const headers = parseCSVLine(lines[0]).map(h => h.trim());
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const vals = parseCSVLine(lines[i]);
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = (vals[idx] || "").trim(); });
        rows.push(obj);
      }
      return rows;
    }

    function parseCSVLine(line) {
      const result = [];
      let cur = "", inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
          else { inQuotes = !inQuotes; }
        } else if (ch === ',' && !inQuotes) {
          result.push(cur); cur = "";
        } else {
          cur += ch;
        }
      }
      result.push(cur);
      return result;
    }

    async function sha256Text(text) {
      const buf = new TextEncoder().encode(text);
      const hashBuf = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    async function parseOMFContent(filename, text) {
      const fileHash = await sha256Text(text);
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let header = {};
      const masterRecords = [];
      const detailRecords = [];
      let currentSection = null;

      for (const line of lines) {
        if (line.startsWith("[START SOMASTER]")) { currentSection = "SOMASTER"; continue; }
        if (line.startsWith("[END SOMASTER]")) { currentSection = null; continue; }
        if (line.startsWith("[START SODETAIL]")) { currentSection = "SODETAIL"; continue; }
        if (line.startsWith("[END SODETAIL]")) { currentSection = null; continue; }

        if (currentSection === null) {
          const parts = line.split(",");
          if (parts.length >= 7) {
            header = {
              document_type: parts[0],
              salesperson: parts[1],
              booking_date: parts[2],
              sequence_id: parts[3],
              unique_id: parts[4],
              transaction_date: parts[5],
              route_code: parts[6]
            };
          }
        } else if (currentSection === "SOMASTER") {
          const f = line.split("~;");
          if (f.length >= 14) {
            masterRecords.push({
              booking_number: f[1],
              file_hash: fileHash,
              filename: filename,
              booking_date: header.booking_date || "",
              booking_timestamp: f[2],
              customer_code: f[3].trim(),
              update_timestamp: f[4],
              booking_total: parseFloat(f[5]) || 0,
              gps_latitude: f[7],
              gps_longitude: f[8],
              salesperson: f[11],
              route_code: f[13]
            });
          }
        } else if (currentSection === "SODETAIL") {
          const f = line.split("~;");
          if (f.length >= 12) {
            const qty = parseInt(f[4], 10) || 0;
            const unitPrice = parseFloat(f[5]) || 0;
            detailRecords.push({
              booking_number: f[1],
              product_code: stripLeadingZeros(f[3]),
              quantity: qty,
              unit_price: unitPrice,
              line_total: qty * unitPrice
            });
          }
        }
      }
      return { fileHash, filename, header, masterRecords, detailRecords };
    }

    // ==========================================
    // 3. BONUS CALCULATION & UI RENDERING
    // ==========================================
    // Each policy entry in state.bonusPolicies has:
    // { id, sale_code, foc_code, tiers: [{ min_qty, bonus_qty, start_date, end_date }] }
    function normalizePolicies() {
      // Backward compatibility if any older flat policy items exist
      return (state.bonusPolicies || []).map((item, idx) => {
        if (Array.isArray(item.tiers)) return item;
        return {
          id: item.id || `pol_${idx}`,
          sale_code: stripLeadingZeros(item.product_code || item.sale_code || ""),
          foc_code: stripLeadingZeros(item.foc_code || item.product_code || ""),
          tiers: [{
            min_qty: Number(item.min_quantity) || 1,
            bonus_qty: Number(item.bonus_quantity) || 1,
            start_date: item.start_date || "",
            end_date: item.end_date || ""
          }]
        };
      });
    }

    function isDateWithinWindow(orderDateStr, startStr, endStr) {
      if (!startStr && !endStr) return true;
      if (!orderDateStr) return true;
      const ordTime = Date.parse(orderDateStr);
      if (Number.isNaN(ordTime)) return true;
      if (startStr) {
        const st = Date.parse(startStr);
        if (!Number.isNaN(st) && ordTime < st) return false;
      }
      if (endStr) {
        const en = Date.parse(endStr);
        if (!Number.isNaN(en) && ordTime > en) return false;
      }
      return true;
    }

    // Returns { selfBonus: number, crossBonuses: [{ foc_code, qty }] }
    function computeLineBonuses(productCode, qty, orderDate = "") {
      const normSale = stripLeadingZeros(productCode);
      const policies = normalizePolicies().filter(p => stripLeadingZeros(p.sale_code) === normSale);

      let selfBonus = 0;
      const crossMap = new Map();

      for (const pol of policies) {
        const normFoc = stripLeadingZeros(pol.foc_code || pol.sale_code);
        const validTiers = (pol.tiers || [])
          .filter(t => isDateWithinWindow(orderDate, t.start_date, t.end_date))
          .sort((a, b) => Number(b.min_qty) - Number(a.min_qty));

        let polBonus = 0;
        let rem = Number(qty) || 0;
        for (const tier of validTiers) {
          const minQ = Number(tier.min_qty);
          const bonQ = Number(tier.bonus_qty);
          if (minQ > 0 && rem >= minQ) {
            const mult = Math.floor(rem / minQ);
            polBonus += mult * bonQ;
            rem = rem % minQ;
          }
        }

        if (polBonus > 0) {
          if (normFoc === normSale) {
            selfBonus += polBonus;
          } else {
            crossMap.set(normFoc, (crossMap.get(normFoc) || 0) + polBonus);
          }
        }
      }

      const crossBonuses = Array.from(crossMap.entries()).map(([foc_code, qtyVal]) => ({
        foc_code,
        qty: qtyVal
      }));

      return { selfBonus, crossBonuses };
    }

    function computeBonus(productCode, qty, orderDate = "") {
      const res = computeLineBonuses(productCode, qty, orderDate);
      const crossTotal = res.crossBonuses.reduce((s, c) => s + c.qty, 0);
      return res.selfBonus + crossTotal;
    }

    function getCustomerMap() {
      const m = new Map();
      state.customers.forEach(c => m.set(String(c.customer_code).trim(), c));
      return m;
    }

    function getProductMap() {
      const m = new Map();
      state.products.forEach(p => m.set(stripLeadingZeros(p.product_code), p));
      return m;
    }

    function refreshAllUI() {
      const custMap = getCustomerMap();
      const prodMap = getProductMap();

      // Header badges & KPIs
      document.getElementById("badge-master").textContent = `Master: ${state.customers.length} Cust | ${state.products.length} Prod`;
      document.getElementById("badge-session").textContent = `Session Bookings: ${state.bookings.length}`;

      const totalBookings = state.bookings.length;
      const totalRev = state.bookings.reduce((acc, b) => acc + (Number(b.booking_total) || 0), 0);
      const totalLines = state.bookingDetails.length;
      const totalUnits = state.bookingDetails.reduce((acc, d) => acc + (Number(d.quantity) || 0), 0);
      const avgVal = totalBookings > 0 ? totalRev / totalBookings : 0;

      document.getElementById("kpi-bookings").textContent = totalBookings.toLocaleString();
      document.getElementById("kpi-revenue").textContent = `PKR ${totalRev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      document.getElementById("kpi-lines").textContent = totalLines.toLocaleString();
      document.getElementById("kpi-files").textContent = state.importedFiles.length;
      document.getElementById("kpi-units").textContent = totalUnits.toLocaleString();
      document.getElementById("kpi-avg").textContent = `PKR ${avgVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      document.getElementById("kpi-customers").textContent = state.customers.length.toLocaleString();
      document.getElementById("kpi-products").textContent = state.products.length.toLocaleString();

      // Imported OMF list
      const omfList = document.getElementById("omf-file-list");
      omfList.innerHTML = state.importedFiles.length
        ? state.importedFiles.map(f => `<div class="p-2 rounded bg-[#0d1117] border border-[#30363d] flex justify-between"><span>📄 ${f.filename}</span><span>${f.masterCount} orders | ${f.detailCount} lines</span></div>`).join("")
        : `<div>No OMF booking files loaded in this session yet.</div>`;

      // Filter dropdown in Bookings
      const fileSel = document.getElementById("filter-omf-file");
      const prevFile = fileSel.value;
      fileSel.innerHTML = `<option value="">All Imported Files (${state.importedFiles.length})</option>` +
        state.importedFiles.map(f => `<option value="${f.fileHash}">${f.filename}</option>`).join("");
      fileSel.value = prevFile;

      renderBookingsTable(custMap, prodMap);
      renderCustomersTable();
      renderProductsTable();
      populateBonusProductDropdowns(prodMap);
      renderBonusTable(prodMap);
      renderValidation(custMap, prodMap);
      renderCharts();
    }

    function renderBookingsTable(custMap, prodMap) {
      const selectedHash = document.getElementById("filter-omf-file").value;
      const filtered = selectedHash ? state.bookings.filter(b => b.file_hash === selectedHash) : state.bookings;

      const tbody = document.getElementById("tbody-bookings");
      tbody.innerHTML = filtered.length ? filtered.map(b => {
        const cust = custMap.get(b.customer_code);
        return `<tr>
          <td class="font-mono text-xs">${b.booking_number}</td>
          <td>${b.booking_date}</td>
          <td>${b.customer_code}</td>
          <td>${cust ? cust.customer_name : '<span class="text-[#f85149]">Unknown</span>'}</td>
          <td>${b.salesperson}</td>
          <td>${b.route_code}</td>
          <td class="font-semibold">PKR ${Number(b.booking_total).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
          <td class="text-xs text-[#8b949e]">${b.filename}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="8" class="text-center text-[#8b949e] py-6">No bookings in current session. Import an .omf file first.</td></tr>`;

      const detailSel = document.getElementById("select-booking-detail");
      const prevOrder = detailSel.value;
      detailSel.innerHTML = `<option value="">Select a customer order...</option>` +
        filtered.map(b => {
          const cName = custMap.get(b.customer_code)?.customer_name || b.customer_code;
          return `<option value="${b.booking_number}">${cName} (Booking: ${b.booking_number} - ${b.booking_date})</option>`;
        }).join("");
      detailSel.value = prevOrder;
      renderBookingLines(prodMap);
    }

    function updateOrderNavControls() {
      const sel = document.getElementById("select-booking-detail");
      const prevBtn = document.getElementById("btn-prev-order");
      const nextBtn = document.getElementById("btn-next-order");
      const counter = document.getElementById("order-nav-counter");
      const totalOrders = sel.options.length - 1; // exclude placeholder option
      const idx = sel.selectedIndex; // 0 is placeholder, 1..totalOrders are bookings

      if (totalOrders <= 0) {
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        counter.textContent = "0 / 0";
        return;
      }

      if (idx <= 0) {
        prevBtn.disabled = true;
        nextBtn.disabled = false;
        counter.textContent = `0 / ${totalOrders}`;
      } else {
        prevBtn.disabled = idx <= 1;
        nextBtn.disabled = idx >= totalOrders;
        counter.textContent = `${idx} / ${totalOrders}`;
      }
    }

    function stepOrderSelection(delta) {
      const sel = document.getElementById("select-booking-detail");
      const totalOrders = sel.options.length - 1;
      if (totalOrders <= 0) return;

      let nextIdx = sel.selectedIndex + delta;
      if (sel.selectedIndex <= 0 && delta > 0) {
        nextIdx = 1; // jump to first order when clicking Next from placeholder
      }
      if (nextIdx >= 1 && nextIdx <= totalOrders) {
        sel.selectedIndex = nextIdx;
        renderBookingLines();
      }
    }

    function renderBookingLines(prodMap = getProductMap()) {
      updateOrderNavControls();
      const bNum = document.getElementById("select-booking-detail").value;
      const tbody = document.getElementById("tbody-booking-lines");
      const meta = document.getElementById("booking-detail-meta");
      if (!bNum) {
        meta.textContent = "";
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-[#8b949e] py-4">Select an order above or use Next ▶ to inspect product lines and stacked bonuses.</td></tr>`;
        return;
      }
      const lines = state.bookingDetails.filter(d => d.booking_number === bNum);
      meta.textContent = `Showing ${lines.length} product line(s) for Booking #${bNum}`;
      tbody.innerHTML = lines.map(d => {
        const p = prodMap.get(stripLeadingZeros(d.product_code));
        const bookingObj = state.bookings.find(b => b.booking_number === bNum);
        const orderDate = bookingObj ? bookingObj.booking_date : "";
        const bInfo = computeLineBonuses(d.product_code, d.quantity, orderDate);
        const parts = [];
        if (bInfo.selfBonus > 0) parts.push(`+${bInfo.selfBonus}`);
        bInfo.crossBonuses.forEach(cb => {
          const focProd = prodMap.get(stripLeadingZeros(cb.foc_code));
          const focLabel = focProd ? focProd.product_name : cb.foc_code;
          parts.push(`+${cb.qty} FOC (${focLabel})`);
        });
        const bonusText = parts.length ? parts.join(" | ") : "-";
        return `<tr>
          <td class="font-mono">${d.product_code}</td>
          <td>${p ? p.product_name : '<span class="text-[#f85149]">Unmatched Product</span>'}</td>
          <td>${p ? (p.packing || '-') : '-'}</td>
          <td>${p ? (p.company || '-') : '-'}</td>
          <td>${d.quantity}</td>
          <td>${Number(d.unit_price).toFixed(2)}</td>
          <td>${Number(d.line_total).toFixed(2)}</td>
          <td class="font-bold text-[#3fb950]">${bonusText}</td>
        </tr>`;
      }).join("");
    }

    function renderCustomersTable() {
      const q = document.getElementById("search-customers").value.toLowerCase();
      const rows = state.customers.filter(c =>
        (c.customer_name || "").toLowerCase().includes(q) ||
        (c.customer_code || "").toLowerCase().includes(q)
      ).slice(0, 300);

      document.getElementById("tbody-customers").innerHTML = rows.length
        ? rows.map(c => `<tr>
            <td class="font-mono">${c.customer_code || ""}</td>
            <td>${c.customer_name || ""}</td>
            <td>${c.city || ""}</td>
            <td>${c.phone || ""}</td>
            <td class="text-xs text-[#8b949e]">${c.address || ""}</td>
          </tr>`).join("")
        : `<tr><td colspan="5" class="text-center text-[#8b949e] py-6">No customers loaded. Upload customers.csv in Import Files.</td></tr>`;
    }

    function renderProductsTable() {
      const q = document.getElementById("search-products").value.toLowerCase();
      const rows = state.products.filter(p =>
        (p.product_name || "").toLowerCase().includes(q) ||
        (p.product_code || "").toLowerCase().includes(q)
      ).slice(0, 300);

      document.getElementById("tbody-products").innerHTML = rows.length
        ? rows.map(p => `<tr>
            <td class="font-mono">${stripLeadingZeros(p.product_code)}</td>
            <td>${p.product_name || ""}</td>
            <td>${p.packing || ""}</td>
            <td>${p.company || ""}</td>
            <td>${p.category || ""}</td>
            <td>${p.trade_price || ""}</td>
          </tr>`).join("")
        : `<tr><td colspan="6" class="text-center text-[#8b949e] py-6">No products loaded. Upload products.csv in Import Files.</td></tr>`;
    }

    function populateBonusProductDropdowns(prodMap) {
      const saleSel = document.getElementById("bonus-sale-select");
      const focSel = document.getElementById("bonus-foc-select");
      if (!saleSel || !focSel) return;

      const prevSale = saleSel.value;
      const prevFoc = focSel.value;

      const optionsHtml = state.products.map(p => {
        const code = stripLeadingZeros(p.product_code);
        return `<option value="${code}">${code} - ${p.product_name || ""}</option>`;
      }).join("");

      saleSel.innerHTML = `<option value="">-- Select Sale Product from Catalog --</option>` + optionsHtml;
      focSel.innerHTML = `<option value="">-- Same as Sale Product (Default) --</option>` + optionsHtml;

      saleSel.value = prevSale;
      focSel.value = prevFoc;
    }

    function addDraftTierRow(minVal = "", bonusVal = "", startVal = "", endVal = "", focusMin = false) {
      const tbody = document.getElementById("tbody-bonus-draft-rows");
      if (!tbody) return;
      const tr = document.createElement("tr");
      tr.className = "bonus-draft-row";
      tr.innerHTML = `
        <td><input type="number" min="1" placeholder="e.g. 12" value="${minVal}" class="draft-min w-28 text-sm" /></td>
        <td><input type="number" min="1" placeholder="e.g. 1" value="${bonusVal}" class="draft-bonus w-28 text-sm" /></td>
        <td><input type="date" value="${startVal}" class="draft-start text-sm" /></td>
        <td><input type="date" value="${endVal}" class="draft-end text-sm" /></td>
        <td><button type="button" class="btn-remove-draft-row text-xs px-2.5 py-1 rounded bg-[#21262d] hover:bg-[#da3633] text-white border border-[#30363d]">✕</button></td>
      `;

      tr.querySelector(".btn-remove-draft-row").addEventListener("click", () => {
        if (tbody.querySelectorAll("tr").length > 1) {
          tr.remove();
        } else {
          tr.querySelectorAll("input").forEach(inp => inp.value = "");
        }
      });

      // Pressing Enter on any input in a draft row creates a new row right below
      tr.querySelectorAll("input").forEach(inp => {
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addDraftTierRow("", "", tr.querySelector(".draft-start").value, tr.querySelector(".draft-end").value, true);
          }
        });
      });

      tbody.appendChild(tr);
      if (focusMin) {
        tr.querySelector(".draft-min").focus();
      }
    }

    function resetBonusDraftBuilder() {
      const tbody = document.getElementById("tbody-bonus-draft-rows");
      if (!tbody) return;
      tbody.innerHTML = "";
      addDraftTierRow("", "", "", "", false);
    }

    function renderBonusTable(prodMap) {
      state.bonusPolicies = normalizePolicies();
      const tbody = document.getElementById("tbody-bonus");
      if (!tbody) return;

      tbody.innerHTML = state.bonusPolicies.length
        ? state.bonusPolicies.map((pol, idx) => {
            const saleCode = stripLeadingZeros(pol.sale_code);
            const focCode = stripLeadingZeros(pol.foc_code || pol.sale_code);
            const saleProd = prodMap.get(saleCode);
            const focProd = prodMap.get(focCode);

            const saleLabel = `<div><span class="font-mono">${saleCode}</span> — ${saleProd ? saleProd.product_name : "Unlisted"}</div>`;
            const focLabel = focCode === saleCode
              ? `<span class="text-xs px-2 py-0.5 rounded bg-[#21262d] text-[#c9d1d9]">Same as Sale (${focCode})</span>`
              : `<div><span class="font-mono text-[#3fb950]">${focCode}</span> — ${focProd ? focProd.product_name : "Unlisted"}</div>`;

            const tiersHtml = (pol.tiers || []).map(t => {
              const dateRange = (t.start_date || t.end_date)
                ? ` <span class="text-xs text-[#8b949e]">(${t.start_date || "Any"} → ${t.end_date || "Any"})</span>`
                : "";
              return `<span class="inline-block mr-2 mb-1 px-2 py-0.5 rounded bg-[#0d1117] border border-[#30363d] text-xs font-mono text-[#3fb950]">${t.min_qty} + ${t.bonus_qty}${dateRange}</span>`;
            }).join("");

            return `<tr>
              <td>${saleLabel}</td>
              <td>${focLabel}</td>
              <td>${tiersHtml}</td>
              <td><button onclick="deleteBonus(${idx})" class="text-xs px-2.5 py-1 rounded bg-[#da3633] text-white">Delete</button></td>
            </tr>`;
          }).join("")
        : `<tr><td colspan="4" class="text-center text-[#8b949e] py-4">No bonus policies configured yet.</td></tr>`;
    }

    window.deleteBonus = async function(idx) {
      state.bonusPolicies.splice(idx, 1);
      await saveMasterKey("bonusPolicies", state.bonusPolicies);
      refreshAllUI();
      showToast("Bonus policy removed.");
    };

    function renderValidation(custMap, prodMap) {
      const unknownCust = state.bookings.filter(b => !custMap.has(b.customer_code));
      const unknownProdSet = new Set();
      state.bookingDetails.forEach(d => {
        const norm = stripLeadingZeros(d.product_code);
        if (!prodMap.has(norm)) unknownProdSet.add(norm);
      });
      const unknownProds = Array.from(unknownProdSet);

      document.getElementById("val-cust-count").textContent = unknownCust.length;
      document.getElementById("tbody-val-cust").innerHTML = unknownCust.length
        ? unknownCust.map(b => `<tr><td>${b.booking_number}</td><td class="text-[#f85149] font-mono">${b.customer_code}</td></tr>`).join("")
        : `<tr><td colspan="2" class="text-[#3fb950]">All booking customer codes match master records.</td></tr>`;

      document.getElementById("val-prod-count").textContent = unknownProds.length;
      document.getElementById("tbody-val-prod").innerHTML = unknownProds.length
        ? unknownProds.map(code => `<tr><td class="text-[#f85149] font-mono">${code}</td></tr>`).join("")
        : `<tr><td class="text-[#3fb950]">All product codes match catalog.</td></tr>`;
    }

    function renderCharts() {
      const byDate = {}, bySP = {}, byRoute = {};
      state.bookings.forEach(b => {
        const val = Number(b.booking_total) || 0;
        byDate[b.booking_date] = (byDate[b.booking_date] || 0) + val;
        bySP[b.salesperson] = (bySP[b.salesperson] || 0) + val;
        byRoute[b.route_code] = (byRoute[b.route_code] || 0) + val;
      });

      const draw = (id, type, label, dataObj) => {
        if (charts[id]) charts[id].destroy();
        const ctx = document.getElementById(id).getContext("2d");
        const themeStyles = getComputedStyle(document.documentElement);
        const textColor = themeStyles.getPropertyValue("--text-secondary").trim() || "#53627e";
        const mutedColor = themeStyles.getPropertyValue("--text-muted").trim() || "#7e8ba5";
        const gridColor = themeStyles.getPropertyValue("--border-subtle").trim() || "#e5ebf5";
        charts[id] = new Chart(ctx, {
          type,
          data: {
            labels: Object.keys(dataObj),
            datasets: [{ label, data: Object.values(dataObj), backgroundColor: ["#2675e8", "#12a875", "#8b6be8", "#e9a23b", "#dc4c64", "#31a7b8"] }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: { legend: { labels: { color: textColor } }, title: { display: true, text: label, color: textColor } },
            scales: type === "pie" ? {} : {
              x: { ticks: { color: mutedColor }, grid: { color: gridColor } },
              y: { ticks: { color: mutedColor }, grid: { color: gridColor } }
            }
          }
        });
      };

      draw("chart-daily", "bar", "Daily Booking Value (PKR)", byDate);
      draw("chart-salesperson", "pie", "Salesperson Revenue Share", bySP);
      draw("chart-route", "bar", "Route-wise Sales Performance", byRoute);
    }

    // ==========================================
    // 4. EVENT LISTENERS
    // ==========================================
    document.querySelectorAll(".nav-btn[data-tab], .quick-action[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".nav-btn[data-tab], .quick-action[data-tab]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.dataset.tab;
        document.querySelectorAll(".tab-panel").forEach(p => { p.classList.add("hidden"); p.style.display = "none"; });
        const activePanel = document.getElementById(`tab-${tab}`);
        if (!activePanel) return;
        activePanel.classList.remove("hidden");
        activePanel.style.display = "block";
        if (tab === "analytics") renderCharts();
      });
    });

    document.getElementById("input-omf").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      let addedFiles = 0;
      for (const file of files) {
        const text = await file.text();
        const parsed = await parseOMFContent(file.name, text);
        if (state.importedFiles.some(f => f.fileHash === parsed.fileHash)) {
          showToast(`'${file.name}' is already loaded in this session.`, true);
          continue;
        }
        state.importedFiles.push({
          filename: parsed.filename,
          fileHash: parsed.fileHash,
          masterCount: parsed.masterRecords.length,
          detailCount: parsed.detailRecords.length
        });
        // Upsert by booking_number
        const existingMap = new Map(state.bookings.map(b => [b.booking_number, b]));
        parsed.masterRecords.forEach(m => existingMap.set(m.booking_number, m));
        state.bookings = Array.from(existingMap.values());
        state.bookingDetails.push(...parsed.detailRecords);
        addedFiles++;
      }
      if (addedFiles > 0) {
        saveSessionBookings();
        refreshAllUI();
        showToast(`Loaded ${addedFiles} OMF file(s) into temporary browser session.`);
      }
      e.target.value = "";
    });

    document.getElementById("input-products").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const rows = parseCSV(await file.text()).map(r => ({
        ...r,
        product_code: stripLeadingZeros(r.product_code)
      }));
      state.products = rows;
      await saveMasterKey("products", rows);
      refreshAllUI();
      showToast(`Saved ${rows.length} products in browser storage.`);
      e.target.value = "";
    });

    document.getElementById("input-customers").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const rows = parseCSV(await file.text());
      state.customers = rows;
      await saveMasterKey("customers", rows);
      refreshAllUI();
      showToast(`Saved ${rows.length} customers in browser storage.`);
      e.target.value = "";
    });

    document.getElementById("bonus-sale-select").addEventListener("change", (e) => {
      if (e.target.value) {
        document.getElementById("bonus-sale-code").value = e.target.value;
      }
    });

    document.getElementById("bonus-foc-select").addEventListener("change", (e) => {
      if (e.target.value) {
        document.getElementById("bonus-foc-code").value = e.target.value;
      }
    });

    document.getElementById("btn-add-tier-row").addEventListener("click", () => {
      addDraftTierRow("", "", "", "", true);
    });

    document.getElementById("btn-toggle-bonus-tutorial").addEventListener("click", () => {
      const tut = document.getElementById("bonus-csv-tutorial"); const isHidden = tut.classList.toggle("hidden"); tut.style.display = isHidden ? "none" : "block";
    });

    document.getElementById("btn-download-bonus-template").addEventListener("click", () => {
      const templateCsv = [
        "# BONUS POLICY CSV TEMPLATE & TUTORIAL",
        "# 1. sale_code: Product code sold (leading zeros stripped automatically, e.g. 1004)",
        "# 2. foc_code: Product code given as free bonus (leave blank for same product, or enter another product code for cross-product FOC like Brufen DS)",
        "# 3. min_qty: Minimum order quantity for this tier (e.g. 12, 40, 120)",
        "# 4. bonus_qty: Free bonus units for this tier (e.g. 1, 4, 20)",
        "# 5. start_date: Optional start date (YYYY-MM-DD) or leave blank",
        "# 6. end_date: Optional end date (YYYY-MM-DD) or leave blank",
        "# Note: Rows with the same sale_code and foc_code are grouped into stacked multi-tier policies.",
        "sale_code,foc_code,min_qty,bonus_qty,start_date,end_date",
        "1004,,12,1,2026-01-01,2026-12-31",
        "1004,,40,4,2026-01-01,2026-12-31",
        "1004,,120,20,2026-01-01,2026-12-31",
        "1001,1002,20,2,,"
      ].join("\r\n");

      const blob = new Blob([templateCsv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Bonus_Policies_Template_With_Tutorial.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("Downloaded Bonus_Policies_Template_With_Tutorial.csv");
    });

    document.getElementById("input-bonus-csv").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const rawText = await file.text();
      // Filter out comment/tutorial lines starting with '#'
      const cleanLines = rawText
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0 && !line.trim().startsWith("#"))
        .join("\n");

      const rows = parseCSV(cleanLines);
      if (!rows.length) {
        showToast("No policy rows found in CSV file.", true);
        e.target.value = "";
        return;
      }

      const groupedMap = new Map();
      let importedTiersCount = 0;

      for (const r of rows) {
        const saleRaw = (r.sale_code || r.product_code || "").trim();
        if (!saleRaw) continue;
        const saleCode = stripLeadingZeros(saleRaw);
        const focRaw = (r.foc_code || "").trim();
        const focCode = focRaw ? stripLeadingZeros(focRaw) : saleCode;
        const minQ = parseInt(r.min_qty || r.min_quantity || "0", 10);
        const bonQ = parseInt(r.bonus_qty || r.bonus_quantity || "0", 10);
        const startD = (r.start_date || "").trim();
        const endD = (r.end_date || "").trim();

        if (minQ > 0 && bonQ > 0) {
          const key = `${saleCode}__${focCode}`;
          if (!groupedMap.has(key)) {
            groupedMap.set(key, {
              id: "pol_csv_" + Date.now() + "_" + key,
              sale_code: saleCode,
              foc_code: focCode,
              tiers: []
            });
          }
          groupedMap.get(key).tiers.push({
            min_qty: minQ,
            bonus_qty: bonQ,
            start_date: startD,
            end_date: endD
          });
          importedTiersCount++;
        }
      }

      if (!importedTiersCount) {
        showToast("No valid min_qty / bonus_qty rows found in CSV.", true);
        e.target.value = "";
        return;
      }

      state.bonusPolicies = normalizePolicies();
      groupedMap.forEach((newPol) => {
        const existing = state.bonusPolicies.find(
          p => stripLeadingZeros(p.sale_code) === newPol.sale_code &&
               stripLeadingZeros(p.foc_code || p.sale_code) === newPol.foc_code
        );
        if (existing) {
          existing.tiers = [...(existing.tiers || []), ...newPol.tiers];
        } else {
          state.bonusPolicies.push(newPol);
        }
      });

      await saveMasterKey("bonusPolicies", state.bonusPolicies);
      refreshAllUI();
      showToast(`Imported ${importedTiersCount} bonus tier(s) into browser storage until cleared.`);
      e.target.value = "";
    });

    document.getElementById("btn-save-bonus-policy").addEventListener("click", async () => {
      const rawSale = document.getElementById("bonus-sale-code").value.trim() || document.getElementById("bonus-sale-select").value.trim();
      if (!rawSale) {
        showToast("Please select or enter a Sale Product first.", true);
        return;
      }
      const saleCode = stripLeadingZeros(rawSale);
      const rawFoc = document.getElementById("bonus-foc-code").value.trim() || document.getElementById("bonus-foc-select").value.trim();
      const focCode = rawFoc ? stripLeadingZeros(rawFoc) : saleCode;

      const tiers = [];
      document.querySelectorAll("#tbody-bonus-draft-rows tr.bonus-draft-row").forEach(tr => {
        const minQ = parseInt(tr.querySelector(".draft-min").value, 10);
        const bonQ = parseInt(tr.querySelector(".draft-bonus").value, 10);
        const startD = tr.querySelector(".draft-start").value || "";
        const endD = tr.querySelector(".draft-end").value || "";
        if (minQ > 0 && bonQ > 0) {
          tiers.push({ min_qty: minQ, bonus_qty: bonQ, start_date: startD, end_date: endD });
        }
      });

      if (!tiers.length) {
        showToast("Please enter at least one valid tier row (Min Qty and Bonus Free Qty).", true);
        return;
      }

      state.bonusPolicies = normalizePolicies();
      state.bonusPolicies.push({
        id: "pol_" + Date.now(),
        sale_code: saleCode,
        foc_code: focCode,
        tiers
      });

      await saveMasterKey("bonusPolicies", state.bonusPolicies);
      document.getElementById("bonus-sale-code").value = "";
      document.getElementById("bonus-foc-code").value = "";
      document.getElementById("bonus-sale-select").value = "";
      document.getElementById("bonus-foc-select").value = "";
      resetBonusDraftBuilder();
      refreshAllUI();
      showToast(`Saved policy with ${tiers.length} tier(s) in browser storage.`);
    });

    document.getElementById("filter-omf-file").addEventListener("change", () => renderBookingsTable(getCustomerMap(), getProductMap()));
    document.getElementById("select-booking-detail").addEventListener("change", () => renderBookingLines());
    document.getElementById("btn-prev-order").addEventListener("click", () => stepOrderSelection(-1));
    document.getElementById("btn-next-order").addEventListener("click", () => stepOrderSelection(1));
    document.getElementById("search-customers").addEventListener("input", renderCustomersTable);
    document.getElementById("search-products").addEventListener("input", renderProductsTable);

    document.getElementById("btn-export-excel").addEventListener("click", () => {
      const wb = XLSX.utils.book_new();
      const detailsWithBonus = state.bookingDetails.map(d => ({
        ...d,
        bonus_qty: computeBonus(d.product_code, d.quantity)
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.bookings), "Booking Summary");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailsWithBonus), "Booking Details");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.customers), "Customer Summary");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.products), "Product Summary");
      XLSX.writeFile(wb, "OMF_Comprehensive_Report.xlsx");
      showToast("Excel report downloaded!");
    });

    document.getElementById("btn-clear-session").addEventListener("click", () => {
      state.importedFiles = [];
      state.bookings = [];
      state.bookingDetails = [];
      sessionStorage.removeItem(SESSION_KEY);
      refreshAllUI();
      showToast("Current booking session cleared.");
    });

    document.getElementById("btn-clear-master").addEventListener("click", async () => {
      state.customers = [];
      state.products = [];
      state.bonusPolicies = [];
      await clearMasterStore();
      refreshAllUI();
      showToast("Master Products, Customers, and Bonus Policies cleared from browser.");
    });

    // Boot Application (with safe fallback if IndexedDB is restricted)
    (async function init() {
      try {
        loadSessionBookings();
      } catch (e) {
        console.warn("Session storage unavailable:", e);
      }
      try {
        state.customers = await loadMasterKey("customers");
        state.products = await loadMasterKey("products");
        state.bonusPolicies = await loadMasterKey("bonusPolicies");
      } catch (e) {
        console.warn("IndexedDB unavailable, using memory fallback:", e);
        state.customers = state.customers || [];
        state.products = state.products || [];
        state.bonusPolicies = state.bonusPolicies || [];
      }
      resetBonusDraftBuilder();
      refreshAllUI();
    })();