const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

// 页面里反复用到的提示文字集中放在这里，后面想改文案先改这一块。
const text = {
  ready: "准备就绪。",
  localStarted: "已启动，等待连接真实设备。",
  saved: "设置已保存。",
  cleared: "设置输入框已清空。",
  refreshed: "状态已刷新。",
  loggedIn: "测试连接已完成。",
  loggedOut: "已退出。",
  reboot: "重启指令已记录。",
  airplaneOn: "飞行模式已启用。",
  airplaneOff: "飞行模式已关闭。",
  directOk: "已从烽火后台读取状态。",
  directFail: "烽火后台直连失败，可能是接口路径不对或手机浏览器跨域限制。",
  proxyFail: "电脑代理不可用，请先启动本地服务。",
  probeStart: "正在探测烽火后台接口。",
  probeNone: "没有找到明显的状态接口，需要看后台网页的请求记录。",
  phoneNoNative: "当前不是 APK 环境，无法读取手机自身信号。",
  phoneReading: "正在读取手机信号。",
};

const vendorLabel = {
  firehome: "\u70fd\u706b",
  huawei: "\u534e\u4e3a",
  zte: "\u4e2d\u5174",
  generic: "\u901a\u7528",
};

const protocolLabel = {
  "firehome-api": "\u70fd\u706b\u672c\u5730\u63a5\u53e3",
  "firehome-http": "\u70fd\u706b HTTP \u540e\u53f0",
  proxy: "\u7535\u8111\u4ee3\u7406",
};

let currentState = null;
let currentSettings = null;
let refreshTimer = null;
let phoneRefreshTimer = null;
let refreshInFlight = false;
let phoneRefreshInFlight = false;
let settingsDirty = false;
let deferredInstallPrompt = null;

const STORE_SCHEMA_VERSION = 11;
// 输入这个临时口令后展开高级设置；保存时不会把 1832 当成真实登录用户名。
const DEV_UNLOCK_CODE = "1832";
// 原版 3.8.1 大约 1 秒读取一次烽火本地状态；不要设得太快，避免触发设备账号保护。
const DEFAULT_FIREHOME_REFRESH_SECONDS = 1;
const DEFAULT_PHONE_REFRESH_SECONDS = 1;
const MIN_REFRESH_SECONDS = 1;
const MAX_REFRESH_SECONDS = 60;
const defaultDeviceHosts = ["192.168.8.1", "192.168.1.1", "192.168.0.1", "192.168.31.1"];
const emulatorGatewayHosts = ["10.0.2.2", "10.0.3.2", "10.0.2.15"];

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
  host: detectGatewayHost() || "192.168.8.1",
  port: 80,
  username: "admin",
  password: "",
  vendor: "firehome",
  protocol: "firehome-api",
  statusPath: "GET /api/tmp/FHTOOLAPIS?ajaxmethod=app_get_base_info",
  loginPath: "/",
  autoRefresh: true,
  refreshInterval: DEFAULT_FIREHOME_REFRESH_SECONDS,
  phoneRefreshInterval: DEFAULT_PHONE_REFRESH_SECONDS,
  lockBands: [],
};

const fallbackLogs = [
  { time: new Date().toLocaleString("zh-CN", { hour12: false }), text: text.localStarted },
];

const probePaths = [
  "GET /api/tmp/FHTOOLAPIS?ajaxmethod=app_get_base_info",
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

function detectGatewayHost() {
  const gateway = nativeGatewayHost();
  if (!gateway) return "";
  if (emulatorGatewayHosts.includes(gateway)) return "";
  return gateway;
}

function nativeGatewayHost() {
  if (!window.CpeNative?.getWifiGateway) return "";
  try {
    const payload = JSON.parse(window.CpeNative.getWifiGateway());
    if (!payload.ok || !payload.gateway) return "";
    return payload.gateway;
  } catch {
    return "";
  }
}

function isAndroidEmulatorNetwork() {
  return emulatorGatewayHosts.includes(nativeGatewayHost());
}

// Kotlin 原生层异步读取烽火接口后，会通过这个回调把结果送回页面。
const fiberHomeCallbacks = new Map();

window.__cpeNativeFiberHomeResult = (token, body) => {
  const pending = fiberHomeCallbacks.get(token);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  fiberHomeCallbacks.delete(token);
  pending.resolve(body);
};

function nativeFiberHomeStatus(hostAndPort, username, password) {
  if (window.CpeNative?.fiberHomeStatusAsync) {
    return new Promise((resolve, reject) => {
      const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeoutId = setTimeout(() => {
        fiberHomeCallbacks.delete(token);
        reject(new Error("\u70fd\u706b API \u8bfb\u53d6\u8d85\u65f6"));
      }, 90000);
      fiberHomeCallbacks.set(token, { resolve, reject, timeoutId });
      try {
        const accepted = window.CpeNative.fiberHomeStatusAsync(token, hostAndPort, username, password);
        const parsed = accepted ? JSON.parse(accepted) : { ok: true };
        if (parsed.ok === false) throw new Error(parsed.error || "\u70fd\u706b API \u542f\u52a8\u5931\u8d25");
      } catch (error) {
        clearTimeout(timeoutId);
        fiberHomeCallbacks.delete(token);
        reject(error);
      }
    });
  }
  if (window.CpeNative?.fiberHomeStatus) {
    return Promise.resolve(window.CpeNative.fiberHomeStatus(hostAndPort, username, password));
  }
  return Promise.reject(new Error("\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u70fd\u706b\u52a0\u5bc6 API\u3002"));
}

function migrateSavedStore(saved) {
  if (!saved) return saved;
  const oldSchema = Number(saved.schemaVersion || 0);
  saved.settings = { ...fallbackSettings, ...saved.settings };
  if (saved.settings.protocol === "demo") saved.settings.protocol = "firehome-api";
  if (oldSchema < STORE_SCHEMA_VERSION) {
    if (typeof saved.settings.autoRefresh !== "boolean") saved.settings.autoRefresh = true;
    const oldFireHomeRefresh = normalizeNumber(saved.settings.refreshInterval);
    const oldPhoneRefresh = normalizeNumber(saved.settings.phoneRefreshInterval);
    saved.settings.refreshInterval = oldSchema < 11 && (!oldFireHomeRefresh || oldFireHomeRefresh < 1 || oldFireHomeRefresh === 0.5)
      ? DEFAULT_FIREHOME_REFRESH_SECONDS
      : normalizeRefreshSeconds(saved.settings.refreshInterval, DEFAULT_FIREHOME_REFRESH_SECONDS);
    saved.settings.phoneRefreshInterval = oldSchema < 11 && (!oldPhoneRefresh || oldPhoneRefresh < 1 || oldPhoneRefresh === 0.5)
      ? DEFAULT_PHONE_REFRESH_SECONDS
      : normalizeRefreshSeconds(saved.settings.phoneRefreshInterval, DEFAULT_PHONE_REFRESH_SECONDS);
    if (!saved.settings.statusPath || saved.settings.statusPath === "/api/status") {
      saved.settings.statusPath = fallbackSettings.statusPath;
    }
    if (!saved.settings.username) saved.settings.username = "admin";
  }
  saved.state = clone(fallbackState);
  saved.logs = Array.isArray(saved.logs) ? saved.logs : clone(fallbackLogs);
  saved.schemaVersion = STORE_SCHEMA_VERSION;

  const gatewayHost = detectGatewayHost();
  if (emulatorGatewayHosts.includes(saved.settings.host)) {
    saved.settings.host = gatewayHost || fallbackSettings.host;
  } else if (gatewayHost && !saved.settings.host) {
    saved.settings.host = gatewayHost;
  }
  if (saved.settings.lockBands?.includes("N78")) saved.settings.lockBands = [];

  return saved;
}

// 本地存储保存用户设置和最后一次状态，APK 里没有后端服务时也能工作。
function localStore() {
  const saved = JSON.parse(localStorage.getItem("local-cpe-manager") || "null");
  if (saved) {
    const migrated = migrateSavedStore(saved);
    localStorage.setItem("local-cpe-manager", JSON.stringify(migrated));
    return migrated;
  }
  const fresh = { schemaVersion: STORE_SCHEMA_VERSION, state: clone(fallbackState), settings: clone(fallbackSettings), logs: clone(fallbackLogs) };
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
  if (location.protocol === "file:") return localApi(path, options);
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

function secondsFromInput(id, fallback) {
  const field = $(`#${id}`);
  return normalizeRefreshSeconds(field?.value, fallback);
}

function normalizeRefreshSeconds(value, fallback) {
  const number = normalizeNumber(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : 1;
  const selected = Number.isFinite(number) ? number : safeFallback;
  return Math.max(MIN_REFRESH_SECONDS, Math.min(MAX_REFRESH_SECONDS, selected));
}

function rateKbpsFromByteWindow(value, seconds) {
  const bytes = normalizeNumber(value);
  const interval = normalizeNumber(seconds);
  if (!hasNumber(bytes) || !hasNumber(interval) || interval <= 0) return undefined;
  if (bytes < 0 || bytes > 512 * 1024 * 1024) return undefined;
  return (bytes * 8) / 1000 / interval;
}

function speedKbpsFromBytesPerSecond(value) {
  const bytesPerSecond = normalizeNumber(value);
  if (!hasNumber(bytesPerSecond)) return undefined;
  return (bytesPerSecond * 8) / 1000;
}

function bytesToGb(value) {
  const bytes = normalizeNumber(value);
  if (!hasNumber(bytes)) return undefined;
  return bytes / 1024 / 1024 / 1024;
}

function normalizeTemperature(value) {
  const temperature = normalizeNumber(value);
  if (!hasNumber(temperature)) return undefined;
  if (temperature > 1000) return Math.round(temperature / 1000);
  if (temperature > 100) return Math.round(temperature / 10);
  return Math.round(temperature);
}

function trafficAmount(valueGb) {
  if (!hasNumber(valueGb)) return "--";
  if (valueGb < 1) return `${(valueGb * 1024).toFixed(2)}MB`;
  return `${valueGb.toFixed(2)}GB`;
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return undefined;
}

function carrierNameFromPlmn(value) {
  const plmn = String(value || "").trim();
  if (["46000", "46002", "46004", "46007", "46008", "46013"].includes(plmn)) return "\u79fb\u52a8";
  if (["46001", "46006", "46009"].includes(plmn)) return "\u8054\u901a";
  if (["46003", "46005", "46011", "46012"].includes(plmn)) return "\u7535\u4fe1";
  if (["46015"].includes(plmn)) return "\u5e7f\u7535";
  return "";
}

function formatCellId(value) {
  const text = String(value || "").trim();
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 4096) return text;
  const high = Math.floor(number / 4096);
  const low = number % 4096;
  return `${high}/${low}`;
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

// 把烽火接口、通用接口、手机接口返回的不同字段名统一映射成页面使用的字段。
function normalizeDevicePayload(raw, baseState) {
  const root = raw && typeof raw === "object" ? raw : {};
  const src = { ...deepSignalSource(root), ...(root.data || root.result || root.status || root) };
  const state = clone(baseState);

  state.connected = true;
  state.vendor = currentSettings?.vendor || "firehome";
  state.operator = carrierNameFromPlmn(firstValue(src, ["PLMN", "plmn"])) ||
    firstValue(src, ["operator", "operator_name", "isp", "network_operator", "plmn_name"]) ||
    state.operator;
  state.mode = firstValue(src, ["mode", "networkMode", "network_mode", "rat", "WorkMode"]) || state.mode;
  state.model = firstValue(src, ["model", "modelName", "model_name", "product_model", "device_model", "ProductClass", "product_class"]) || state.model;
  state.version = firstValue(src, [
    "version",
    "Software_version",
    "softwareVersion",
    "sw_version",
    "firmware",
    "SoftwareVersion",
    "IGDSoftwareVersion",
    "ProductSoftwareVersion",
    "HardwareVersion",
  ]) || state.version;
  state.temperature = normalizeTemperature(firstValue(src, [
    "temperature",
    "temp",
    "device_temp",
    "Temperature",
    "DeviceTemperature",
    "DeviceTemperature2",
    "FHDeviceTemperature",
    "IGDTemperature",
  ])) ?? state.temperature;
  state.downContract = normalizeNumber(firstValue(src, ["downContract", "DL_AMBR", "dl_ambr"])) ?? state.downContract;
  state.upContract = normalizeNumber(firstValue(src, ["upContract", "UL_AMBR", "ul_ambr"])) ?? state.upContract;
  if (state.downContract > 10000) state.downContract = Math.round(state.downContract / 1024);
  if (state.upContract > 10000) state.upContract = Math.round(state.upContract / 1024);
  state.qci = firstValue(src, ["qci", "QCI", "NR_QCI"]) || state.qci;
  const bandValue = firstValue(src, ["band", "nr_band", "Band", "BAND_NBR", "NR_BAND", "NR_Band"]);
  state.band = bandValue && /^\d+$/.test(String(bandValue)) ? `N${bandValue}` : (bandValue || state.band);
  state.arfcn = normalizeNumber(firstValue(src, ["arfcn", "earfcn", "nr_arfcn", "NR_ARFCN", "EARFCN_NBR"])) ?? state.arfcn;
  state.pci = normalizeNumber(firstValue(src, ["pci", "nr_pci", "PCI", "PCI_NBR", "NR_PCI"])) ?? state.pci;
  state.tac = String(firstValue(src, ["tac", "TAC"]) || state.tac);
  state.gCellId = formatCellId(firstValue(src, ["gCellId", "gcellid", "cell_id", "nr_cell_id", "NCGI", "ECGI"]) || state.gCellId);

  state.metrics.nrRsrp = normalizeNumber(firstValue(src, ["nrRsrp", "nr_rsrp", "SSB_RSRP", "RSRP_NBR", "NR_RSRP", "rsrp", "RSRP"])) ?? state.metrics.nrRsrp;
  state.metrics.nrRsrq = normalizeNumber(firstValue(src, ["nrRsrq", "nr_rsrq", "SSB_RSRQ", "RSRQ_NBR", "NR_RSRQ", "rsrq", "RSRQ"])) ?? state.metrics.nrRsrq;
  state.metrics.nrSinr = normalizeNumber(firstValue(src, ["nrSinr", "nr_sinr", "SSB_SINR", "SINR_NBR", "NR_SINR", "sinr", "SINR"])) ?? state.metrics.nrSinr;
  state.metrics.nrDlbw = normalizeNumber(firstValue(src, ["nrDlbw", "dlbw", "dl_bw", "DlBandWidth", "DLBandwidth", "NR_DLBW", "NR_DL_BW"])) ?? state.metrics.nrDlbw;
  state.metrics.nrUlbw = normalizeNumber(firstValue(src, ["nrUlbw", "ulbw", "ul_bw", "UlBandWidth", "ULBandwidth", "NR_ULBW", "NR_UL_BW"])) ?? state.metrics.nrUlbw;
  state.metrics.nrCqi = normalizeNumber(firstValue(src, ["nrCqi", "cqi", "CQI", "NR_CQI", "LTE_CQI"])) ?? state.metrics.nrCqi;
  state.metrics.pusch = normalizeNumber(firstValue(src, ["pusch", "PUSCH", "PUSCH_TX_Power", "NR_Power", "LTE_Power"])) ?? state.metrics.pusch;
  state.metrics.pucch = normalizeNumber(firstValue(src, ["pucch", "PUCCH", "PUCCH_TX_Power"])) ?? state.metrics.pucch;
  state.metrics.nrDlMcs = normalizeNumber(firstValue(src, ["nrDlMcs", "dl_mcs", "DlMCS", "NR_DLMCS", "NR_DL_MCS"])) ?? state.metrics.nrDlMcs;
  state.metrics.nrUlMcs = normalizeNumber(firstValue(src, ["nrUlMcs", "ul_mcs", "UlMCS", "NR_ULMCS", "NR_UL_MCS"])) ?? state.metrics.nrUlMcs;
  state.metrics.mimoDl = firstValue(src, ["mimoDl", "DlMimo", "NR_MIMO_DL", "MIMO_DL"]) || state.metrics.mimoDl;
  state.metrics.mimoUl = firstValue(src, ["mimoUl", "UlMimo", "NR_MIMO_UL", "MIMO_UL"]) || state.metrics.mimoUl;

  const refreshSeconds = normalizeRefreshSeconds(currentSettings?.refreshInterval, fallbackSettings.refreshInterval);
  state.traffic.downloadRateKbps = normalizeNumber(firstValue(src, ["downloadRateKbps", "DownloadRate", "download_rate"])) ??
    speedKbpsFromBytesPerSecond(firstValue(src, ["RxSpeed", "rxSpeed"])) ??
    rateKbpsFromByteWindow(firstValue(src, ["TotalBytesReceived", "totalBytesReceived", "rxBytes", "RxBytes"]), refreshSeconds) ??
    state.traffic.downloadRateKbps;
  state.traffic.uploadRateKbps = normalizeNumber(firstValue(src, ["uploadRateKbps", "UploadRate", "upload_rate"])) ??
    speedKbpsFromBytesPerSecond(firstValue(src, ["TxSpeed", "txSpeed"])) ??
    rateKbpsFromByteWindow(firstValue(src, ["TotalBytesSent", "totalBytesSent", "txBytes", "TxBytes"]), refreshSeconds) ??
    state.traffic.uploadRateKbps;
  state.traffic.todayDownloadGb = normalizeNumber(firstValue(src, ["todayDownloadGb", "TodayDownload", "today_download"])) ??
    bytesToGb(firstValue(src, ["todayRxBytes", "todayDownloadBytes"])) ??
    state.traffic.todayDownloadGb;
  state.traffic.todayUploadGb = normalizeNumber(firstValue(src, ["todayUploadGb", "TodayUpload", "today_upload"])) ??
    bytesToGb(firstValue(src, ["todayTxBytes", "todayUploadBytes"])) ??
    state.traffic.todayUploadGb;
  state.traffic.monthDownloadGb = normalizeNumber(firstValue(src, ["monthDownloadGb", "MonthDownload", "month_download"])) ??
    bytesToGb(firstValue(src, ["monthRxBytes", "monthDownloadBytes"])) ??
    state.traffic.monthDownloadGb;
  state.traffic.monthUploadGb = normalizeNumber(firstValue(src, ["monthUploadGb", "MonthUpload", "month_upload"])) ??
    bytesToGb(firstValue(src, ["monthTxBytes", "monthUploadBytes"])) ??
    state.traffic.monthUploadGb;

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
  } else if (firstValue(src, ["BAND_NBR", "EARFCN_NBR", "PCI_NBR", "RSRP_NBR", "SINR_NBR"])) {
    state.cells = [{
      band: String(firstValue(src, ["BAND_NBR"]) || state.band),
      earfcn: normalizeNumber(firstValue(src, ["EARFCN_NBR"])) ?? state.arfcn,
      pci: String(firstValue(src, ["PCI_NBR"]) || state.pci),
      rsrp: normalizeNumber(firstValue(src, ["RSRP_NBR", "SSB_RSRP"])) ?? state.metrics.nrRsrp,
      rsrq: normalizeNumber(firstValue(src, ["SSB_RSRQ", "RSRQ_NBR", "RSRQ"])) ?? state.metrics.nrRsrq,
      sinr: normalizeNumber(firstValue(src, ["SINR_NBR", "SSB_SINR"])) ?? state.metrics.nrSinr,
    }];
  }

  return state;
}

function cleanPath(path) {
  if (!path) return "/";
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith("/") ? path : `/${path}`;
}

// 设置页的“登录IP/URL”允许填 IP、IP:端口 或完整 URL，这里统一拆成 host/port。
function parseHostInput(rawValue, fallbackPort = 80) {
  const raw = String(rawValue || "").trim();
  const fallbackHost = detectGatewayHost() || fallbackSettings.host;
  if (!raw) return { host: fallbackHost, port: fallbackPort };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    return {
      host: url.hostname || fallbackHost,
      port: Number(url.port || fallbackPort || 80),
    };
  } catch {
    const hostAndPort = raw.replace(/^https?:\/\//i, "").split("/")[0];
    const [host, port] = hostAndPort.split(":");
    return {
      host: host || fallbackHost,
      port: Number(port || fallbackPort || 80),
    };
  }
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
  if (isAndroidEmulatorNetwork()) {
    try {
      return await fetchFiberHomeHostProxy(payload);
    } catch (error) {
      console.warn("Host proxy unavailable, falling back to direct device access.", error);
    }
  }

  // 主读取路径：优先走烽火本地 FHTOOLAPIS，速度快，也避免依赖云端。
  if (!window.CpeNative?.fiberHomeStatus && !window.CpeNative?.fiberHomeStatusAsync) {
    throw new Error("\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301\u70fd\u706b\u52a0\u5bc6 API\u3002");
  }
  const gatewayHost = detectGatewayHost();
  const preferredHost = settings.host || gatewayHost || fallbackSettings.host;
  const hostCandidates = Array.from(new Set([preferredHost].filter(Boolean)));
  let lastError = "";

  for (const host of hostCandidates) {
    // 账号密码只在本地接口 timeout 时用于低频唤醒，不跟着每秒刷新反复登录。
    const body = await nativeFiberHomeStatus(
      `${host}:${Number(settings.port || 80)}`,
      settings.username || "admin",
      settings.password || ""
    );
    const parsed = JSON.parse(body);
    if (parsed.ok) {
      const nextSettings = { ...settings, host };
      if (!settings.host && host !== settings.host) {
        const store = localStore();
        store.settings = { ...store.settings, host };
        saveLocalStore(store);
      }
      return { state: normalizeDevicePayload(parsed, payload.state), settings: nextSettings };
    }
    lastError = parsed.error || "\u70fd\u706b API \u8bfb\u53d6\u5931\u8d25";
  }

  throw new Error(lastError || "\u70fd\u706b API \u8bfb\u53d6\u5931\u8d25");
}

async function fetchFiberHomeHostProxy(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("http://10.0.2.2:8787/api/fiberhome/status", {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload.settings),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = await response.json();
    if (!parsed.ok) throw new Error(parsed.error || "\u7535\u8111\u4ee3\u7406\u8bfb\u53d6\u5931\u8d25");
    return {
      state: normalizeDevicePayload(parsed, payload.state),
      settings: { ...payload.settings, host: parsed.host || payload.settings.host },
    };
  } finally {
    clearTimeout(timeoutId);
  }
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
            <tr><th>ARFCN</th><th>PCI</th><th>RSRP</th><th>RSRQ</th><th>SINR</th><th>Name</th></tr>
          </thead>
          <tbody>
            ${(group.cells || []).map(cell => `
              <tr>
                <td>${phoneValue(cell.arfcn)}</td>
                <td>${phoneValue(cell.pci)}</td>
                <td>${phoneMetric(cell.rsrp, "rsrp")}</td>
                <td>${phoneMetric(cell.rsrq, "rsrq")}</td>
                <td>${phoneMetric(cell.sinr, "sinr")}</td>
                <td>${phoneValue(cell.name || cell.type)}</td>
              </tr>
            `).join("") || `<tr><td colspan="6">\u6682\u672a\u8bfb\u5230\u5c0f\u533a\u4fe1\u606f</td></tr>`}
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
      setMessage(`\u767b\u5f55\u6210\u529f\uff01\u5382\u5bb6\uff1a\u70fd\u706b\uff0c\u5730\u5740\uff1a${real.settings.host}:${real.settings.port}\u3002`);
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

// 根据当前页面状态刷新 UI；这里不直接请求网络，只负责把 state 画出来。
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
  $("#todayDownload").textContent = trafficAmount(t.todayDownloadGb);
  $("#todayUpload").textContent = trafficAmount(t.todayUploadGb);
  $("#monthDownload").textContent = trafficAmount(t.monthDownloadGb);
  $("#monthUpload").textContent = trafficAmount(t.monthUploadGb);

  $("#airplaneToggle").checked = s.airplaneMode;
  $("#autoRefresh").checked = Boolean(currentSettings.autoRefresh);
  if ($("#targetDevice")) $("#targetDevice").textContent = `${currentSettings.host}:${currentSettings.port}`;
  if ($("#dataMode")) $("#dataMode").textContent = protocolLabel[currentSettings.protocol] || currentSettings.protocol;
  if ($("#phoneMode")) $("#phoneMode").textContent = currentSettings.protocol === "firehome-http" ? "\u624b\u673a\u76f4\u8fde" : protocolLabel[currentSettings.protocol];

  if (!isEditingSettings()) {
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
      phoneRefreshInterval: currentSettings.phoneRefreshInterval,
    };
    Object.entries(settingValues).forEach(([id, value]) => {
      const field = $(`#${id}`);
      if (field) field.value = value;
    });
    updateDeveloperMode();
  }
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
  const hostInput = parseHostInput($("#settingHost").value, Number($("#settingPort")?.value || currentSettings?.port || 80));
  const enteredUsername = $("#settingUser").value.trim();
  const developerMode = enteredUsername === DEV_UNLOCK_CODE;
  return {
    host: hostInput.host,
    port: hostInput.port,
    username: developerMode ? (currentSettings?.username || fallbackSettings.username) : enteredUsername,
    password: $("#settingPass").value,
    vendor: $("#settingVendor")?.value || fallbackSettings.vendor,
    protocol: $("#settingProtocol")?.value || fallbackSettings.protocol,
    statusPath: $("#statusPath")?.value.trim() || fallbackSettings.statusPath,
    loginPath: $("#loginPath")?.value.trim() || "/",
    refreshInterval: secondsFromInput("refreshInterval", DEFAULT_FIREHOME_REFRESH_SECONDS),
    phoneRefreshInterval: secondsFromInput("phoneRefreshInterval", DEFAULT_PHONE_REFRESH_SECONDS),
    autoRefresh: $("#autoRefresh").checked,
  };
}

// 输入开发者口令时展开高级设置；普通用户只看到截图里的三行登录配置。
function updateDeveloperMode() {
  const enabled = $("#settingUser")?.value.trim() === DEV_UNLOCK_CODE;
  document.body.classList.toggle("developer-mode", enabled);
}

async function saveSettings() {
  const settings = collectSettings();
  await api("/api/settings", { method: "POST", body: JSON.stringify(settings) });
  settingsDirty = false;
  setMessage(text.saved);
  await refresh();
  await renderLogs();
  scheduleRefresh();
  schedulePhoneRefresh($(".tab.active")?.dataset.tab === "phone");
}

async function testConnection() {
  const settings = collectSettings();
  await api("/api/login", { method: "POST", body: JSON.stringify(settings) });
  settingsDirty = false;
  await refresh();
  setMessage($("#messageLine").textContent);
  await renderLogs();
  scheduleRefresh();
  schedulePhoneRefresh($(".tab.active")?.dataset.tab === "phone");
}

function clearSettingsForm() {
  $("#settingHost").value = "";
  $("#settingUser").value = "";
  $("#settingPass").value = "";
  settingsDirty = true;
  updateDeveloperMode();
  setMessage(text.cleared);
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  if (!currentSettings?.autoRefresh) return;
  const seconds = normalizeRefreshSeconds(currentSettings.refreshInterval, DEFAULT_FIREHOME_REFRESH_SECONDS);
  const tick = async () => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      await refresh();
    } finally {
      refreshInFlight = false;
    }
  };
  // 防止上一次请求没结束又发下一次；默认按原版 1 秒节奏刷新。
  refreshTimer = setInterval(tick, seconds * 1000);
  setTimeout(tick, 0);
}

function schedulePhoneRefresh(active) {
  clearInterval(phoneRefreshTimer);
  if (!active) return;
  const seconds = normalizeRefreshSeconds(currentSettings?.phoneRefreshInterval, DEFAULT_PHONE_REFRESH_SECONDS);
  const tick = async () => {
    if (phoneRefreshInFlight) return;
    phoneRefreshInFlight = true;
    try {
      await refreshPhoneSignals();
    } finally {
      phoneRefreshInFlight = false;
    }
  };
  // 手机信号只在“手机”页打开时刷新，减少权限读取和耗电。
  phoneRefreshTimer = setInterval(tick, seconds * 1000);
  setTimeout(tick, 0);
}

function isEditingSettings() {
  const panel = $("#panel-settings");
  if (!panel?.classList.contains("active")) return false;
  return settingsDirty || panel.contains(document.activeElement);
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
  $("#clearSettings").addEventListener("click", clearSettingsForm);

  $("#loginDevice").addEventListener("click", testConnection);

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

  $("#panel-settings").addEventListener("input", () => {
    settingsDirty = true;
    updateDeveloperMode();
  });
  $("#panel-settings").addEventListener("change", () => {
    settingsDirty = true;
    updateDeveloperMode();
  });

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
  if (new URLSearchParams(location.search).has("autotest")) {
    setTimeout(() => {
      testConnection().catch(error => setMessage(error.message));
    }, 600);
  }
}

start();
