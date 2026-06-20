// Surge Panel：网络出口检测
// 展示：路径、当前节点、直连与代理的地区 / 平均延迟 / 抖动 / 丢包

const PANEL_TITLE = "网络出口检测";
const TARGET_GROUP = "FINAL";

// 保留 3 次采样，避免仅用两次数据导致抖动读数失真。
const SAMPLE_COUNT = 3;
const SAMPLE_INTERVAL_MS = 80;

const PREFERRED_KEYWORDS = [
  "代理", "Proxy", "PROXY", "节点", "手动", "选择", "故障", "转移",
  "智能", "Smart", "香港", "日本", "台湾", "新加坡", "美国", "Final", "FINAL"
];

const EXCLUDE_KEYWORDS = [
  "Apple", "苹果", "Microsoft", "微软", "Google", "YouTube", "Telegram",
  "Netflix", "Disney", "TikTok", "Bilibili", "哔哩", "广告", "AdBlock",
  "Domestic", "China", "中国", "直连", "下载"
];

// 只读取面板需要的出口 IP 与地区字段；失败时依次回退。
const IP_APIS = [
  {
    name: "ip-api",
    url: "http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,city,query",
    type: "json",
    parse(json) {
      if (json.status && json.status !== "success") {
        throw new Error(json.message || "ip-api 查询失败");
      }
      return {
        ip: json.query,
        country: json.country,
        city: json.city
      };
    }
  },
  {
    name: "ip.sb",
    url: "https://api.ip.sb/geoip",
    type: "json",
    parse(json) {
      return {
        ip: json.ip,
        country: json.country,
        city: json.city
      };
    }
  },
  {
    name: "Cloudflare Trace",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    type: "text",
    parse(text) {
      const obj = {};
      text.split("\n").forEach((line) => {
        const index = line.indexOf("=");
        if (index > -1) obj[line.slice(0, index)] = line.slice(index + 1);
      });
      return {
        ip: obj.ip,
        country: obj.loc || "",
        city: obj.colo ? "CF-" + obj.colo : ""
      };
    }
  },
  {
    name: "ipify",
    url: "https://api.ipify.org?format=json",
    type: "json",
    parse(json) {
      return {
        ip: json.ip,
        country: "",
        city: ""
      };
    }
  }
];

const QUALITY_TEST_URL = "http://connectivitycheck.gstatic.com/generate_204";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpAPI(method, path, body) {
  return new Promise((resolve) => {
    try {
      $httpAPI(method, path, body || null, (result) => resolve(result || null));
    } catch (_) {
      resolve(null);
    }
  });
}

function normalizeGroups(result) {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) return Object.keys(result);
  if (Array.isArray(result)) {
    return result.map((item) => {
      if (typeof item === "string") return item;
      if (item && item.name) return item.name;
      return null;
    }).filter(Boolean);
  }
  return [];
}

function scoreGroupName(name) {
  let score = 0;
  for (const keyword of PREFERRED_KEYWORDS) {
    if (name.indexOf(keyword) !== -1) score += 10;
  }
  for (const keyword of EXCLUDE_KEYWORDS) {
    if (name.indexOf(keyword) !== -1) score -= 20;
  }
  if (/Apple|Google|Telegram|Netflix|Disney|TikTok|Bilibili|Microsoft/i.test(name)) {
    score -= 30;
  }
  return score;
}

function getSelectedFromResult(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  return result.policy || result.selected || result.current || result.now || result.name || null;
}

async function getTargetPolicyGroup() {
  const groupsResult = await httpAPI("GET", "/v1/policy_groups", null);
  const groups = normalizeGroups(groupsResult);

  if (!groups.length) {
    return { targetGroup: null, checkPolicy: null, currentUsing: null, allGroups: [] };
  }

  if (TARGET_GROUP && groups.indexOf(TARGET_GROUP) !== -1) {
    const resolved = await resolveUsablePolicy(TARGET_GROUP, groups);
    return {
      targetGroup: TARGET_GROUP,
      checkPolicy: resolved.checkPolicy,
      currentUsing: resolved.currentUsing,
      allGroups: groups
    };
  }

  const sorted = groups
    .map((name, index) => ({ name, index, score: scoreGroupName(name) }))
    .sort((a, b) => b.score !== a.score ? b.score - a.score : a.index - b.index);

  const targetGroup = sorted[0].name;
  const resolved = await resolveUsablePolicy(targetGroup, groups);

  return {
    targetGroup,
    checkPolicy: resolved.checkPolicy,
    currentUsing: resolved.currentUsing,
    allGroups: groups
  };
}

async function resolveUsablePolicy(startGroup, allGroups) {
  const groupSet = {};
  allGroups.forEach((name) => { groupSet[name] = true; });

  let currentGroup = startGroup;
  let checkPolicy = startGroup;
  let currentUsing = null;
  const visited = {};

  for (let i = 0; i < 10; i++) {
    if (!currentGroup || visited[currentGroup]) break;
    visited[currentGroup] = true;

    const result = await httpAPI(
      "GET",
      "/v1/policy_groups/select?group_name=" + encodeURIComponent(currentGroup),
      null
    );

    const selected = getSelectedFromResult(result);
    if (!selected) {
      currentUsing = currentGroup;
      checkPolicy = currentGroup;
      break;
    }

    currentUsing = selected;
    if (groupSet[selected]) {
      checkPolicy = selected;
      currentGroup = selected;
      continue;
    }
    break;
  }

  return { checkPolicy, currentUsing };
}

function requestOneAPI(api, policy) {
  return new Promise((resolve) => {
    const start = Date.now();
    const option = {
      url: api.url,
      timeout: 5,
      headers: { "User-Agent": "Surge Network Path Panel" }
    };

    if (policy) option.policy = policy;

    $httpClient.get(option, (error, response, data) => {
      const ms = Date.now() - start;
      if (error) {
        resolve({ ok: false, api: api.name, policy, error: String(error), ms });
        return;
      }

      try {
        const parsed = api.type === "text" ? api.parse(data) : api.parse(JSON.parse(data));
        if (!parsed || !parsed.ip) {
          resolve({ ok: false, api: api.name, policy, error: "接口返回中没有 IP", ms });
          return;
        }
        resolve({
          ok: true,
          api: api.name,
          policy,
          ip: parsed.ip || "未知",
          country: parsed.country || "",
          city: parsed.city || "",
          ms
        });
      } catch (e) {
        resolve({ ok: false, api: api.name, policy, error: "解析失败：" + e.message, ms });
      }
    });
  });
}

async function queryIP(policy) {
  const failed = [];
  for (const api of IP_APIS) {
    const result = await requestOneAPI(api, policy);
    if (result.ok) return result;
    failed.push(result);
  }
  return {
    ok: false,
    policy,
    error: failed.map((x) => x.api + ": " + x.error).join("\n"),
    ms: Math.max.apply(null, failed.map((x) => x.ms || 0))
  };
}

async function queryProxyIP(checkPolicy, fallbackPolicy) {
  const result = await queryIP(checkPolicy);
  if (result.ok) return result;

  const err = result.error || "";
  if (fallbackPolicy && fallbackPolicy !== checkPolicy && err.indexOf("doesn't exist") !== -1) {
    const fallbackResult = await queryIP(fallbackPolicy);
    if (fallbackResult.ok) {
      fallbackResult.policy = fallbackPolicy;
      return fallbackResult;
    }
  }
  return result;
}

function qualityProbe(policy) {
  return new Promise((resolve) => {
    const start = Date.now();
    const option = {
      url: QUALITY_TEST_URL,
      timeout: 5,
      headers: {
        "User-Agent": "Surge Network Quality Panel",
        "Cache-Control": "no-cache"
      }
    };
    if (policy) option.policy = policy;

    $httpClient.get(option, (error, response) => {
      const ms = Date.now() - start;
      if (error) {
        resolve({ ok: false, ms, error: String(error) });
        return;
      }
      const status = response ? response.status : 0;
      if (status >= 200 && status < 400) resolve({ ok: true, ms });
      else resolve({ ok: false, ms, error: "HTTP " + status });
    });
  });
}

async function testNetworkQuality(policy) {
  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    samples.push(await qualityProbe(policy));
    if (i < SAMPLE_COUNT - 1) await sleep(SAMPLE_INTERVAL_MS);
  }

  const success = samples.filter((x) => x.ok);
  const lossRate = Math.round(((samples.length - success.length) / samples.length) * 100);

  if (!success.length) {
    return { ok: false, avg: null, jitter: null, lossRate };
  }

  const times = success.map((x) => x.ms);
  const min = Math.min.apply(null, times);
  const max = Math.max.apply(null, times);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);

  return {
    ok: true,
    avg,
    jitter: max - min,
    lossRate
  };
}

function compactLocation(info) {
  let country = String(info.country || "").trim();
  let city = String(info.city || "").trim();

  country = country
    .replace(/^Taiwan$/i, "台湾")
    .replace(/[臺台]灣/g, "台湾");
  city = city
    .replace(/[臺台]灣省\s*(or\s*)?/gi, "")
    .replace(/市$/, "")
    .trim();

  if (country && city && city !== country) return country + "·" + city;
  return country || city || info.ip || "未知位置";
}

function compactMetrics(quality) {
  if (!quality || !quality.ok) return "测速失败";
  return quality.avg + "ms / 抖" + quality.jitter + " / 丢" + quality.lossRate + "%";
}

function compactPolicyName(name, maxLength) {
  const text = String(name || "未知策略");
  const limit = maxLength || 24;
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function formatExitLine(label, info, quality) {
  if (!info.ok) {
    const latency = info.ms ? " · " + info.ms + "ms" : "";
    return label + "：检测失败" + latency;
  }
  return label + "：" + compactLocation(info) + " · " + compactMetrics(quality);
}

async function main() {
  const policyInfo = await getTargetPolicyGroup();
  const targetGroup = policyInfo.targetGroup;
  const checkPolicy = policyInfo.checkPolicy;
  const currentUsing = policyInfo.currentUsing;

  if (!targetGroup || !checkPolicy) {
    const [directOnly, directQualityOnly] = await Promise.all([
      queryIP("DIRECT"),
      testNetworkQuality("DIRECT")
    ]);

    $done({
      title: PANEL_TITLE,
      content: [
        "路径：无法读取策略组",
        formatExitLine("直连", directOnly, directQualityOnly)
      ].join("\n"),
      style: "error"
    });
    return;
  }

  const [direct, proxy, directQuality, proxyQuality] = await Promise.all([
    queryIP("DIRECT"),
    queryProxyIP(checkPolicy, targetGroup),
    testNetworkQuality("DIRECT"),
    testNetworkQuality(checkPolicy)
  ]);

  let mode = "未知";
  let style = "info";

  if (direct.ok && proxy.ok) {
    if (direct.ip === proxy.ip) {
      mode = "直连 / 代理未生效";
      style = "alert";
    } else {
      mode = "代理 / 中转";
      style = "good";
    }
  } else if (direct.ok && !proxy.ok) {
    mode = "代理检测失败";
    style = "error";
  } else if (!direct.ok && proxy.ok) {
    mode = "直连检测失败";
  } else {
    mode = "全部检测失败";
    style = "error";
  }

  const content = [
    "路径：" + mode + " · " + targetGroup,
    "节点：" + compactPolicyName(currentUsing || checkPolicy),
    formatExitLine("直连", direct, directQuality),
    formatExitLine("代理", proxy, proxyQuality)
  ].join("\n");

  $done({ title: PANEL_TITLE, content, style });
}

// 仅执行一次。原脚本末尾重复调用 main() 会导致整套检测重复发起。
main();  },
  {
    name: "ipify",
    url: "https://api.ipify.org?format=json",
    type: "json",
    parse(json) {
      return {
        ip: json.ip,
        country: "仅 IP 检测",
        region: "",
        city: "",
        isp: "未知 ISP",
        org: "ipify fallback"
      };
    }
  }
];

const QUALITY_TEST_URL = "http://connectivitycheck.gstatic.com/generate_204";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpAPI(method, path, body) {
  return new Promise((resolve) => {
    try {
      $httpAPI(method, path, body || null, (result) => {
        resolve(result || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function normalizeGroups(result) {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) {
    return Object.keys(result);
  }
  if (Array.isArray(result)) {
    return result.map((item) => {
      if (typeof item === "string") return item;
      if (item && item.name) return item.name;
      return null;
    }).filter(Boolean);
  }
  return [];
}

function scoreGroupName(name) {
  let score = 0;

  for (const keyword of PREFERRED_KEYWORDS) {
    if (name.indexOf(keyword) !== -1) score += 10;
  }

  for (const keyword of EXCLUDE_KEYWORDS) {
    if (name.indexOf(keyword) !== -1) score -= 20;
  }

  if (/Apple|Google|Telegram|Netflix|Disney|TikTok|Bilibili|Microsoft/i.test(name)) {
    score -= 30;
  }

  return score;
}

function getSelectedFromResult(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  return result.policy || result.selected || result.current || result.now || result.name || null;
}

async function getTargetPolicyGroup() {
  const groupsResult = await httpAPI("GET", "/v1/policy_groups", null);
  const groups = normalizeGroups(groupsResult);

  if (!groups.length) {
    return { targetGroup: null, checkPolicy: null, currentUsing: null, allGroups: [] };
  }

  if (TARGET_GROUP && groups.indexOf(TARGET_GROUP) !== -1) {
    const resolved = await resolveUsablePolicy(TARGET_GROUP, groups);
    return {
      targetGroup: TARGET_GROUP,
      checkPolicy: resolved.checkPolicy,
      currentUsing: resolved.currentUsing,
      allGroups: groups
    };
  }

  const sorted = groups
    .map((name, index) => ({ name, index, score: scoreGroupName(name) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  const targetGroup = sorted[0].name;
  const resolved = await resolveUsablePolicy(targetGroup, groups);

  return {
    targetGroup,
    checkPolicy: resolved.checkPolicy,
    currentUsing: resolved.currentUsing,
    allGroups: groups
  };
}

async function resolveUsablePolicy(startGroup, allGroups) {
  const groupSet = {};
  allGroups.forEach((name) => {
    groupSet[name] = true;
  });

  let currentGroup = startGroup;
  let checkPolicy = startGroup;
  let currentUsing = null;
  const visited = {};

  for (let i = 0; i < 10; i++) {
    if (!currentGroup || visited[currentGroup]) break;
    visited[currentGroup] = true;

    const result = await httpAPI(
      "GET",
      "/v1/policy_groups/select?group_name=" + encodeURIComponent(currentGroup),
      null
    );

    const selected = getSelectedFromResult(result);

    if (!selected) {
      currentUsing = currentGroup;
      checkPolicy = currentGroup;
      break;
    }

    currentUsing = selected;

    if (groupSet[selected]) {
      checkPolicy = selected;
      currentGroup = selected;
      continue;
    }

    break;
  }

  return { checkPolicy, currentUsing };
}

function requestOneAPI(api, policy) {
  return new Promise((resolve) => {
    const start = Date.now();

    const option = {
      url: api.url,
      timeout: 5,
      headers: {
        "User-Agent": "Surge Network Path Panel"
      }
    };

    if (policy) option.policy = policy;

    $httpClient.get(option, (error, response, data) => {
      const ms = Date.now() - start;

      if (error) {
        resolve({ ok: false, api: api.name, policy, error: String(error), ms });
        return;
      }

      try {
        const parsed = api.type === "text" ? api.parse(data) : api.parse(JSON.parse(data));

        if (!parsed || !parsed.ip) {
          resolve({ ok: false, api: api.name, policy, error: "接口返回中没有 IP", ms });
          return;
        }

        resolve({
          ok: true,
          api: api.name,
          policy,
          ip: parsed.ip || "未知",
          country: parsed.country || "未知国家",
          region: parsed.region || "",
          city: parsed.city || "",
          isp: parsed.isp || "未知 ISP",
          org: parsed.org || "未知组织",
          ms
        });
      } catch (e) {
        resolve({
          ok: false,
          api: api.name,
          policy,
          error: "解析失败：" + e.message,
          ms
        });
      }
    });
  });
}

async function queryIP(policy) {
  const failed = [];

  for (const api of IP_APIS) {
    const result = await requestOneAPI(api, policy);
    if (result.ok) return result;
    failed.push(result);
  }

  return {
    ok: false,
    policy,
    error: failed.map((x) => x.api + ": " + x.error).join("\n"),
    ms: Math.max.apply(null, failed.map((x) => x.ms || 0))
  };
}

async function queryProxyIP(checkPolicy, fallbackPolicy) {
  let result = await queryIP(checkPolicy);

  if (result.ok) return result;

  const err = result.error || "";

  if (
    fallbackPolicy &&
    fallbackPolicy !== checkPolicy &&
    err.indexOf("doesn't exist") !== -1
  ) {
    const fallbackResult = await queryIP(fallbackPolicy);

    if (fallbackResult.ok) {
      fallbackResult.policy = fallbackPolicy;
      fallbackResult.note = "已回退到顶层策略组检测";
      return fallbackResult;
    }
  }

  return result;
}

function qualityProbe(policy) {
  return new Promise((resolve) => {
    const start = Date.now();

    const option = {
      url: QUALITY_TEST_URL,
      timeout: 5,
      headers: {
        "User-Agent": "Surge Network Quality Panel",
        "Cache-Control": "no-cache"
      }
    };

    if (policy) option.policy = policy;

    $httpClient.get(option, (error, response) => {
      const ms = Date.now() - start;

      if (error) {
        resolve({ ok: false, ms, error: String(error) });
        return;
      }

      const status = response ? response.status : 0;

      if (status >= 200 && status < 400) {
        resolve({ ok: true, ms });
      } else {
        resolve({ ok: false, ms, error: "HTTP " + status });
      }
    });
  });
}

async function testNetworkQuality(policy) {
  const samples = [];

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const result = await qualityProbe(policy);
    samples.push(result);

    if (i < SAMPLE_COUNT - 1) {
      await sleep(SAMPLE_INTERVAL_MS);
    }
  }

  const success = samples.filter((x) => x.ok);
  const failed = samples.length - success.length;
  const lossRate = Math.round((failed / samples.length) * 100);

  if (!success.length) {
    return {
      ok: false,
      avg: null,
      min: null,
      max: null,
      jitter: null,
      lossRate,
      quality: "不可用",
      samples
    };
  }

  const times = success.map((x) => x.ms);
  const min = Math.min.apply(null, times);
  const max = Math.max.apply(null, times);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const jitter = max - min;

  return {
    ok: true,
    avg,
    min,
    max,
    jitter,
    lossRate,
    quality: getQualityLevel(avg, jitter, lossRate),
    samples
  };
}

function getQualityLevel(avg, jitter, lossRate) {
  if (lossRate >= 30) return "较差";
  if (lossRate >= 10) return "一般";

  if (avg <= 80 && jitter <= 30 && lossRate === 0) return "优秀";
  if (avg <= 150 && jitter <= 80 && lossRate <= 5) return "良好";
  if (avg <= 300 && jitter <= 150 && lossRate <= 10) return "一般";

  return "较差";
}

function formatLocation(info) {
  const arr = [info.country, info.region, info.city].filter(Boolean);
  return arr.length ? arr.join(" ") : "未知位置";
}

function formatQuality(q) {
  if (!q || !q.ok) {
    return [
      "质量：不可用",
      "丢包：" + (q ? q.lossRate : "-") + "%"
    ].join("\n");
  }

  return [
    "质量：" + q.quality,
    "平均：" + q.avg + "ms",
    "最低：" + q.min + "ms",
    "最高：" + q.max + "ms",
    "抖动：" + q.jitter + "ms",
    "丢包：" + q.lossRate + "%"
  ].join("\n");
}

function formatInfo(title, info, quality) {
  if (!info.ok) {
    return [
      title,
      "状态：失败",
      "错误：" + (info.error || "未知错误"),
      "延迟：" + (info.ms || "-") + "ms",
      quality ? formatQuality(quality) : ""
    ].filter(Boolean).join("\n");
  }

  return [
    title,
    "IP：" + info.ip,
    "位置：" + formatLocation(info),
    "ISP：" + info.isp,
    "组织：" + info.org,
    "接口：" + info.api,
    "延迟：" + info.ms + "ms",
    formatQuality(quality)
  ].join("\n");
}

async function main() {
  const policyInfo = await getTargetPolicyGroup();

  const targetGroup = policyInfo.targetGroup;
  const checkPolicy = policyInfo.checkPolicy;
  const currentUsing = policyInfo.currentUsing;

  if (!targetGroup || !checkPolicy) {
    const directOnly = await queryIP("DIRECT");
    const directQualityOnly = await testNetworkQuality("DIRECT");

    $done({
      title: PANEL_TITLE,
      content: [
        "当前路径：无法读取策略组",
        "",
        formatInfo("本地直连出口", directOnly, directQualityOnly)
      ].join("\n"),
      style: "error"
    });

    return;
  }

  const directPromise = queryIP("DIRECT");
  const proxyPromise = queryProxyIP(checkPolicy, targetGroup);
  const directQualityPromise = testNetworkQuality("DIRECT");
  const proxyQualityPromise = testNetworkQuality(checkPolicy);

  const results = await Promise.all([
    directPromise,
    proxyPromise,
    directQualityPromise,
    proxyQualityPromise
  ]);

  const direct = results[0];
  const proxy = results[1];
  const directQuality = results[2];
  const proxyQuality = results[3];

  let mode = "未知";
  let style = "info";

  if (direct.ok && proxy.ok) {
    if (direct.ip === proxy.ip) {
      mode = "直连 / 代理未生效";
      style = "alert";
    } else {
      mode = "代理 / 中转";
      style = "good";
    }
  } else if (direct.ok && !proxy.ok) {
    mode = "代理检测失败";
    style = "error";
  } else if (!direct.ok && proxy.ok) {
    mode = "直连检测失败，代理检测成功";
    style = "info";
  } else {
    mode = "全部检测失败";
    style = "error";
  }

  const content = [
    "当前路径：" + mode,
    "检测策略组：" + targetGroup,
    "当前使用：" + (currentUsing || checkPolicy),
    "",
    formatInfo("本地直连出口", direct, directQuality),
    "",
    formatInfo("代理出口检测", proxy, proxyQuality)
  ].join("\n");

  $done({
    title: PANEL_TITLE,
    content,
    style
  });
}

main();

main();
