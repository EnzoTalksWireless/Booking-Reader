/* OMF Sales Analyzer — local historical data foundation
 * Separate IndexedDB database. No server or external AI dependency.
 */
(function () {
  "use strict";

  const DB_NAME = "OMF_SALES_ANALYZER";
  const DB_VERSION = 1;
  const STORE_IMPORTS = "sales_imports";
  const STORE_LINES = "sales_transactions";
  const STORE_STAGING = "staging_lines";
  const STORE_FEEDBACK = "anomaly_feedback";
  const STORE_SETTINGS = "analyzer_settings";

  let dbPromise = null;
  let pendingFiles = [];
  let isImporting = false;

  const $ = (id) => document.getElementById(id);

  function openSalesDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_IMPORTS)) {
          const store = db.createObjectStore(STORE_IMPORTS, { keyPath: "month" });
          store.createIndex("importedAt", "importedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_LINES)) {
          const store = db.createObjectStore(STORE_LINES, { keyPath: "id" });
          store.createIndex("month", "month", { unique: false });
          store.createIndex("customerId", "customerId", { unique: false });
          store.createIndex("productCode", "productCode", { unique: false });
          store.createIndex("customerProduct", "customerProduct", { unique: false });
          store.createIndex("monthCustomerProduct", ["month", "customerProduct"], { unique: false });
          store.createIndex("invoiceKey", "invoiceKey", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_STAGING)) {
          const store = db.createObjectStore(STORE_STAGING, { keyPath: "id" });
          store.createIndex("importToken", "importToken", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_FEEDBACK)) {
          const store = db.createObjectStore(STORE_FEEDBACK, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error("Could not open local sales database."));
      };
      request.onblocked = () => {
        reject(new Error("Sales database upgrade is blocked. Close other OMF Reader tabs and try again."));
      };
    });
    return dbPromise;
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Database transaction failed."));
      tx.onabort = () => reject(tx.error || new Error("Database transaction was cancelled."));
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function parseCsvRecords(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const input = String(text || "").replace(/^\uFEFF/, "");
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"') {
          if (input[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field.replace(/\r$/, ""));
        if (row.some((value) => String(value).trim() !== "")) rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
    if (field.length || row.length) {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => String(value).trim() !== "")) rows.push(row);
    }
    return rows;
  }

  function parseDate(value) {
    const raw = String(value || "").trim();
    let match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!match) return "";
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
    return [year, String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
  }

  function parseNumber(value) {
    const raw = String(value == null ? "" : value).trim().replace(/,/g, "");
    if (!raw || raw === "-" || raw === "—") return 0;
    const number = Number(raw);
    return Number.isFinite(number) ? number : null;
  }

  function parseCustomerHeader(value) {
    const match = String(value || "").trim().match(/^Customer:\s*(.*?)\s*\/\s*(.*?)\s*\/\s*Region:\s*(.*?)\s*\/\s*City:\s*(.*)$/i);
    if (!match) return null;
    return {
      customerId: match[1].trim(),
      customerName: match[2].trim(),
      region: match[3].trim(),
      city: match[4].trim()
    };
  }

  function extractReportPeriod(rows) {
    for (const row of rows.slice(0, 12)) {
      const text = row.join(" ");
      const match = text.match(/Date\s+From:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*To:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (match) {
        const startDate = parseDate(match[1]);
        const endDate = parseDate(match[2]);
        if (!startDate || !endDate) return null;
        return { startDate, endDate, month: startDate.slice(0, 7) };
      }
    }
    return null;
  }

  function makeLineId(line) {
    return [
      line.month, line.customerId, line.transactionId, line.transactionDate,
      line.productCode, line.batchNo, line.packSize, line.stock, line.bonus
    ].map((part) => encodeURIComponent(String(part == null ? "" : part))).join("|");
  }

  async function hashFile(file) {
    const buffer = await file.arrayBuffer();
    if (window.crypto && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return "fallback-" + [file.name, file.size, file.lastModified].join("-");
  }

  async function parseSalesReport(file) {
    const text = await file.text();
    const rows = parseCsvRecords(text);
    if (rows.length < 10) throw new Error("The file is too small or does not look like a Customer Wise Sales Report.");

    const period = extractReportPeriod(rows);
    if (!period) throw new Error("Could not find the report period ('Date From' / 'To') in the first rows.");

    const customers = new Map();
    const products = new Set();
    const invoices = new Set();
    const lineMap = new Map();
    const warnings = [];
    let customerSections = 0;
    let productRows = 0;
    let invalidRows = 0;
    let ignoredRows = 0;

    let currentCustomer = null;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const first = String(row[0] || "").trim();
      if (!first) {
        ignoredRows++;
        continue;
      }

      const customer = parseCustomerHeader(first);
      if (customer) {
        currentCustomer = customer;
        customerSections++;
        customers.set(customer.customerId, customer.customerName);
        continue;
      }

      if (/^Total\s+for\s+Customer\b/i.test(first) || /^Report\s+Total\b/i.test(first)) {
        ignoredRows++;
        continue;
      }

      const product = first.match(/^([A-Za-z0-9_-]+)\s*\/\s*(.+)$/);
      if (!product) {
        ignoredRows++;
        continue;
      }
      if (!currentCustomer) {
        invalidRows++;
        continue;
      }

      const transactionId = String(row[2] || "").trim();
      const transactionDate = parseDate(row[3]);
      const productCode = product[1].trim();
      const productName = product[2].trim();
      if (!transactionId || !transactionDate || !productCode || !productName) {
        invalidRows++;
        continue;
      }

      const stock = parseNumber(row[8]);
      const bonus = parseNumber(row[9]);
      if (stock === null || bonus === null || stock < 0 || bonus < 0) {
        invalidRows++;
        continue;
      }

      const line = {
        month: period.month,
        customerId: currentCustomer.customerId,
        customerName: currentCustomer.customerName,
        region: currentCustomer.region,
        city: currentCustomer.city,
        productCode,
        productName,
        transactionId,
        transactionDate,
        packSize: String(row[5] || "").trim(),
        batchNo: String(row[6] || "").trim(),
        expiryDate: parseDate(row[7]) || "",
        stock,
        bonus,
        rate: parseNumber(row[10]) || 0,
        grossAmount: parseNumber(row[11]) || 0,
        netAmount: parseNumber(row[15]) || 0,
        sourceRow: index + 1
      };
      line.customerProduct = line.customerId + "|" + line.productCode;
      line.invoiceKey = [line.customerId, line.transactionId, line.transactionDate].join("|");
      line.id = makeLineId(line);
      if (!lineMap.has(line.id)) {
        lineMap.set(line.id, line);
        productRows++;
      } else {
        warnings.push("Repeated identical transaction line(s) were collapsed using the line fingerprint.");
      }
      products.add(productCode);
      invoices.add(line.invoiceKey);
    }

    const lines = Array.from(lineMap.values());
    if (!lines.length) throw new Error("No valid product transaction lines were found.");
    if (invalidRows) warnings.push(invalidRows + " product-like row(s) were skipped because required fields or quantities were invalid.");
    if (period.startDate.slice(0, 7) !== period.endDate.slice(0, 7)) {
      warnings.push("The report period crosses calendar months. It will be assigned to " + period.month + " based on its start date.");
    }

    const fileHash = await hashFile(file);
    return {
      file,
      fileName: file.name,
      fileHash,
      period,
      lines,
      summary: {
        month: period.month,
        startDate: period.startDate,
        endDate: period.endDate,
        customerSections,
        customers: customers.size,
        products: products.size,
        invoices: invoices.size,
        lines: lines.length,
        invalidRows,
        ignoredRows,
        warnings
      }
    };
  }

  async function getAll(storeName) {
    const db = await openSalesDB();
    const tx = db.transaction(storeName, "readonly");
    const done = txDone(tx);
    const resultPromise = requestResult(tx.objectStore(storeName).getAll());
    const result = await resultPromise;
    await done;
    return result;
  }

  async function getImport(month) {
    const db = await openSalesDB();
    const tx = db.transaction(STORE_IMPORTS, "readonly");
    const done = txDone(tx);
    const resultPromise = requestResult(tx.objectStore(STORE_IMPORTS).get(month));
    const result = await resultPromise;
    await done;
    return result || null;
  }

  async function getCounts() {
    const db = await openSalesDB();
    const tx = db.transaction([STORE_IMPORTS, STORE_LINES], "readonly");
    const done = txDone(tx);
    const importsRequest = requestResult(tx.objectStore(STORE_IMPORTS).count());
    const linesRequest = requestResult(tx.objectStore(STORE_LINES).count());
    const values = await Promise.all([importsRequest, linesRequest]);
    await done;
    return { imports: values[0], lines: values[1] };
  }

  async function putStagingChunk(token, lines, offset) {
    const db = await openSalesDB();
    const tx = db.transaction(STORE_STAGING, "readwrite");
    const store = tx.objectStore(STORE_STAGING);
    lines.forEach((line, index) => {
      store.put({ id: token + "|" + (offset + index), importToken: token, line });
    });
    await txDone(tx);
  }

  async function clearStagingToken(token) {
    const db = await openSalesDB();
    const tx = db.transaction(STORE_STAGING, "readwrite");
    const index = tx.objectStore(STORE_STAGING).index("importToken");
    const request = index.openCursor(IDBKeyRange.only(token));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    await txDone(tx);
  }

  async function commitMonthImport(parsed) {
    const db = await openSalesDB();
    const token = "import-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    try {
      const chunkSize = 750;
      for (let offset = 0; offset < parsed.lines.length; offset += chunkSize) {
        await putStagingChunk(token, parsed.lines.slice(offset, offset + chunkSize), offset);
        setProgress("Preparing " + parsed.fileName + ": " + Math.min(offset + chunkSize, parsed.lines.length).toLocaleString() + " / " + parsed.lines.length.toLocaleString() + " lines");
      }

      const tx = db.transaction([STORE_LINES, STORE_IMPORTS, STORE_STAGING], "readwrite");
      const sales = tx.objectStore(STORE_LINES);
      const imports = tx.objectStore(STORE_IMPORTS);
      const staging = tx.objectStore(STORE_STAGING);

      const oldRequest = sales.index("month").openCursor(IDBKeyRange.only(parsed.period.month));
      oldRequest.onsuccess = () => {
        const cursor = oldRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
          return;
        }
        const stagedRequest = staging.index("importToken").openCursor(IDBKeyRange.only(token));
        stagedRequest.onsuccess = () => {
          const stagedCursor = stagedRequest.result;
          if (stagedCursor) {
            sales.put(stagedCursor.value.line);
            stagedCursor.delete();
            stagedCursor.continue();
            return;
          }
          imports.put({
            month: parsed.period.month,
            fileName: parsed.fileName,
            fileHash: parsed.fileHash,
            startDate: parsed.period.startDate,
            endDate: parsed.period.endDate,
            lineCount: parsed.lines.length,
            customerCount: parsed.summary.customers,
            productCount: parsed.summary.products,
            invoiceCount: parsed.summary.invoices,
            importedAt: new Date().toISOString(),
            parserVersion: 1
          });
        };
      };
      await txDone(tx);
    } catch (error) {
      try { await clearStagingToken(token); } catch (_) {}
      throw error;
    }
  }

  function monthOffset(month, delta) {
    const parts = month.split("-").map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1 + delta, 1));
    return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
  }

  async function pruneTo24Months() {
    const imports = await getAll(STORE_IMPORTS);
    if (!imports.length) return { removedMonths: 0, cutoff: "" };
    const months = imports.map((item) => item.month).sort();
    const latest = months[months.length - 1];
    const cutoff = monthOffset(latest, -23);
    const oldMonths = months.filter((month) => month < cutoff);
    if (!oldMonths.length) return { removedMonths: 0, cutoff };

    const db = await openSalesDB();
    const tx = db.transaction([STORE_LINES, STORE_IMPORTS], "readwrite");
    const sales = tx.objectStore(STORE_LINES);
    const range = IDBKeyRange.upperBound(cutoff, true);
    const lineCursor = sales.index("month").openCursor(range);
    lineCursor.onsuccess = () => {
      const cursor = lineCursor.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    const importCursor = tx.objectStore(STORE_IMPORTS).openCursor(range);
    importCursor.onsuccess = () => {
      const cursor = importCursor.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    await txDone(tx);
    return { removedMonths: oldMonths.length, cutoff };
  }

  function setProgress(message, percent) {
    const label = $("sales-import-progress-label");
    const bar = $("sales-import-progress-bar");
    const wrap = $("sales-import-progress");
    if (label) label.textContent = message || "";
    if (wrap) wrap.style.display = message ? "block" : "none";
    if (bar && typeof percent === "number") bar.style.width = Math.max(0, Math.min(100, percent)) + "%";
  }

  function showMessage(message, isError) {
    const box = $("sales-import-message");
    if (!box) return;
    box.textContent = message;
    box.className = "sales-message " + (isError ? "sales-message-error" : "sales-message-success");
    box.style.display = "block";
  }

  function renderPreview() {
    const body = $("sales-preview-body");
    const wrap = $("sales-preview-wrap");
    const apply = $("btn-sales-apply-import");
    if (!body || !wrap || !apply) return;
    body.innerHTML = "";
    const seen = new Set();
    pendingFiles.forEach((item, index) => {
      const month = item.summary.month;
      const duplicateInSelection = seen.has(month);
      seen.add(month);
      const tr = document.createElement("tr");
      const warnings = item.summary.warnings.length + (duplicateInSelection ? 1 : 0);
      const replaceCell = document.createElement("td");
      if (item.existing && item.existing.fileHash !== item.fileHash) {
        const label = document.createElement("label");
        label.className = "sales-inline-check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.replaceIndex = String(index);
        label.append(input, document.createTextNode(" Replace"));
        replaceCell.append(label);
      } else if (item.existing && item.existing.fileHash === item.fileHash) {
        replaceCell.textContent = "Already imported";
      } else {
        replaceCell.textContent = "New month";
      }
      const cells = [
        item.fileName,
        month,
        item.summary.lines.toLocaleString(),
        item.summary.customers.toLocaleString(),
        item.summary.invoices.toLocaleString(),
        item.summary.error ? "Invalid: " + item.summary.error : (duplicateInSelection ? "Duplicate month in selection" : (warnings ? warnings + " warning(s)" : "Ready"))
      ];
      cells.forEach((value) => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      });
      tr.append(replaceCell);
      if (duplicateInSelection) tr.classList.add("sales-row-warning");
      body.append(tr);
      item.duplicateInSelection = duplicateInSelection;
    });
    wrap.style.display = pendingFiles.length ? "block" : "none";
    apply.disabled = !pendingFiles.length || pendingFiles.some((item) => item.duplicateInSelection);
  }

  async function prepareFiles(files) {
    pendingFiles = [];
    showMessage("Reading and validating selected reports…", false);
    setProgress("Validating files…", 0);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const parsed = await parseSalesReport(file);
        const existing = await getImport(parsed.period.month);
        pendingFiles.push({
          file,
          fileName: file.name,
          fileHash: parsed.fileHash,
          summary: parsed.summary,
          existing
        });
      } catch (error) {
        pendingFiles.push({
          file,
          fileName: file.name,
          fileHash: "",
          summary: {
            month: "Invalid",
            lines: 0,
            customers: 0,
            invoices: 0,
            warnings: [error.message],
            error: error.message
          },
          existing: null
        });
      }
      setProgress("Validated " + (i + 1) + " of " + files.length + " file(s)", ((i + 1) / files.length) * 100);
    }
    setProgress("", 0);
    renderPreview();
    const valid = pendingFiles.filter((item) => !item.summary.error).length;
    const invalid = pendingFiles.length - valid;
    showMessage(valid + " valid report(s), " + invalid + " invalid report(s). Review the preview before importing.", invalid > 0);
  }

  async function applyImports() {
    if (isImporting || !pendingFiles.length) return;
    const replaceIndexes = new Set(Array.from(document.querySelectorAll("[data-replace-index]:checked")).map((el) => Number(el.dataset.replaceIndex)));
    const candidates = pendingFiles.filter((item, index) => {
      if (item.summary.error || item.duplicateInSelection) return false;
      if (item.existing && item.existing.fileHash === item.fileHash) return false;
      if (item.existing && !replaceIndexes.has(index)) return false;
      return true;
    });
    if (!candidates.length) {
      showMessage("Nothing to import. Select Replace for an existing month, or choose a different report.", true);
      return;
    }
    if (!window.confirm("Import " + candidates.length + " monthly report(s) into this browser? Existing months marked Replace will be replaced.")) return;

    isImporting = true;
    $("btn-sales-apply-import").disabled = true;
    let completed = 0;
    const errors = [];
    try {
      for (const item of candidates) {
        try {
          setProgress("Importing " + item.fileName + "…", 0);
          const parsed = await parseSalesReport(item.file);
          if (parsed.fileHash !== item.fileHash || parsed.period.month !== item.summary.month) {
            throw new Error("The selected file changed after preview. Please validate it again.");
          }
          await commitMonthImport(parsed);
          completed++;
        } catch (error) {
          errors.push(item.fileName + ": " + error.message);
        }
        setProgress("Imported " + completed + " of " + candidates.length + " report(s)", (completed / candidates.length) * 100);
      }
      const retention = await pruneTo24Months();
      await refreshSalesData();
      pendingFiles = [];
      $("input-sales-csv").value = "";
      $("sales-preview-wrap").style.display = "none";
      if (errors.length) {
        showMessage(completed + " report(s) imported. " + errors.length + " failed: " + errors.join(" | "), true);
      } else {
        let message = completed + " report(s) imported successfully.";
        if (retention.removedMonths) message += " " + retention.removedMonths + " older month(s) removed to maintain the 24-month window.";
        showMessage(message, false);
      }
    } catch (error) {
      showMessage("Import process stopped: " + error.message, true);
    } finally {
      isImporting = false;
      setProgress("", 0);
      $("btn-sales-apply-import").disabled = false;
      renderPreview();
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function refreshSalesData() {
    const counts = await getCounts();
    const imports = (await getAll(STORE_IMPORTS)).sort((a, b) => a.month.localeCompare(b.month));
    const salesLines = await getAll(STORE_LINES);
    refreshLearningProfiles(salesLines, imports);
    if ($("sales-month-count")) $("sales-month-count").textContent = counts.imports.toLocaleString();
    if ($("sales-line-count")) $("sales-line-count").textContent = counts.lines.toLocaleString();
    if ($("sales-range")) $("sales-range").textContent = imports.length ? imports[0].month + " — " + imports[imports.length - 1].month : "No history imported";
    const body = $("sales-import-history");
    if (body) {
      body.innerHTML = "";
      if (!imports.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.className = "text-muted";
        td.textContent = "No monthly sales reports imported yet.";
        tr.append(td);
        body.append(tr);
      } else {
        imports.slice().reverse().forEach((item) => {
          const tr = document.createElement("tr");
          [item.month, item.fileName, item.lineCount.toLocaleString(), item.customerCount.toLocaleString(), item.invoiceCount.toLocaleString(), new Date(item.importedAt).toLocaleString()].forEach((value) => {
            const td = document.createElement("td");
            td.textContent = value;
            tr.append(td);
          });
          body.append(tr);
        });
      }
    }
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        if ($("sales-storage-usage")) $("sales-storage-usage").textContent = formatBytes(estimate.usage || 0) + " used / " + formatBytes(estimate.quota || 0) + " available quota";
      } catch (_) {}
    }
    if ($("sales-db-status")) $("sales-db-status").textContent = "Connected · local IndexedDB";
  }


  // Build customer-product learning profiles from invoice-level quantities.
  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function buildLearningProfiles(lines, importedMonths) {
    const invoices = new Map();
    const monthSet = new Set(importedMonths.map((item) => item.month));
    lines.forEach((line) => {
      const key = line.customerProduct + "|" + line.invoiceKey;
      let invoice = invoices.get(key);
      if (!invoice) {
        invoice = {
          customerId: line.customerId,
          customerName: line.customerName,
          region: line.region,
          city: line.city,
          productCode: line.productCode,
          productName: line.productName,
          invoiceKey: line.invoiceKey,
          date: line.transactionDate,
          month: line.month,
          stock: 0,
          bonus: 0
        };
        invoices.set(key, invoice);
      }
      invoice.stock += Number(line.stock) || 0;
      invoice.bonus += Number(line.bonus) || 0;
    });

    const groups = new Map();
    invoices.forEach((invoice) => {
      const key = invoice.customerId + "|" + invoice.productCode;
      let group = groups.get(key);
      if (!group) {
        group = {
          customerId: invoice.customerId,
          customerName: invoice.customerName,
          region: invoice.region,
          city: invoice.city,
          productCode: invoice.productCode,
          productName: invoice.productName,
          invoices: [],
          months: new Map(),
          totalStock: 0,
          totalBonus: 0
        };
        groups.set(key, group);
      }
      group.invoices.push(invoice);
      group.totalStock += invoice.stock;
      group.totalBonus += invoice.bonus;
      const monthly = group.months.get(invoice.month) || { stock: 0, bonus: 0, invoices: 0 };
      monthly.stock += invoice.stock;
      monthly.bonus += invoice.bonus;
      if (invoice.stock > 0 || invoice.bonus > 0) monthly.invoices++;
      group.months.set(invoice.month, monthly);
    });

    const profiles = Array.from(groups.values()).map((group) => {
      const purchases = group.invoices
        .filter((invoice) => invoice.stock > 0 || invoice.bonus > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      const stockPerInvoice = purchases.map((invoice) => invoice.stock);
      const bonusPerInvoice = purchases.map((invoice) => invoice.bonus);
      const gaps = [];
      for (let i = 1; i < purchases.length; i++) {
        const previous = new Date(purchases[i - 1].date + "T00:00:00Z");
        const current = new Date(purchases[i].date + "T00:00:00Z");
        const days = Math.round((current - previous) / 86400000);
        if (days >= 0) gaps.push(days);
      }
      const activeMonths = Array.from(group.months.keys()).filter((month) => {
        const value = group.months.get(month);
        return value.stock > 0 || value.bonus > 0;
      });
      const monthlyStock = activeMonths.map((month) => group.months.get(month).stock);
      const monthlyBonus = activeMonths.map((month) => group.months.get(month).bonus);
      const latest = purchases[purchases.length - 1];
      return {
        customerId: group.customerId,
        customerName: group.customerName,
        region: group.region,
        city: group.city,
        productCode: group.productCode,
        productName: group.productName,
        totalStock: group.totalStock,
        totalBonus: group.totalBonus,
        purchaseCount: purchases.length,
        activeMonths: activeMonths.length,
        avgStockPerPurchase: purchases.length ? group.totalStock / purchases.length : 0,
        avgBonusPerPurchase: purchases.length ? group.totalBonus / purchases.length : 0,
        medianStockPerPurchase: median(stockPerInvoice),
        medianBonusPerPurchase: median(bonusPerInvoice),
        avgStockPerActiveMonth: activeMonths.length ? group.totalStock / activeMonths.length : 0,
        avgBonusPerActiveMonth: activeMonths.length ? group.totalBonus / activeMonths.length : 0,
        avgDaysBetweenPurchases: gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null,
        lastPurchaseDate: latest ? latest.date : "",
        lastPurchaseMonth: latest ? latest.month : "",
        monthlyHistory: group.months
      };
    });
    profiles.sort((a, b) => (b.totalStock + b.totalBonus) - (a.totalStock + a.totalBonus));
    return {
      profiles,
      totals: {
        pairs: profiles.length,
        customers: new Set(profiles.map((item) => item.customerId)).size,
        products: new Set(profiles.map((item) => item.productCode)).size,
        stock: profiles.reduce((sum, item) => sum + item.totalStock, 0),
        bonus: profiles.reduce((sum, item) => sum + item.totalBonus, 0),
        invoices: purchasesCount(invoices)
      }
    };
  }

  function purchasesCount(invoices) {
    return Array.from(invoices.values()).filter((invoice) => invoice.stock > 0 || invoice.bonus > 0).length;
  }

  let learningProfiles = [];
  let learningTotals = { pairs: 0, customers: 0, products: 0, stock: 0, bonus: 0, invoices: 0 };

  function formatQuantity(value) {
    return (Number(value) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function renderLearningProfiles() {
    const body = $("sales-learning-body");
    if (!body) return;
    const search = String($("sales-learning-search")?.value || "").trim().toLowerCase();
    const filtered = learningProfiles.filter((profile) => {
      const haystack = [profile.customerId, profile.customerName, profile.productCode, profile.productName, profile.city, profile.region].join(" ").toLowerCase();
      return !search || haystack.includes(search);
    });
    body.innerHTML = "";
    if (!filtered.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 11;
      td.className = "text-muted";
      td.textContent = learningProfiles.length ? "No customer/product profiles match this search." : "Import historical sales reports to build learning profiles.";
      tr.append(td);
      body.append(tr);
    } else {
      filtered.slice(0, 300).forEach((profile) => {
        const tr = document.createElement("tr");
        const values = [
          profile.customerName + " (" + profile.customerId + ")",
          profile.productName,
          profile.productCode,
          formatQuantity(profile.totalStock),
          formatQuantity(profile.totalBonus),
          profile.purchaseCount.toLocaleString(),
          profile.activeMonths.toLocaleString(),
          formatQuantity(profile.medianStockPerPurchase),
          formatQuantity(profile.medianBonusPerPurchase),
          profile.avgDaysBetweenPurchases == null ? "—" : formatQuantity(profile.avgDaysBetweenPurchases) + " days",
          profile.lastPurchaseDate || "—"
        ];
        values.forEach((value) => {
          const td = document.createElement("td");
          td.textContent = value;
          tr.append(td);
        });
        body.append(tr);
      });
    }
    const count = $("sales-learning-result-count");
    if (count) count.textContent = filtered.length.toLocaleString() + " profile(s)" + (filtered.length > 300 ? " · showing first 300" : "");
    const pairs = $("sales-learning-pairs");
    const customers = $("sales-learning-customers");
    const products = $("sales-learning-products");
    const stock = $("sales-learning-stock");
    const bonus = $("sales-learning-bonus");
    if (pairs) pairs.textContent = learningTotals.pairs.toLocaleString();
    if (customers) customers.textContent = learningTotals.customers.toLocaleString();
    if (products) products.textContent = learningTotals.products.toLocaleString();
    if (stock) stock.textContent = formatQuantity(learningTotals.stock);
    if (bonus) bonus.textContent = formatQuantity(learningTotals.bonus);
  }

  function refreshLearningProfiles(lines, imports) {
    const result = buildLearningProfiles(lines, imports);
    learningProfiles = result.profiles;
    learningTotals = result.totals;
    renderLearningProfiles();
  }

  async function exportBackup() {
    const db = await openSalesDB();
    const stores = [STORE_IMPORTS, STORE_LINES, STORE_FEEDBACK, STORE_SETTINGS];
    const tx = db.transaction(stores, "readonly");
    const done = txDone(tx);
    const backup = { format: "omf-sales-backup", version: 1, createdAt: new Date().toISOString(), data: {} };
    const requests = stores.map((name) => requestResult(tx.objectStore(name).getAll()));
    const values = await Promise.all(requests);
    stores.forEach((name, index) => { backup.data[name] = values[index]; });
    await done;
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "OMF_SALES_BACKUP_" + new Date().toISOString().slice(0, 10) + ".json";
    link.click();
    URL.revokeObjectURL(url);
    showMessage("Sales database backup exported. Store it somewhere separate from this computer.", false);
  }

  async function restoreBackup(file) {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (!backup || backup.format !== "omf-sales-backup" || backup.version !== 1 || !backup.data || !Array.isArray(backup.data[STORE_LINES]) || !Array.isArray(backup.data[STORE_IMPORTS])) {
      throw new Error("This is not a supported OMF Sales Analyzer backup.");
    }
    if (!window.confirm("Restore this backup? The current Sales Analyzer database will be replaced.")) return;
    const db = await openSalesDB();
    const stores = [STORE_IMPORTS, STORE_LINES, STORE_FEEDBACK, STORE_SETTINGS];
    const tx = db.transaction(stores, "readwrite");
    stores.forEach((name) => tx.objectStore(name).clear());
    backup.data[STORE_IMPORTS].forEach((record) => tx.objectStore(STORE_IMPORTS).put(record));
    backup.data[STORE_FEEDBACK].forEach((record) => tx.objectStore(STORE_FEEDBACK).put(record));
    backup.data[STORE_SETTINGS].forEach((record) => tx.objectStore(STORE_SETTINGS).put(record));
    const lines = backup.data[STORE_LINES];
    for (let offset = 0; offset < lines.length; offset += 500) {
      lines.slice(offset, offset + 500).forEach((record) => tx.objectStore(STORE_LINES).put(record));
    }
    await txDone(tx);
    await refreshSalesData();
    showMessage("Backup restored successfully. Verify the month range and record counts.", false);
  }

  async function requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) {
      showMessage("Persistent storage protection is not supported by this browser. Keep regular external backups.", true);
      return;
    }
    const granted = await navigator.storage.persist();
    showMessage(granted ? "Browser persistent storage protection was granted." : "The browser did not grant persistent storage protection. Keep regular external backups.", !granted);
  }

  function init() {
    if (!$("tab-sales-data")) return;
    $("input-sales-csv").addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || []);
      if (!files.length) return;
      await prepareFiles(files);
    });
    $("btn-sales-apply-import").addEventListener("click", applyImports);
    $("sales-learning-search")?.addEventListener("input", renderLearningProfiles);
    $("btn-sales-clear-preview").addEventListener("click", () => {
      pendingFiles = [];
      $("input-sales-csv").value = "";
      $("sales-preview-wrap").style.display = "none";
      $("sales-import-message").style.display = "none";
      setProgress("", 0);
    });
    $("btn-sales-export-backup").addEventListener("click", () => exportBackup().catch((error) => showMessage("Backup failed: " + error.message, true)));
    $("input-sales-restore").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try { await restoreBackup(file); }
      catch (error) { showMessage("Restore failed: " + error.message, true); }
      event.target.value = "";
    });
    $("btn-sales-persist").addEventListener("click", () => requestPersistentStorage().catch((error) => showMessage(error.message, true)));
    openSalesDB()
      .then(refreshSalesData)
      .catch((error) => {
        if ($("sales-db-status")) $("sales-db-status").textContent = "Database unavailable";
        showMessage("Local Sales Analyzer database could not be opened: " + error.message, true);
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
