// Surge Panel：流媒体解锁检测
// 功能：
// 1. 自动识别或手动指定 Netflix / Disney+ / YouTube 策略组
// 2. 检测策略组当前出口的流媒体解锁状态
// 3. 不切换节点、不修改策略组，只读取当前选择并固定用 policy 发起检测
// 4. 紧凑面板展示；检测并行执行；仅在状态变化时通知

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REQUEST_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
};

const PANEL_TITLE = "流媒体解锁";
const DEFAULT_ICON = "play.tv.fill";
const DEFAULT_COLOR = "#FF2D55";
const TIMEOUT = 7;

const args = parseArgs($argument || "");

const CONFIG = {
  icon: args.icon || DEFAULT_ICON,
  color: args.color || DEFAULT_COLOR,
  notify: String(args.notify || "0") === "1",
};

const SERVICES = [
  {
    id: "netflix",
    name: "Netflix",
    groupArg: "netflix_group",
    keywords: ["netflix", "netfilx", "奈飞", "网飞", "nf"],
    checker: checkNetflix,
  },
  {
    id: "disney",
    name: "Disney+",
    groupArg: "disney_group",
    keywords: ["disney", "disney+", "迪士尼", "d+"],
    checker: checkDisneyPlus,
  },
  {
    id: "youtube",
    name: "YouTube",
    groupArg: "youtube_group",
    keywords: ["youtube", "yt", "油管"],
    checker: checkYouTube,
  },
];

(async () => {
  const startedAt = Date.now();

  try {
    const profileText = await getCurrentProfileText();
    const groups = parseProxyGroups(profileText);

    if (!groups || Object.keys(groups).length === 0) {
      return donePanel({
        title: PANEL_TITLE,
        content: "⚠️ 未能读取 [Proxy Group]",
        color: "#FF9500",
      });
    }

    // 三项检测并行执行：总耗时接近最慢的一项，而非三项耗时相加。
    const checks = await Promise.all(
      SERVICES.map((service) => inspectService(service, groups))
    );

    const lines = checks.map(formatServiceLine);
    const summary = lines.join("\n");
    const cost = ((Date.now() - startedAt) / 1000).toFixed(1);
    const content = `${summary}\n⏱ ${cost}s · ${formatShortTime(new Date())}`;

    if (CONFIG.notify) {
      // 通知签名不包含时间，避免每次刷新都被误判为状态变化。
      const signature = checks
        .map((item) => [item.service.id, item.groupName, item.nodeName, item.resultText].join("|"))
        .join("\n");
      notifyIfChanged(signature, summary);
    }

    donePanel({
      title: PANEL_TITLE,
      content,
      color: hasAnyFailure(content) ? "#FF9500" : "#30D158",
    });
  } catch (e) {
    donePanel({
      title: PANEL_TITLE,
      content: `❌ 脚本异常\n${stringifyError(e)}`,
      color: "#FF3B30",
    });
  }
})();

async function inspectService(service, groups) {
  const groupName = findServiceGroup(service, groups);

  if (!groupName) {
    const exact = cleanArg(args[service.groupArg]);
    return {
      service,
      groupName: "",
      nodeName: "",
      resultText: exact ? `⚠️ 未找到「${exact}」` : "⚠️ 未匹配策略组",
      failed: true,
    };
  }

  let nodeName = groupName;
  try {
    const chain = await resolvePolicyChain(groupName, groups);
    nodeName = chain.length > 1 ? chain[chain.length - 1] : groupName;
  } catch (_) {}

  try {
    const result = await service.checker(groupName);
    return {
      service,
      groupName,
      nodeName,
      resultText: result.text || "⚠️ 检测失败",
      failed: !result.ok,
    };
  } catch (e) {
    return {
      service,
      groupName,
      nodeName,
      resultText: "⚠️ 检测失败",
      failed: true,
    };
  }
}

function formatServiceLine(item) {
  if (!item.groupName) return `${item.service.name}：${item.resultText}`;
  return `${item.service.name}：${item.resultText} · ${item.nodeName || item.groupName}`;
}

function parseArgs(argument) {
  const obj = {};

  argument.split("&").forEach((part) => {
    if (!part) return;

    const idx = part.indexOf("=");
    const rawKey = idx === -1 ? part : part.slice(0, idx);
    const rawValue = idx === -1 ? "" : part.slice(idx + 1);
    const key = safeDecode(rawKey).trim().toLowerCase();
    const value = safeDecode(rawValue).trim();

    if (key) obj[key] = value;
  });

  return obj;
}

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return String(str || "");
  }
}

function cleanArg(v) {
  const s = String(v || "").trim();
  if (!s || s.toLowerCase() === "auto" || s === "自动") return "";
  return s;
}

function donePanel({ title, content, color }) {
  $done({
    title: title || PANEL_TITLE,
    content: content || "",
    icon: CONFIG.icon,
    "icon-color": color || CONFIG.color,
  });
}

function httpAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    try {
      $httpAPI(method, path, body || {}, (result) => {
        if (!result) return reject("HTTP API 无返回");
        if (result.error) return reject(result.error);
        resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function getCurrentProfileText() {
  const result = await httpAPI("GET", "/v1/profiles/current?sensitive=0", {});

  if (typeof result === "string") return result;

  const possibleKeys = ["profile", "content", "text", "config", "body", "data"];
  for (const key of possibleKeys) {
    if (typeof result[key] === "string") return result[key];
  }

  return JSON.stringify(result);
}

function parseProxyGroups(profileText) {
  const groups = {};
  const lines = String(profileText || "").split(/\r?\n/);
  let inProxyGroup = false;

  for (let rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    if (/^\[.+\]$/.test(line)) {
      inProxyGroup = line.toLowerCase() === "[proxy group]";
      continue;
    }

    if (!inProxyGroup) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const name = line.slice(0, eq).trim();
    const body = line.slice(eq + 1).trim();
    if (!name || !body) continue;

    const tokens = splitConfigLine(body);
    const type = (tokens[0] || "").trim().toLowerCase();
    const options = tokens
      .slice(1)
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => !x.includes("="))
      .filter((x) => !isReservedPolicyToken(x));

    groups[name] = { name, type, options, raw: body };
  }

  return groups;
}

function splitConfigLine(input) {
  const result = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if ((ch === '"' || ch === "'") && input[i - 1] !== "\\") {
      quote = quote === ch ? null : quote || ch;
      current += ch;
      continue;
    }

    if (ch === "," && !quote) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) result.push(current.trim());
  return result;
}

function isReservedPolicyToken(token) {
  const t = token.trim().toUpperCase();
  return ["DIRECT", "REJECT", "REJECT-TINYGIF", "REJECT-DROP", "REJECT-NO-DROP"].includes(t);
}

function findServiceGroup(service, groups) {
  const groupNames = Object.keys(groups);
  const exact = cleanArg(args[service.groupArg]);

  if (exact) {
    const exactHit = groupNames.find((name) => name === exact);
    if (exactHit) return exactHit;

    const normalizedHit = groupNames.find((name) => normalize(name) === normalize(exact));
    if (normalizedHit) return normalizedHit;

    return null;
  }

  let best = null;
  let bestScore = 0;

  for (const name of groupNames) {
    const score = scoreGroupName(name, service.keywords);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[｜|_\-+・·]/g, "")
    .trim();
}

function scoreGroupName(name, keywords) {
  const n = normalize(name);
  let score = 0;

  for (const kw of keywords) {
    const k = normalize(kw);
    if (!k) continue;

    if (n === k) score += 100;
    else if (n.includes(k)) score += 50 + Math.min(k.length, 20);
  }

  if (/流媒体|媒体|stream|media/i.test(name)) score += 5;
  return score;
}

async function resolvePolicyChain(groupName, groups) {
  const chain = [groupName];
  let current = groupName;

  for (let i = 0; i < 5; i++) {
    if (!groups[current]) break;

    const selected = await getSelectedPolicy(current).catch(() => "");
    if (!selected || chain.includes(selected)) break;

    chain.push(selected);
    current = selected;

    if (!groups[current]) break;
  }

  return chain;
}

async function getSelectedPolicy(groupName) {
  const path = "/v1/policy_groups/select?group_name=" + encodeURIComponent(groupName);
  const result = await httpAPI("GET", path, {});

  if (result && typeof result.policy === "string") return result.policy;
  if (result && typeof result.selected === "string") return result.selected;
  return "";
}

function request(method, url, policy, opt = {}) {
  return new Promise((resolve) => {
    const options = {
      url,
      headers: opt.headers || REQUEST_HEADERS,
      timeout: opt.timeout || TIMEOUT,
      policy,
      "auto-redirect": opt.autoRedirect !== false,
    };

    if (opt.body !== undefined) options.body = opt.body;

    $httpClient[method.toLowerCase()](options, (error, response, data) => {
      if (error) {
        resolve({ ok: false, error, status: 0, headers: {}, data: "" });
        return;
      }

      resolve({
        ok: true,
        status: response ? response.status : 0,
        headers: response ? response.headers || {} : {},
        data: data || "",
      });
    });
  });
}

function getHeader(headers, name) {
  const target = String(name).toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return "";
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject("Timeout"), ms)),
  ]);
}

// Netflix：81280792 用于完整片库检测；80018499 用于仅自制内容兜底。
async function checkNetflix(policy) {
  const full = await netflixInner(policy, "81280792");

  if (full.status === "ok") {
    const region = await getNetflixDisplayRegion(policy, full.region);
    return { ok: true, text: `✅ 完整 ${region}` };
  }

  if (full.status === "blocked") return { ok: false, text: "❌ 不支持" };

  if (full.status === "not_found") {
    const original = await netflixInner(policy, "80018499");

    if (original.status === "ok") {
      const region = await getNetflixDisplayRegion(policy, original.region);
      return { ok: true, text: `⚠️ 自制 ${region}` };
    }

    if (original.status === "not_found" || original.status === "blocked") {
      return { ok: false, text: "❌ 不支持" };
    }
  }

  return { ok: false, text: "⚠️ 检测失败" };
}

async function netflixInner(policy, filmId) {
  const url = `https://www.netflix.com/title/${filmId}`;
  const first = await request("GET", url, policy, {
    autoRedirect: false,
    headers: REQUEST_HEADERS,
  });

  if (!first.ok) return { status: "error" };
  if (first.status === 403) return { status: "blocked" };
  if (first.status === 404) return { status: "not_found" };

  const location =
    getHeader(first.headers, "location") ||
    getHeader(first.headers, "x-originating-url") ||
    "";
  const regionFromLocation = extractNetflixRegion(location);

  if (first.status >= 300 && first.status < 400) {
    if (regionFromLocation) return { status: "ok", region: regionFromLocation };

    if (location) {
      const followUrl = location.startsWith("http")
        ? location
        : `https://www.netflix.com${location}`;
      const second = await request("GET", followUrl, policy, {
        autoRedirect: true,
        headers: REQUEST_HEADERS,
      });
      return parseNetflixResponse(second, location);
    }

    return { status: "error" };
  }

  return parseNetflixResponse(first, location);
}

function parseNetflixResponse(res, extraText) {
  if (!res.ok) return { status: "error" };
  if (res.status === 403) return { status: "blocked" };
  if (res.status === 404) return { status: "not_found" };

  if (res.status === 200) {
    const headerText = [
      getHeader(res.headers, "location"),
      getHeader(res.headers, "x-originating-url"),
      getHeader(res.headers, "content-location"),
      extraText || "",
    ].join("\n");

    const region =
      extractNetflixRegion(headerText) ||
      extractNetflixRegion(String(res.data || "")) ||
      "";

    return { status: "ok", region };
  }

  return { status: "error" };
}

async function getNetflixDisplayRegion(policy, region) {
  if (region) return region;
  const geo = await getGeoFallback(policy);
  return geo ? `${geo}*` : "未知";
}

function extractNetflixRegion(text) {
  const s = String(text || "");
  const patterns = [
    /netflix\.com\/([a-z]{2})\/title/i,
    /netflix\.com\/[a-z]{2}-([a-z]{2})\/title/i,
    /"countryCode"\s*:\s*"([A-Z]{2})"/i,
    /"country"\s*:\s*"([A-Z]{2})"/i,
    /"geoCountry"\s*:\s*"([A-Z]{2})"/i,
    /"requestCountry"\s*:\s*"([A-Z]{2})"/i,
    /"currentCountry"\s*:\s*"([A-Z]{2})"/i,
    /"countryOfSignup"\s*:\s*"([A-Z]{2})"/i,
    /"preferredLocale"\s*:\s*"[a-z]{2}-([A-Z]{2})"/i,
    /"locale"\s*:\s*"[a-z]{2}-([A-Z]{2})"/i,
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (!m || !m[1]) continue;

    const region = m[1].toUpperCase();
    if (["EN", "ZH", "JA", "KO", "FR", "DE", "ES", "IT", "PT"].includes(region)) continue;
    return region;
  }

  return "";
}

async function getGeoFallback(policy) {
  const apis = [
    "http://ip-api.com/json/?fields=status,countryCode",
    "https://ipapi.co/json/",
  ];

  for (const url of apis) {
    const res = await request("GET", url, policy, {
      timeout: 5,
      headers: REQUEST_HEADERS,
    });

    if (!res.ok || res.status !== 200) continue;

    try {
      const json = JSON.parse(res.data || "{}");
      if (json.countryCode) return String(json.countryCode).toUpperCase();
      if (json.country_code) return String(json.country_code).toUpperCase();
    } catch (_) {}
  }

  return "";
}

// YouTube Premium 检测
async function checkYouTube(policy) {
  const res = await request("GET", "https://www.youtube.com/premium", policy);

  if (!res.ok || res.status !== 200) return { ok: false, text: "⚠️ 检测失败" };

  const data = String(res.data || "");
  if (data.includes("Premium is not available in your country")) {
    return { ok: false, text: "❌ Premium 不支持" };
  }

  let region = "未知";
  const match = data.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
  if (match && match[1]) region = match[1].toUpperCase();
  else if (data.includes("www.google.cn")) region = "CN";

  return { ok: true, text: `✅ Premium ${region}` };
}

// Disney+ 检测
async function checkDisneyPlus(policy) {
  try {
    await withTimeout(disneyHome(policy), TIMEOUT * 1000);
    const info = await withTimeout(disneyLocation(policy), TIMEOUT * 1000);
    const region = (info.countryCode || "未知").toUpperCase();

    if (info.inSupportedLocation === false || info.inSupportedLocation === "false") {
      return { ok: false, text: `⚠️ 受限 ${region}` };
    }

    return { ok: true, text: `✅ ${region}` };
  } catch (e) {
    if (String(e) === "Not Available") return { ok: false, text: "❌ 不支持" };
    if (String(e) === "Timeout") return { ok: false, text: "⚠️ 超时" };
    return { ok: false, text: "⚠️ 检测失败" };
  }
}

async function disneyHome(policy) {
  const res = await request("GET", "https://www.disneyplus.com/", policy, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok || res.status !== 200) throw "Not Available";
  if (String(res.data || "").includes("Sorry, Disney+ is not available in your region.")) {
    throw "Not Available";
  }

  return true;
}

async function disneyLocation(policy) {
  const body = JSON.stringify({
    query:
      "mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }",
    variables: {
      input: {
        applicationRuntime: "chrome",
        attributes: {
          browserName: "chrome",
          browserVersion: "120.0.0",
          manufacturer: "apple",
          model: null,
          operatingSystem: "macintosh",
          operatingSystemVersion: "10.15.7",
          osDeviceIds: [],
        },
        deviceFamily: "browser",
        deviceLanguage: "en",
        deviceProfile: "macosx",
      },
    },
  });

  const res = await request(
    "POST",
    "https://disney.api.edge.bamgrid.com/graph/v1/device/graphql",
    policy,
    {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Authorization:
          "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84",
        "Content-Type": "application/json",
      },
      body,
    }
  );

  if (!res.ok || res.status !== 200) throw "Not Available";

  let json;
  try {
    json = JSON.parse(res.data);
  } catch (_) {
    throw "Parse Error";
  }

  if (json.errors) throw "Not Available";

  const sdk = json.extensions && json.extensions.sdk;
  const session = sdk && sdk.session;
  const location = session && session.location;

  return {
    inSupportedLocation: session ? session.inSupportedLocation : undefined,
    countryCode: location ? location.countryCode : "",
  };
}

function notifyIfChanged(signature, summary) {
  const key = "stream_group_unlock_last_result";
  const old = $persistentStore.read(key);

  if (old && old !== signature) {
    $notification.post("流媒体检测结果变化", "", summary, { sound: true });
  }

  $persistentStore.write(signature, key);
}

function hasAnyFailure(content) {
  return /❌|⚠️|失败|未找到|超时/.test(content);
}

function stringifyError(e) {
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch (_) {
    return String(e);
  }
}

function formatShortTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
