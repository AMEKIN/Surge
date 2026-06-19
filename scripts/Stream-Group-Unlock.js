// Surge Panel：指定策略组流媒体解锁检测
// 功能：
// 1. 自动识别或手动指定 Netflix / Disney+ / YouTube / Prime Video 策略组
// 2. 检测该策略组当前出口的流媒体解锁状态
// 3. 不切换节点，不修改策略组，只读取当前选择并固定用 policy 发起检测
// 4. 支持 Panel 展示，支持结果变化通知

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REQUEST_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
};

const DEFAULT_ICON = "play.tv.fill";
const DEFAULT_COLOR = "#FF2D55";
const TIMEOUT = 8;

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
  {
    id: "prime",
    name: "Prime Video",
    groupArg: "prime_group",
    keywords: ["prime", "prime video", "amazon", "亚马逊"],
    checker: checkPrimeVideo,
  },
];

(async () => {
  const startedAt = Date.now();

  try {
    const profileText = await getCurrentProfileText();
    const groups = parseProxyGroups(profileText);

    if (!groups || Object.keys(groups).length === 0) {
      return donePanel({
        title: "流媒体解锁检测",
        content: "⚠️ 未能读取到 [Proxy Group]\n请确认 Surge HTTP API / 脚本权限正常",
        color: "#FF9500",
      });
    }

    const lines = [];
    const results = [];

    for (const service of SERVICES) {
      const groupName = findServiceGroup(service, groups);

      if (!groupName) {
        const exact = cleanArg(args[service.groupArg]);
        if (exact && exact.toLowerCase() !== "auto") {
          lines.push(`${service.name}: ⚠️ 未找到策略组「${exact}」`);
        } else {
          lines.push(`${service.name}: ⚠️ 未匹配到策略组`);
        }
        continue;
      }

      const chain = await resolvePolicyChain(groupName, groups);
      const nodeName = chain.length > 1 ? chain[chain.length - 1] : groupName;

      let result;
      try {
        result = await service.checker(groupName);
      } catch (e) {
        result = {
          ok: false,
          text: "检测失败",
          detail: stringifyError(e),
          color: "warn",
        };
      }

      const chainText = chain.length > 1 ? chain.join(" → ") : groupName;
      const line = `${service.name}: ${result.text}\n  组: ${groupName}\n  当前: ${nodeName}`;

      lines.push(line);
      results.push({
        service: service.name,
        group: groupName,
        node: nodeName,
        result: result.text,
        chain: chainText,
      });
    }

    const cost = ((Date.now() - startedAt) / 1000).toFixed(1);
    const content = `${lines.join("\n\n")}\n\n⏱ ${cost}s  ·  ${formatTime(new Date())}`;

    if (CONFIG.notify) {
      notifyIfChanged(content);
    }

    donePanel({
      title: "流媒体解锁检测",
      content,
      color: hasAnyFailure(content) ? "#FF9500" : "#30D158",
    });
  } catch (e) {
    donePanel({
      title: "流媒体解锁检测",
      content: `❌ 脚本异常\n${stringifyError(e)}`,
      color: "#FF3B30",
    });
  }
})();

function parseArgs(argument) {
  const obj = {};
  argument.split("&").forEach((part) => {
    if (!part) return;
    const idx = part.indexOf("=");
    if (idx === -1) {
      obj[safeDecode(part)] = "";
      return;
    }
    const key = safeDecode(part.slice(0, idx)).trim();
    const val = safeDecode(part.slice(idx + 1)).trim();
    obj[key] = val;
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
    title: title || "流媒体解锁检测",
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

  const possibleKeys = [
    "profile",
    "content",
    "text",
    "config",
    "body",
    "data",
  ];

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
    let line = rawLine.trim();

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

    groups[name] = {
      name,
      type,
      options,
      raw: body,
    };
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

  return [
    "DIRECT",
    "REJECT",
    "REJECT-TINYGIF",
    "REJECT-DROP",
    "REJECT-NO-DROP",
  ].includes(t);
}

function findServiceGroup(service, groups) {
  const groupNames = Object.keys(groups);
  const exact = cleanArg(args[service.groupArg]);

  if (exact) {
    const exactHit = groupNames.find((name) => name === exact);
    if (exactHit) return exactHit;

    const normalizedHit = groupNames.find(
      (name) => normalize(name) === normalize(exact)
    );
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
    if (!selected) break;
    if (chain.includes(selected)) break;

    chain.push(selected);
    current = selected;

    if (!groups[current]) break;
  }

  return chain;
}

async function getSelectedPolicy(groupName) {
  const path =
    "/v1/policy_groups/select?group_name=" + encodeURIComponent(groupName);
  const result = await httpAPI("GET", path, {});

  if (result && typeof result.policy === "string") {
    return result.policy;
  }

  if (result && typeof result.selected === "string") {
    return result.selected;
  }

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

    if (opt.body !== undefined) {
      options.body = opt.body;
    }

    const fn = method.toLowerCase();

    $httpClient[fn](options, (error, response, data) => {
      if (error) {
        resolve({
          ok: false,
          error,
          status: 0,
          headers: {},
          data: "",
        });
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
    new Promise((_, reject) => {
      setTimeout(() => reject("Timeout"), ms);
    }),
  ]);
}

// Netflix 检测：
// 81280792 用于检测非自制片库，80018499 用于自制内容兜底。
async function checkNetflix(policy) {
  const full = await netflixInner(policy, "81280792");

  if (full.status === "ok") {
    return {
      ok: true,
      text: `✅ 完整解锁 ${full.region}`,
    };
  }

  if (full.status === "blocked") {
    return {
      ok: false,
      text: "❌ 不支持",
    };
  }

  if (full.status === "not_found") {
    const original = await netflixInner(policy, "80018499");

    if (original.status === "ok") {
      return {
        ok: true,
        text: `⚠️ 仅自制剧 ${original.region}`,
      };
    }

    if (original.status === "not_found" || original.status === "blocked") {
      return {
        ok: false,
        text: "❌ 不支持",
      };
    }
  }

  return {
    ok: false,
    text: "⚠️ 检测失败",
  };
}

async function netflixInner(policy, filmId) {
  const res = await request(
    "GET",
    `https://www.netflix.com/title/${filmId}`,
    policy
  );

  if (!res.ok) return { status: "error" };

  if (res.status === 403) return { status: "blocked" };
  if (res.status === 404) return { status: "not_found" };

  if (res.status === 200) {
    let region = "未知";

    const originUrl = getHeader(res.headers, "x-originating-url");
    if (originUrl) {
      const match = originUrl.match(/netflix\.com\/([a-z]{2})\//i);
      if (match && match[1]) region = match[1].toUpperCase();
    }

    if (region === "未知") {
      const htmlMatch = String(res.data).match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
      if (htmlMatch && htmlMatch[1]) region = htmlMatch[1].toUpperCase();
    }

    return {
      status: "ok",
      region,
    };
  }

  return { status: "error" };
}

// YouTube Premium 检测
async function checkYouTube(policy) {
  const res = await request(
    "GET",
    "https://www.youtube.com/premium",
    policy
  );

  if (!res.ok || res.status !== 200) {
    return {
      ok: false,
      text: "⚠️ 检测失败",
    };
  }

  const data = String(res.data || "");

  if (data.includes("Premium is not available in your country")) {
    return {
      ok: false,
      text: "❌ Premium 不支持",
    };
  }

  let region = "未知";

  const match = data.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
  if (match && match[1]) region = match[1].toUpperCase();
  else if (data.includes("www.google.cn")) region = "CN";

  return {
    ok: true,
    text: `✅ Premium ${region}`,
  };
}

// Disney+ 检测
async function checkDisneyPlus(policy) {
  try {
    await withTimeout(disneyHome(policy), TIMEOUT * 1000);
    const info = await withTimeout(disneyLocation(policy), TIMEOUT * 1000);

    const region = (info.countryCode || "未知").toUpperCase();

    if (
      info.inSupportedLocation === false ||
      info.inSupportedLocation === "false"
    ) {
      return {
        ok: false,
        text: `⚠️ 即将登陆/受限 ${region}`,
      };
    }

    return {
      ok: true,
      text: `✅ 已解锁 ${region}`,
    };
  } catch (e) {
    if (String(e) === "Not Available") {
      return {
        ok: false,
        text: "❌ 不支持",
      };
    }

    if (String(e) === "Timeout") {
      return {
        ok: false,
        text: "⚠️ 检测超时",
      };
    }

    return {
      ok: false,
      text: "⚠️ 检测失败",
    };
  }
}

async function disneyHome(policy) {
  const res = await request(
    "GET",
    "https://www.disneyplus.com/",
    policy,
    {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
    }
  );

  if (!res.ok || res.status !== 200) throw "Not Available";

  const data = String(res.data || "");

  if (data.includes("Sorry, Disney+ is not available in your region.")) {
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
        "Authorization":
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

// Prime Video 轻量检测
// 说明：Prime Video 受账号、订阅、地区、影片版权等因素影响更明显。
// 这里主要检测 Prime Video 站点区域访问与页面地区，不等价于所有片库完整播放。
async function checkPrimeVideo(policy) {
  const res = await request(
    "GET",
    "https://www.primevideo.com/",
    policy,
    {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
    }
  );

  if (!res.ok) {
    return {
      ok: false,
      text: "⚠️ 检测失败",
    };
  }

  const data = String(res.data || "");

  if (
    res.status === 403 ||
    data.includes("not available in your location") ||
    data.includes("Service area restriction") ||
    data.includes("not available in your country")
  ) {
    return {
      ok: false,
      text: "❌ 不支持",
    };
  }

  let region = extractPrimeRegion(data);

  if (res.status >= 200 && res.status < 400) {
    return {
      ok: true,
      text: region ? `✅ 可访问 ${region}` : "✅ 可访问，地区未知",
    };
  }

  return {
    ok: false,
    text: `⚠️ 状态异常 HTTP ${res.status}`,
  };
}

function extractPrimeRegion(data) {
  const patterns = [
    /"currentTerritory"\s*:\s*"([A-Z]{2})"/i,
    /"territory"\s*:\s*"([A-Z]{2})"/i,
    /"countryCode"\s*:\s*"([A-Z]{2})"/i,
    /"geoCountry"\s*:\s*"([A-Z]{2})"/i,
    /"marketplaceCountry"\s*:\s*"([A-Z]{2})"/i,
  ];

  for (const p of patterns) {
    const m = data.match(p);
    if (m && m[1]) return m[1].toUpperCase();
  }

  return "";
}

function notifyIfChanged(content) {
  const key = "stream_group_unlock_last_result";
  const old = $persistentStore.read(key);

  if (old && old !== content) {
    $notification.post("流媒体检测结果变化", "", content, {
      sound: true,
    });
  }

  $persistentStore.write(content, key);
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

function formatTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
