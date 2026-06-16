const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const text = {
  ready: "\u51c6\u5907\u5c31\u7eea\u3002",
  localStarted: "\u5df2\u542f\u52a8\uff0c\u7b49\u5f85\u8fde\u63a5\u771f\u5b9e\u8bbe\u5907\u3002",
  saved: "\u8bbe\u7f6e\u5df2\u4fdd\u5b58\u3002",
  refreshed: "\u72b6\u6001\u5df2\u5237\u65b0\u3002",
  loggedIn: "\u6d4b\u8bd5\u8fde\u63a5\u5df2\u5b8c\u6210\u3002",
  loggedOut: "\u5df2\u9000\u51fa\u3002",
  reboot: "\u91cd\u542f\u6307\u4ee4\u5df2\u8bb0\u5f55\u3002",
  airplaneOn: "\u98de\u884c\u6a21\u5f0f\u5df2\u542f\u7528\u3002",
  airplaneOff: "\u98de\u884c\u6a21\u5f0f\u5df2\u5173\u95ed\u3002",
  directOk: "\u5df2\u4ece\u70fd\u706b\u540e\u53f0\u8bfb\u53d6\u72b6\u6001\u3002",
  directFail: "\u70fd\u706b\u540e\u53f0\u76f4\u8fde\u5931\u8d25\uff0c\u53ef\u80fd\u662f\u63a5\u53e3\u8def\u5f84\u4e0d\u5bf9\u6216\u624b\u673a\u6d4f\u89c8\u5668\u8de8\u57df\u9650\u5236\u3002",
  proxyFail: "\u7535\u8111\u4ee3\u7406\u4e0d\u53ef\u7528\uff0c\u8bf7\u5148\u542f\u52a8\u672c\u5730\u670d\u52a1\u3002",
  probeStart: "\u6b63\u5728\u63a2\u6d4b\u70fd\u706b\u540e\u53f0\u63a5\u53e3\u3002",
  probeNone: "\u6ca1\u6709\u627e\u5230\u660e\u663e\u7684\u72b6\u6001\u63a5\u53e3\uff0c\u9700\u8981\u770b\u540e\u53f0\u7f51\u9875\u7684\u8bf7\u6c42\u8bb0\u5f55\u3002",
  phoneNoNative: "\u5f53\u524d\u4e0d\u662f APK \u73af\u5883\uff0c\u65e0\u6cd5\u8bfb\u53d6\u624b\u673a\u81ea\u8eab\u4fe1\u53f7\u3002",
  phoneReading: "\u6b63\u5728\u8bfb\u53d6\u624b\u673a\u4fe1\u53f7\u3002",
};

const vendorLabel = {
  firehome: "\u70fd\u706b",
  huawei: "\u534e\u4e3a",
  zte: "\u4e2d\u5174",
  generic: "\u901a\u7528",
};

const protocolLabel = {
  "firehome-api": "\u70fd\u706b\u52a0\u5bc6 API",
  "firehome-http": "\u70fd\u706b HTTP \u540e\u53f0",
  proxy: "\u7535\u8111\u4ee3\u7406",
};

let currentState = null;
let currentSettings = null;
let refreshTimer = null;
let phoneRefreshTimer = null;
let deferredInstallPrompt = null;

const fallbackState = {
  connected: false,
  operator: "--",
  mode: "--",
  vendor: "firehome",
  model: "--",
  version: "--",
  temperature: null,
  downContract: null,
  upContract: null,
  qci: "--",
  band: "--",
  arfcn: "--",
  pci: "--",
  tac: "--",
  gCellId: "--",
  metrics: {
    nrRsrp: null,
    nrRsrq: null,
    nrSinr: null,
    nrDlbw: null,
    nrUlbw: null,
    pusch: null,
    pucch: null,
    nrDlMcs: null,
    nrUlMcs: null,
    nrCqi: null,
    mimoDl: "--",
    mimoUl: "--",
  },
  traffic: {
    downloadRateKbps: null,
    uploadRateKbps: null,
    todayDownloadGb: null,
    todayUploadGb: null,
    monthDownloadGb: null,
    monthUploadGb: null,
  },
  cells: [],
  airplaneMode: false,
};

const fallbackSettings = {
  host: "192.168.8.1",
  port: 80,
  username: "admin",
  password: "",
  vendor: "firehome",
  protocol: "firehome-api",
  statusPath: "/api/status",
  loginPath: "/",
  autoRefresh: false,
  refreshInterval: 3,
  lockBands: [],
};

const fallbackLogs = [
  { time: new Date().toLocaleString("zh-CN", { hour12: false }), text: text.localStarted },
];

const probePaths = [
  "GET /api/tmp/FHNCAPIS?ajaxmethod=get_refresh_sessionid",
  "GET /api/status",
  "GET /api/device/status",
  "GET /api/system/status",
  "GET /api/monitor/status",
  "GET /status.json",
  "GET /status",
  "GET /goform/goform_get_cmd_process?cmd=nr5g_action_band,nr5g_dlEarfcn,nr5g_pci,nr5g_rsrp,nr5g_rsrq,nr5g_sinr,nr5g_cell_id,lte_rsrp,lte_rsrq,lte_snr,wan_ipaddr",
  "GET /cgi-bin/luci",
  "GET /",
];

function setMessage(message) {
  $("#messageLine").textContent = message;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function migrateSavedStore(saved) {
  if (!saved) return saved;
  saved.settings = { ...fallbackSettings, ...saved.settings };
  if (saved.settings.protocol === "demo") saved.settings.protocol = "firehome-api";
  saved.state = clone(fallbackState);
  saved.logs = Array.isArray(saved.logs) ? saved.logs : clone(fallbackLogs);
  saved.schemaVersion = 5;

  if (saved.settings.host === "192.168.1.1") saved.settings.host = fallbackSettings.host;
  if (saved.settings.lockBands?.includes("N78")) saved.settings.lockBands = [];

  return saved;
}

function localStore() {
  const saved = JSON.parse(localStorage.getItem("local-cpe-manager") || "null");
  if (saved) {
    const migrated = migrateSavedStore(saved);
    localStorage.setItem("local-cpe-manager", JSON.stringify(migrated));
    return migrated;
  }
  const fresh = { schemaVersion: 5, state: clone(fallbackState), settings: clone(fallbackSettings), logs: clone(fallbackLogs) };
  localStorage.setItem("local-cpe-manager", JSON.stringify(fresh));
  return fresh;
}

function saveLocalStore(store) {
  localStorage.setItem("local-cpe-manager", JSON.stringify(store));
}

function addLocalLog(store, message) {
  store.logs.unshift({ time: new Date().toLocaleString("zh-CN", { hour12: false }), text: message });
  store.logs = store.logs.slice(0, 200);
}

async function api(path, options = {}) {
  try {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } catch {
    return localApi(path, options);
  }
}

async function localApi(path, options = {}) {
  const store = localStore();
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};

  if (path === "/api/status" && method === "GET") {
    saveLocalStore(store);
    return { state: store.state, settings: store.settings };
  }
  if (path === "/api/logs" && method === "GET") return { logs: store.logs };
  if (path === "/api/settings" && method === "POST") {
    store.settings = { ...store.settings, ...body };
    addLocalLog(store, `\u8bbe\u7f6e\u5df2\u4fdd\u5b58\uff1a${store.settings.host}:${store.settings.port}\u3002`);
  }
  if (path === "/api/login" && method === "POST") {
    store.settings = { ...store.settings, ...body };
    store.state.vendor = store.settings.vendor;
    addLocalLog(store, `\u8fde\u63a5\u6d4b\u8bd5\uff1a${vendorLabel[store.settings.vendor] || store.settings.vendor} ${store.settings.host}:${store.settings.port}\u3002`);
  }
  if (path === "/api/logout" && method === "POST") {
    store.state.connected = false;
    addLocalLog(store, "\u5df2\u9000\u51fa\u672c\u5730\u8fde\u63a5\u3002");
  }
  if (path === "/api/reboot" && method === "POST") {
    addLocalLog(store, "\u5df2\u8bb0\u5f55\u91cd\u542f\u6307\u4ee4\u3002");
  }
  if (path === "/api/airplane" && method === "POST") {
    store.state.airplaneMode = Boolean(body.enabled);
    addLocalLog(store, store.state.airplaneMode ? text.airplaneOn : text.airplaneOff);
  }
  if (path === "/api/lock" && method === "POST") {
    store.settings.lockBands = Array.isArray(body.lockBands) ? body.lockBands : store.settings.lockBands;
    addLocalLog(store, `\u9501\u9891\u914d\u7f6e\u5df2\u66f4\u65b0\uff1a${store.settings.lockBands.join(", ") || "\u672a\u9009\u62e9"}\u3002`);
  }

  saveLocalStore(store);
  return { ok: true, state: store.state, settings: store.settings, logs: store.logs };
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : undefined;
}

function hasNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function displayValue(value, suffix = "") {
  if (value === undefined || value === null || value === "") return "--";
  return `${value}${suffix}`;
}

function fixedValue(value, digits, suffix = "") {
  return hasNumber(value) ? `${value.toFixed(digits)}${suffix}` : "--";
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return undefined;
}

function deepSignalSource(value, output = {}, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return output;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { deepSignalSource(JSON.parse(trimmed), output, depth + 1); } catch {}
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(item => deepSignalSource(item, output, depth + 1));
    return output;
  }
  if (typeof value !== "object") return output;
  Object.entries(value).forEach(([key, item]) => {
    if (output[key] === undefined && (typeof item !== "object" || item === null)) output[key] = item;
    deepSignalSource(item, output, depth + 1);
  });
  return output;
}

function normalizeDevicePayload(raw, baseState) {
  const root = raw && typeof raw === "object" ? raw : {};
  const src = { ...deepSignalSource(root), ...(root.data || root.result || root.status || root) };
  const state = clone(baseState);

  state.connected = true;
  state.vendor = currentSettings?.vendor || "firehome";
  state.operator = firstValue(src, ["operator", "isp", "network_operator", "plmn_name"]) || state.operator;
  state.mode = firstValue(src, ["mode", "networkMode", "network_mode", "rat"]) || state.mode;
  state.model = firstValue(src, ["model", "product_model", "device_model"]) || state.model;
  state.version = firstValue(src, ["version", "softwareVersion", "sw_version", "firmware"]) || state.version;
  state.temperature = normalizeNumber(firstValue(src, ["temperature", "temp", "device_temp"])) ?? state.temperature;
  state.band = firstValue(src, ["band", "nr_band", "Band"]) || state.band;
  state.arfcn = normalizeNumber(firstValue(src, ["arfcn", "earfcn", "nr_arfcn", "NR_ARFCN"])) ?? state.arfcn;
  state.pci = normalizeNumber(firstValue(src, ["pci", "nr_pci", "PCI"])) ?? state.pci;
  state.tac = String(firstValue(src, ["tac", "TAC"]) || state.tac);
  state.gCellId = String(firstValue(src, ["gCellId", "gcellid", "cell_id", "nr_cell_id"]) || state.gCellId);

  state.metrics.nrRsrp = normalizeNumber(firstValue(src, ["nrRsrp", "nr_rsrp", "rsrp", "NR_RSRP", "RSRP"])) ?? state.metrics.nrRsrp;
  state.metrics.nrRsrq = normalizeNumber(firstValue(src, ["nrRsrq", "nr_rsrq", "rsrq", "NR_RSRQ", "RSRQ"])) ?? state.metrics.nrRsrq;
  state.metrics.nrSinr = normalizeNumber(firstValue(src, ["nrSinr", "nr_sinr", "sinr", "NR_SINR", "SINR"])) ?? state.metrics.nrSinr;
  state.metrics.nrDlbw = normalizeNumber(firstValue(src, ["nrDlbw", "dlbw", "dl_bw", "NR_DLBW"])) ?? state.metrics.nrDlbw;
  state.metrics.nrUlbw = normalizeNumber(firstValue(src, ["nrUlbw", "ulbw", "ul_bw", "NR_ULBW"])) ?? state.metrics.nrUlbw;
  state.metrics.nrCqi = normalizeNumber(firstValue(src, ["nrCqi", "cqi", "NR_CQI"])) ?? state.metrics.nrCqi;

  const rawCells = firstValue(src, ["cells", "neighborCells", "ncell_list", "neighbors", "cellList"]);
  if (Array.isArray(rawCells) && rawCells.length) {
    state.cells = rawCells.slice(0, 12).map((cell, index) => ({
      band: String(firstValue(cell, ["band", "Band", "nr_band"]) || state.band),
      earfcn: normalizeNumber(firstValue(cell, ["earfcn", "arfcn", "nr_arfcn"])) ?? state.arfcn,
      pci: String(firstValue(cell, ["pci", "PCI", "nr_pci"]) || index + 1),
      rsrp: normalizeNumber(firstValue(cell, ["rsrp", "RSRP", "nr_rsrp"])) ?? -100,
      rsrq: normalizeNumber(firstValue(cell, ["rsrq", "RSRQ", "nr_rsrq"])) ?? -20,
      sinr: normalizeNumber(firstValue(cell, ["sinr", "SINR", "nr_sinr"])) ?? 0,
    }));
  }

  return state;
}

function cleanPath(path) {
  if (!path) return "/";
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith("/") ? path : `/${path}`;
}

function buildDeviceUrl(settings, path) {
  if (/^https?:\/\//i.test(path)) return path;
  const port = Number(settings.port || 80);
  const portPart = port === 80 ? "" : `:${port}`;
  return `http://${settings.host}${portPart}${cleanPath(path)}`;
}

function parseRequestPath(value) {
  const raw = String(value || "/").trim();
  const match = raw.match(/^(GET|POST)\s+(.+)$/i);
  if (!match) return { method: "GET", path: raw };
  return { method: match[1].toUpperCase(), path: match[2].trim() || "/" };
}

async function fetchDirectDevice(payload) {
  const settings = payload.settings;
  const request = parseRequestPath(settings.statusPath || "/");
  const url = buildDeviceUrl(settings, request.path);
  if (window.CpeNative?.httpGet) {
    const body = request.method === "POST" && window.CpeNative.httpPost
      ? window.CpeNative.httpPost(url, "{}")
      : window.CpeNative.httpGet(url);
    const parsed = JSON.parse(body);
    if (parsed.error) throw new Error(parsed.error);
    return { state: normalizeDevicePayload(parsed, payload.state), settings };
  }
  const response = await fetch(url, {
    method: request.method,
    cache: "no-store",
    credentials: "include",
    headers: request.method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: request.method === "POST" ? "{}" : undefined,
  });
  const body = await response.text();
  const parsed = JSON.parse(body);
  return { state: normalizeDevicePayload(parsed, payload.state), settings };
}

async function fetchFiberHomeDevice(payload) {
  const settings = payload.settings;
  if (!window.CpeNative?.fiberHomeStatus) {
    throw new Error("\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u70fd\u706b\u52a0\u5bc6 API\u3002");
  }
  const body = window.CpeNative.fiberHomeStatus(
    `${settings.host}:${Number(settings.port || 80)}`,
    settings.username || "admin",
    settings.password || ""
  );
  const parsed = JSON.parse(body);
  if (!parsed.ok) throw new Error(parsed.error || "\u70fd\u706b API \u8bfb\u53d6\u5931\u8d25");
  return { state: normalizeDevicePayload(parsed, payload.state), settings };
}

async function fetchDeviceText(settings, rawPath) {
  const request = parseRequestPath(rawPath);
  const url = buildDeviceUrl(settings, request.path);
  if (window.CpeNative?.httpGet) {
    const body = request.method === "POST" && window.CpeNative.httpPost
      ? window.CpeNative.httpPost(url, "{}")
      : window.CpeNative.httpGet(url);
    try {
      const maybeError = JSON.parse(body);
      if (maybeError.error) throw new Error(maybeError.error);
    } catch (error) {
      if (error.message && !error.message.startsWith("Unexpected")) throw error;
    }
    return body;
  }
  const response = await fetch(url, {
    method: request.method,
    cache: "no-store",
    credentials: "include",
    headers: request.method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: request.method === "POST" ? "{}" : undefined,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function looksLikeSignalPayload(body) {
  const sample = String(body || "").slice(0, 12000);
  return /rsrp|rsrq|sinr|arfcn|earfcn|pci|cell_id|gcell|nr5g|NR_RSRP|NR_SINR/i.test(sample);
}

async function probeDevice() {
  const settings = collectSettings();
  setMessage(text.probeStart);
  for (const rawPath of probePaths) {
    try {
      const body = await fetchDeviceText(settings, rawPath);
      if (!looksLikeSignalPayload(body)) continue;
      $("#statusPath").value = rawPath;
      await saveSettings();
      setMessage(`\u627e\u5230\u7591\u4f3c\u72b6\u6001\u63a5\u53e3\uff1a${rawPath}`);
      return;
    } catch {
      // Keep trying the next candidate path.
    }
  }
  setMessage(text.probeNone);
}

function openBackendPage() {
  const settings = collectSettings();
  const target = buildDeviceUrl(settings, settings.loginPath || "/");
  if (window.CpeNative?.openExternalUrl) {
    window.CpeNative.openExternalUrl(target);
    return;
  }
  if (window.CpeNative?.openUrlWithHeaders) {
    window.CpeNative.openUrlWithHeaders(target);
    return;
  }
  window.location.href = target;
}

function phoneValue(value) {
  return value === undefined || value === null || value === "" ? "N/A" : value;
}

function phoneMetric(value, type) {
  const numeric = normalizeNumber(value);
  if (numeric === undefined) return `<div class="mini-meter empty">N/A</div>`;
  const ranges = {
    rsrp: [-115, -55],
    rsrq: [-30, -3],
    sinr: [-20, 30],
  };
  const [min, max] = ranges[type] || [-120, 0];
  return mini(numeric, type, min, max);
}

function renderPhoneSignals(payload) {
  const message = $("#phoneSignalMessage");
  if (!payload?.ok) {
    message.textContent = payload?.error || text.phoneNoNative;
    $("#phoneCellularCards").innerHTML = "";
    $("#phoneWifiGrid").innerHTML = "";
    return;
  }

  message.textContent = "\u624b\u673a\u4fe1\u53f7\u5df2\u5237\u65b0\u3002";
  const groups = Array.isArray(payload.cellular) ? payload.cellular : [];
  $("#phoneCellularCards").innerHTML = groups.length ? groups.map(group => `
    <section class="phone-card">
      <h2>${group.slot}: ${phoneValue(group.title)}</h2>
      <div class="phone-summary">
        <div><strong>PLMN</strong><span>${phoneValue(group.plmn)}</span></div>
        <div><strong>TAC</strong><span>${phoneValue(group.tac)}</span></div>
        <div><strong>CellID</strong><span>${phoneValue(group.cellId)}</span></div>
        <div><strong>SINR</strong><span class="boxed">${phoneValue(group.sinr)}</span></div>
      </div>
      <div class="table-wrap phone-table-wrap">
        <table class="phone-table">
          <thead>
            <tr><th>ARFCN</th><th>PCI</th><th>RSRP</th><th>RSRQ</th><th>Name</th></tr>
          </thead>
          <tbody>
            ${(group.cells || []).map(cell => `
              <tr>
                <td>${phoneValue(cell.arfcn)}</td>
                <td>${phoneValue(cell.pci)}</td>
                <td>${phoneMetric(cell.rsrp, "rsrp")}</td>
                <td>${phoneMetric(cell.rsrq, "rsrq")}</td>
                <td>${phoneValue(cell.name || cell.type)}</td>
              </tr>
            `).join("") || `<tr><td colspan="5">\u6682\u672a\u8bfb\u5230\u5c0f\u533a\u4fe1\u606f</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `).join("") : `<div class="phone-empty">\u6682\u672a\u8bfb\u5230\u8702\u7a9d\u5c0f\u533a\u4fe1\u606f\u3002</div>`;

  const wifi = payload.wifi || {};
  $("#phoneWifiGrid").innerHTML = `
    <div><strong>SSID</strong><span>${phoneValue(wifi.ssid)}</span></div>
    <div><strong>BSSID</strong><span>${phoneValue(wifi.bssid)}</span></div>
    <div><strong>RSSI</strong><span>${phoneValue(wifi.rssi)} dBm</span></div>
    <div><strong>\u901f\u7387</strong><span>${phoneValue(wifi.linkSpeed)}</span></div>
    <div><strong>\u9891\u7387</strong><span>${phoneValue(wifi.frequency)}</span></div>
  `;
}

async function refreshPhoneSignals() {
  const message = $("#phoneSignalMessage");
  message.textContent = text.phoneReading;
  if (!window.CpeNative?.getPhoneSignals) {
    renderPhoneSignals({ ok: false, error: text.phoneNoNative });
    return;
  }
  try {
    const payload = JSON.parse(window.CpeNative.getPhoneSignals());
    renderPhoneSignals(payload);
  } catch (error) {
    renderPhoneSignals({ ok: false, error: error.message });
  }
}

function requestPhonePermission() {
  if (window.CpeNative?.requestPhonePermissions) {
    window.CpeNative.requestPhonePermissions();
    setTimeout(refreshPhoneSignals, 800);
  }
}

function bindPhoneTabs() {
  $$(".phone-tab").forEach(button => {
    button.addEventListener("click", () => {
      $$(".phone-tab").forEach(tab => tab.classList.remove("active"));
      $$(".phone-panel").forEach(panel => panel.classList.remove("active"));
      button.classList.add("active");
      $(`#phone${button.dataset.phoneTab === "wifi" ? "Wifi" : "Cellular"}Panel`).classList.add("active");
    });
  });
}

async function fetchProxyDevice(payload) {
  const response = await fetch("/api/firehome/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload.settings),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const parsed = await response.json();
  return { state: normalizeDevicePayload(parsed.raw, payload.state), settings: payload.settings };
}

async function maybeReadRealDevice(payload) {
  if (payload.settings.protocol === "firehome-api") {
    try {
      const real = await fetchFiberHomeDevice(payload);
      setMessage("\u767b\u5f55\u6210\u529f\uff01\u5382\u5bb6\uff1a\u70fd\u706b\u3002");
      return real;
    } catch (error) {
      setMessage(`\u70fd\u706b API \u8fde\u63a5\u5931\u8d25\uff1a${error.message}`);
      return payload;
    }
  }

  if (payload.settings.protocol === "firehome-http") {
    try {
      const real = await fetchDirectDevice(payload);
      setMessage(text.directOk);
      return real;
    } catch {
      setMessage(text.directFail);
      return payload;
    }
  }

  if (payload.settings.protocol === "proxy") {
    try {
      const real = await fetchProxyDevice(payload);
      setMessage(text.directOk);
      return real;
    } catch {
      setMessage(text.proxyFail);
      return payload;
    }
  }

  return payload;
}

function colorFor(value, type) {
  if (type === "rsrp") {
    if (value >= -85) return "var(--green-dark)";
    if (value >= -98) return "var(--green)";
    if (value >= -105) return "var(--yellow)";
    return "var(--red)";
  }
  if (type === "rsrq") {
    if (value >= -10) return "var(--green)";
    if (value >= -15) return "var(--yellow)";
    if (value >= -21) return "var(--orange)";
    return "var(--red)";
  }
  if (type === "sinr") {
    if (value >= 20) return "var(--green)";
    if (value >= 10) return "var(--yellow)";
    if (value >= 3) return "var(--orange)";
    return "var(--red)";
  }
  return "var(--green)";
}

function percent(value, min, max) {
  if (!hasNumber(value)) return 0;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

function meter(selector, value, label, options = {}) {
  const el = $(selector);
  if (!el) return;
  const fill = options.fill ?? 50;
  el.textContent = hasNumber(value) ? label : "--";
  el.style.setProperty("--fill", `${Math.round(fill)}%`);
  el.style.setProperty("--color", options.color || "var(--green)");
}

function mini(value, type, min, max, suffix = "") {
  if (!hasNumber(value)) return `<div class="mini-meter empty">--</div>`;
  const fill = percent(value, min, max);
  const color = colorFor(value, type);
  return `<div class="mini-meter" style="--fill:${fill}%;--color:${color}">${value}${suffix}</div>`;
}

function renderStatus(payload) {
  currentState = payload.state;
  currentSettings = payload.settings;
  const s = currentState;
  const m = s.metrics;
  const t = s.traffic;
  const vendor = vendorLabel[s.vendor] || vendorLabel[currentSettings.vendor] || s.vendor;

  $("#deviceHeadline").textContent = `${vendor} - ${s.model} - ${s.connected ? "\u5df2\u8fde\u63a5" : "\u672a\u8fde\u63a5"}`;
  $("#operatorName").textContent = s.operator;
  $("#networkMode").textContent = s.mode;
  $("#modelValue").textContent = s.model;
  $("#versionValue").textContent = s.version;
  $("#contractLine").textContent = `${displayValue(s.downContract, "Mbps")} \u2193 ${displayValue(s.upContract, "Mbps")} \u2191 QCI:${displayValue(s.qci)}`;
  $("#bandValue").textContent = s.band;
  $("#arfcnValue").textContent = s.arfcn;
  $("#pciValue").textContent = s.pci;
  $("#tacValue").textContent = s.tac;
  $("#gcellValue").textContent = s.gCellId;
  $("#temperatureBar").style.background = `linear-gradient(90deg, var(--green) 0 ${percent(s.temperature, 20, 70)}%, transparent ${percent(s.temperature, 20, 70)}%), #f7fbfb`;
  $("#temperatureBar span").textContent = displayValue(s.temperature, "\u00b0C");

  meter("#nrRsrp", m.nrRsrp, `${m.nrRsrp}dBm`, { fill: percent(m.nrRsrp, -115, -55), color: colorFor(m.nrRsrp, "rsrp") });
  meter("#nrSinr", m.nrSinr, `${m.nrSinr}dB`, { fill: percent(m.nrSinr, -20, 30), color: colorFor(m.nrSinr, "sinr") });
  meter("#nrRsrq", m.nrRsrq, `${m.nrRsrq}dB`, { fill: percent(m.nrRsrq, -30, -5), color: colorFor(m.nrRsrq, "rsrq") });
  meter("#nrUlbw", m.nrUlbw, `${m.nrUlbw}MHz`, { fill: percent(m.nrUlbw, 0, 120), color: "var(--blue)" });
  meter("#nrDlbw", m.nrDlbw, `${m.nrDlbw}MHz`, { fill: percent(m.nrDlbw, 0, 120), color: "var(--blue)" });
  meter("#pucch", m.pucch, `${m.pucch}dBm`, { fill: percent(m.pucch, -30, 0), color: colorFor(m.pucch, "rsrp") });
  meter("#pusch", m.pusch, `${m.pusch}dBm`, { fill: percent(m.pusch, -30, 0), color: colorFor(m.pusch, "rsrp") });
  meter("#nrUlMcs", m.nrUlMcs, `${m.nrUlMcs}`, { fill: percent(m.nrUlMcs, 0, 28), color: "var(--blue)" });
  meter("#nrDlMcs", m.nrDlMcs, `${m.nrDlMcs}`, { fill: percent(m.nrDlMcs, 0, 28), color: "#dfe6e7" });
  meter("#nrCqi", m.nrCqi, `${m.nrCqi}`, { fill: percent(m.nrCqi, 0, 15), color: "var(--green)" });
  $("#mimoValue").textContent = `DL: ${displayValue(m.mimoDl)} UL: ${displayValue(m.mimoUl)}`;

  $("#downloadRate").textContent = fixedValue(t.downloadRateKbps, 2, "Kbps");
  $("#uploadRate").textContent = fixedValue(t.uploadRateKbps, 2, "Kbps");
  $("#todayDownload").textContent = fixedValue(t.todayDownloadGb, 2, "GB");
  $("#todayUpload").textContent = fixedValue(t.todayUploadGb, 2, "GB");
  $("#monthDownload").textContent = fixedValue(t.monthDownloadGb, 2, "GB");
  $("#monthUpload").textContent = fixedValue(t.monthUploadGb, 2, "GB");

  $("#airplaneToggle").checked = s.airplaneMode;
  $("#autoRefresh").checked = Boolean(currentSettings.autoRefresh);
  if ($("#targetDevice")) $("#targetDevice").textContent = `${currentSettings.host}:${currentSettings.port}`;
  $("#dataMode").textContent = protocolLabel[currentSettings.protocol] || currentSettings.protocol;
  if ($("#phoneMode")) $("#phoneMode").textContent = currentSettings.protocol === "firehome-http" ? "\u624b\u673a\u76f4\u8fde" : protocolLabel[currentSettings.protocol];

  const settingValues = {
    settingHost: currentSettings.host,
    settingPort: currentSettings.port,
    settingUser: currentSettings.username,
    settingPass: currentSettings.password,
    settingVendor: currentSettings.vendor,
    settingProtocol: currentSettings.protocol === "demo" ? "firehome-api" : currentSettings.protocol,
    statusPath: currentSettings.statusPath,
    loginPath: currentSettings.loginPath,
    refreshInterval: currentSettings.refreshInterval,
  };
  Object.entries(settingValues).forEach(([id, value]) => {
    const field = $(`#${id}`);
    if (field) field.value = value;
  });
  $$("#bandSelect option").forEach(option => {
    option.selected = currentSettings.lockBands?.includes(option.value);
  });

  $("#cellsBody").innerHTML = s.cells.length ? s.cells.map((cell, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${displayValue(cell.band)}</td>
      <td>${displayValue(cell.earfcn)}</td>
      <td>${displayValue(cell.pci)}</td>
      <td>${mini(cell.rsrp, "rsrp", -115, -55)}</td>
      <td>${mini(cell.rsrq, "rsrq", -30, -5)}</td>
      <td>${mini(cell.sinr, "sinr", -20, 30)}</td>
    </tr>
  `).join("") : `<tr><td></td><td colspan="6">\u6682\u65e0\u771f\u5b9e\u8bbe\u5907\u6570\u636e</td></tr>`;
}

async function refresh() {
  try {
    let payload = await api("/api/status");
    payload = await maybeReadRealDevice(payload);
    renderStatus(payload);
  } catch (error) {
    setMessage(error.message);
  }
}

async function renderLogs() {
  const payload = await api("/api/logs");
  $("#logList").innerHTML = payload.logs.map(item => `
    <div><time>${item.time}</time><span>${item.text}</span></div>
  `).join("");
}

function collectSettings() {
  return {
    host: $("#settingHost").value.trim() || "192.168.8.1",
    port: Number($("#settingPort").value || 80),
    username: $("#settingUser").value.trim(),
    password: $("#settingPass").value,
    vendor: $("#settingVendor").value,
    protocol: $("#settingProtocol").value,
    statusPath: $("#statusPath").value.trim() || "/api/status",
    loginPath: $("#loginPath").value.trim() || "/",
    refreshInterval: Math.max(1, Number($("#refreshInterval")?.value || 3)),
    autoRefresh: $("#autoRefresh").checked,
  };
}

async function saveSettings() {
  const settings = collectSettings();
  await api("/api/settings", { method: "POST", body: JSON.stringify(settings) });
  setMessage(text.saved);
  await refresh();
  await renderLogs();
  scheduleRefresh();
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  if (!currentSettings?.autoRefresh) return;
  const seconds = Math.max(1, Number(currentSettings.refreshInterval || 3));
  refreshTimer = setInterval(refresh, seconds * 1000);
}

function schedulePhoneRefresh(active) {
  clearInterval(phoneRefreshTimer);
  if (!active) return;
  phoneRefreshTimer = setInterval(refreshPhoneSignals, 1000);
}

function bindTabs() {
  $$(".tab").forEach(button => {
    button.addEventListener("click", async () => {
      $$(".tab").forEach(tab => tab.classList.remove("active"));
      $$(".tab-panel").forEach(panel => panel.classList.remove("active"));
      button.classList.add("active");
      $(`#panel-${button.dataset.tab}`).classList.add("active");
      schedulePhoneRefresh(button.dataset.tab === "phone");
      if (button.dataset.tab === "logs") await renderLogs();
      if (button.dataset.tab === "phone") await refreshPhoneSignals();
    });
  });
}

function bindActions() {
  $("#refreshNow").addEventListener("click", async () => {
    await refresh();
  });

  $("#saveSettingsTop").addEventListener("click", saveSettings);
  $("#saveSettings").addEventListener("click", saveSettings);

  $("#loginDevice").addEventListener("click", async () => {
    const settings = collectSettings();
    await api("/api/login", { method: "POST", body: JSON.stringify(settings) });
    await refresh();
    setMessage($("#messageLine").textContent);
    await renderLogs();
  });

  $("#probeDevice").addEventListener("click", probeDevice);
  $("#openBackendPage").addEventListener("click", openBackendPage);
  $("#openBackendPageFirefly").addEventListener("click", openBackendPage);
  $("#refreshPhoneSignal").addEventListener("click", refreshPhoneSignals);
  $("#requestPhonePermission").addEventListener("click", requestPhonePermission);

  $("#logoutDevice").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" });
    setMessage(text.loggedOut);
    await refresh();
    await renderLogs();
  });

  $("#rebootDevice").addEventListener("click", async () => {
    await api("/api/reboot", { method: "POST", body: "{}" });
    setMessage(text.reboot);
    await renderLogs();
  });

  $("#airplaneToggle").addEventListener("change", async event => {
    await api("/api/airplane", { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) });
    setMessage(event.target.checked ? text.airplaneOn : text.airplaneOff);
    await refresh();
    await renderLogs();
  });

  $("#autoRefresh").addEventListener("change", saveSettings);

  $("#applyLock").addEventListener("click", async () => {
    const lockBands = $$("#bandSelect option").filter(option => option.selected).map(option => option.value);
    await api("/api/lock", { method: "POST", body: JSON.stringify({ lockBands }) });
    setMessage(`\u9501\u9891\u914d\u7f6e\u5df2\u66f4\u65b0\uff1a${lockBands.join(", ") || "\u672a\u9009\u62e9"}\u3002`);
    await refresh();
    await renderLogs();
  });

  $("#clearLock").addEventListener("click", () => {
    $$("#bandSelect option").forEach(option => {
      option.selected = false;
    });
  });

  $("#installApp").addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      setMessage("\u8bf7\u5728\u624b\u673a\u6d4f\u89c8\u5668\u83dc\u5355\u91cc\u9009\u62e9\u201c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u201d\u3002");
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
}

function setupInstall() {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installApp").classList.add("available");
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

async function start() {
  bindTabs();
  bindPhoneTabs();
  bindActions();
  setupInstall();
  await refresh();
  await renderLogs();
  scheduleRefresh();
}

start();
