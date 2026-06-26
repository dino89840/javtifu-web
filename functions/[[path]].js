// ============================================================
//  Cloudflare Pages Function — _worker.js  (functions/_worker.js)
//  javtiful.com proxy  ·  Fixed: images + R2 signed video URLs
// ============================================================

const TARGET_HOST   = "javtiful.com";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const PROXY_PATH    = "/__proxy";

const ALLOW_ANY_EXTERNAL_HOST = true;

// ✅ FIX 1: CDN/player hosts whitelist — ad filter မှ ကျော်သွားစေ
const CDN_WHITELIST_HOSTS = new Set([
  "sspark.genspark.ai",
  "cdn.plyr.io",
  "vjs.zencdn.net",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "www.googletagmanager.com",   // gtag script — block မလုပ်
  "www.google-analytics.com",   // analytics — block မလုပ်
]);

const ALLOWED_HOST_SUFFIXES = [
  TARGET_HOST,
  `www.${TARGET_HOST}`,
];

const AD_KEYWORDS = [
  "adserver",
  "adsterra",
  "juicyads",
  "exoclick",
  "popads",
  "popcash",
  "popunder",
  "doubleclick",
  "googlesyndication",
  // ✅ FIX: google-analytics / googletagmanager ဖယ်ထုတ်
  //   → site ၏ plyr/player script တွေ break မဖြစ်အောင်
  "histats",
  "trafficjunky",
  "trafficfactory",
  "propellerads",
  "hilltopads",
  "a.exdynsrv.com",
  "exdynsrv",
  "revcontent",
  "mgid",
  "taboola",
  "outbrain",
];

const REWRITE_ATTRS = [
  "href", "src", "action", "poster",
  "data-src", "data-href", "data-url",
  "data-original", "data-poster", "data-lazy",
  "data-image", "data-thumb",
];

// ✅ FIX 2: R2/S3 presigned URL detection
//   X-Amz-Signature ပါသော URL → proxy မဖြတ်ဘဲ direct access ပေး
function isSignedUrl(url) {
  const u = url instanceof URL ? url : null;
  if (!u) return false;
  return (
    u.searchParams.has("X-Amz-Signature") ||
    u.searchParams.has("x-amz-signature") ||
    u.searchParams.has("Signature") ||           // older S3
    (u.searchParams.has("X-Amz-Expires") &&
     u.searchParams.has("X-Amz-Credential"))
  );
}

// ============================================================
//  Main request handler
// ============================================================
export async function onRequest(context) {
  const request     = context.request;
  const incomingUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let targetUrl;
  try {
    targetUrl = getTargetUrl(incomingUrl);
  } catch {
    return new Response("Bad proxy URL", { status: 400 });
  }

  if (!isAllowedUrl(targetUrl)) {
    return new Response("Blocked by proxy filter", { status: 403 });
  }

  if (isAdUrl(targetUrl)) {
    return emptyBlockedResponse();
  }

  // ✅ FIX 3: R2 signed URL → direct 302 redirect
  //   Proxy worker ကနေ ဖြတ်မသွားဘဲ browser ကို တိုက်ရိုက် R2 URL ပို့
  if (isSignedUrl(targetUrl)) {
    return Response.redirect(targetUrl.toString(), 302);
  }

  const upstreamHeaders = buildRequestHeaders(request, targetUrl);
  const fetchInit = {
    method:   request.method,
    headers:  upstreamHeaders,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    fetchInit.body = request.body;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), fetchInit);
  } catch (err) {
    return new Response(`Proxy fetch error: ${err.message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  // ── Redirect ─────────────────────────────────────────────────────────────
  if (isRedirect(upstreamResponse.status)) {
    const location = upstreamResponse.headers.get("location");
    const headers  = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, false);

    if (location) {
      const abs = safeResolveUrl(location, targetUrl);
      if (abs) {
        // ✅ FIX: Redirect が signed URL なら direct
        if (isSignedUrl(abs)) {
          headers.set("location", abs.toString());
        } else if (isAllowedUrl(abs)) {
          headers.set("location", proxifyUrl(abs, incomingUrl));
        }
      }
    }
    return new Response(null, { status: upstreamResponse.status, headers });
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const pathname    = targetUrl.pathname.toLowerCase();

  // ── HTML ─────────────────────────────────────────────────────────────────
  if (contentType.includes("text/html")) {
    let html = await upstreamResponse.text();
    html = removeAdBlocksFromHtml(html);
    html = rewriteTextUrls(html, targetUrl, incomingUrl);
    html = injectAntiAdCss(html);
    html = injectVideoPlayerPatch(html, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "text/html; charset=UTF-8");

    const resp = new Response(html, { status: upstreamResponse.status, headers });

    return new HTMLRewriter()
      .on("script, iframe, embed, object", new RemoveAdElementHandler(targetUrl))
      .on(
        "a, link, img, script, iframe, source, video, audio, form, embed, object, track",
        new AttrRewriteHandler(targetUrl, incomingUrl),
      )
      .on("[style]",   new StyleAttrRewriteHandler(targetUrl, incomingUrl))
      .on("noscript",  new NoscriptRewriteHandler(targetUrl, incomingUrl))
      .transform(resp);
  }

  // ── HLS m3u8 ─────────────────────────────────────────────────────────────
  if (
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("application/x-mpegurl") ||
    pathname.endsWith(".m3u8")
  ) {
    let playlist = await upstreamResponse.text();
    playlist = rewriteM3U8(playlist, targetUrl, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "application/vnd.apple.mpegurl; charset=UTF-8");
    return new Response(playlist, { status: upstreamResponse.status, headers });
  }

  // ── CSS ──────────────────────────────────────────────────────────────────
  if (contentType.includes("text/css") || pathname.endsWith(".css")) {
    let css = await upstreamResponse.text();
    css = rewriteCssUrls(css, targetUrl, incomingUrl);
    css = rewriteTextUrls(css, targetUrl, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "text/css; charset=UTF-8");
    return new Response(css, { status: upstreamResponse.status, headers });
  }

  // ── JS / JSON / text ─────────────────────────────────────────────────────
  if (
    contentType.includes("javascript") ||
    contentType.includes("application/json") ||
    contentType.includes("text/plain") ||
    contentType.includes("application/xml") ||
    contentType.includes("text/xml") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".json")
  ) {
    let text = await upstreamResponse.text();

    if (!isVideoPlayerScript(targetUrl.pathname)) {
      text = removeAdCodeFromText(text);
    }

    // ✅ FIX 4: JSON response ထဲ R2 signed URL ပါနိုင်သောကြောင့်
    //   rewriteTextUrls မလုပ်ဘဲ JSON-aware rewrite သုံး
    if (
      contentType.includes("application/json") ||
      pathname.endsWith(".json")
    ) {
      text = rewriteJsonTextSafe(text, targetUrl, incomingUrl);
    } else {
      text = rewriteTextUrls(text, targetUrl, incomingUrl);
    }

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    return new Response(text, { status: upstreamResponse.status, headers });
  }

  // ── Binary ───────────────────────────────────────────────────────────────
  const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, false);
  return new Response(upstreamResponse.body, {
    status:     upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

// ============================================================
//  URL helpers
// ============================================================
function getTargetUrl(incomingUrl) {
  if (incomingUrl.pathname === PROXY_PATH) {
    const raw = incomingUrl.searchParams.get("url");
    if (!raw) throw new Error("Missing url parameter");
    const decoded = decodeURIComponent(raw);
    const target  = new URL(decoded);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("Invalid protocol");
    }
    return target;
  }
  return new URL(incomingUrl.pathname + incomingUrl.search, TARGET_ORIGIN);
}

function safeResolveUrl(value, baseUrl) {
  if (!value) return null;
  const trimmed = value.trim();
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("blob:")
  ) return null;
  try {
    return new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
}

function proxifyUrl(targetUrl, incomingUrl) {
  const u = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);

  if (isAdUrl(u)) return "about:blank";

  // ✅ FIX: signed URL → direct (proxy မဖြတ်)
  if (isSignedUrl(u)) return u.toString();

  if (isTargetHost(u.hostname)) {
    return `${u.pathname}${u.search}${u.hash}`;
  }
  return `${PROXY_PATH}?url=${encodeURIComponent(u.toString())}`;
}

function rewriteOneUrl(value, baseTargetUrl, incomingUrl) {
  const absolute = safeResolveUrl(value, baseTargetUrl);
  if (!absolute) return value;

  // ✅ FIX: signed URL → そのまま返す
  if (isSignedUrl(absolute)) return absolute.toString();

  if (!isAllowedUrl(absolute)) return "about:blank";
  return proxifyUrl(absolute, incomingUrl);
}

function isTargetHost(hostname) {
  return hostname === TARGET_HOST || hostname.endsWith(`.${TARGET_HOST}`);
}

function isAllowedUrl(url) {
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
  if (isAdUrl(url)) return false;
  if (isTargetHost(url.hostname)) return true;

  // CDN whitelist → always allow
  if (CDN_WHITELIST_HOSTS.has(url.hostname)) return true;

  for (const suffix of ALLOWED_HOST_SUFFIXES) {
    if (url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)) return true;
  }
  return ALLOW_ANY_EXTERNAL_HOST;
}

function isAdUrl(url) {
  if (!url) return false;

  const hostname = (url.hostname || "").toLowerCase();

  // ✅ FIX: CDN whitelist → ad check bypass
  if (CDN_WHITELIST_HOSTS.has(hostname)) return false;

  // hostname ကိုသာ AD_KEYWORDS စစ် (path/query မစစ်)
  // → sspark.genspark.ai?u1=...ads... ကဲ့သို့ query ထဲ "ads" ပါသော CDN မ block ဖြစ်စေ
  return AD_KEYWORDS.some((kw) => hostname.includes(kw.toLowerCase()));
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isVideoPlayerScript(pathname) {
  const lower = pathname.toLowerCase();
  return (
    lower.includes("jwplayer") ||
    lower.includes("videojs") ||
    lower.includes("video.js") ||
    lower.includes("hls.js") ||
    lower.includes("hlsjs") ||
    lower.includes("plyr") ||
    lower.includes("flowplayer") ||
    lower.includes("mediaelement") ||
    lower.includes("player")
  );
}

// ============================================================
//  Headers
// ============================================================
function buildRequestHeaders(request, targetUrl) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("accept-encoding");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  headers.set("referer", `${targetUrl.origin}/`);
  headers.set("origin",  targetUrl.origin);
  if (!headers.get("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    );
  }
  return headers;
}

function buildResponseHeaders(upstreamHeaders, proxyHost, modifiedBody) {
  const headers = new Headers(upstreamHeaders);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  headers.delete("permissions-policy");
  headers.delete("cross-origin-opener-policy");
  headers.delete("cross-origin-embedder-policy");
  headers.delete("cross-origin-resource-policy");

  if (modifiedBody) {
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("etag");
  }

  rewriteSetCookieHeaders(headers);

  for (const [k, v] of corsHeaders().entries()) headers.set(k, v);
  headers.set("x-proxy-by", "cloudflare-pages-function");
  return headers;
}

function corsHeaders() {
  return new Headers({
    "access-control-allow-origin":   "*",
    "access-control-allow-methods":  "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers":  "*",
    "access-control-expose-headers": "*",
  });
}

function rewriteSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie();
    headers.delete("set-cookie");
    for (let cookie of cookies) {
      cookie = cookie.replace(/;\s*Domain=[^;]+/gi, "");
      cookie = cookie.replace(/;\s*Secure/gi,       "; Secure");
      headers.append("set-cookie", cookie);
    }
    return;
  }
  const cookie = headers.get("set-cookie");
  if (cookie) {
    headers.set("set-cookie", cookie.replace(/;\s*Domain=[^;]+/gi, ""));
  }
}

function emptyBlockedResponse() {
  return new Response("", { status: 204, headers: corsHeaders() });
}

// ============================================================
//  HTMLRewriter handlers
// ============================================================
class RemoveAdElementHandler {
  constructor(baseTargetUrl) { this.baseTargetUrl = baseTargetUrl; }

  element(element) {
    for (const attr of ["src", "href", "data-src", "data-url"]) {
      const value = element.getAttribute(attr);
      if (!value) continue;

      // pipe format → ပထမ part ကိုသာ စစ်
      const checkVal = value.includes("|") ? value.split("|")[0].trim() : value;
      const absolute = safeResolveUrl(checkVal, this.baseTargetUrl);

      if (absolute && isAdUrl(absolute)) { element.remove(); return; }

      const lower = checkVal.toLowerCase();
      if (AD_KEYWORDS.some((kw) => lower.includes(kw))) { element.remove(); return; }
    }
  }
}

class AttrRewriteHandler {
  constructor(baseTargetUrl, incomingUrl) {
    this.baseTargetUrl = baseTargetUrl;
    this.incomingUrl   = incomingUrl;
  }

  element(element) {
    for (const attr of REWRITE_ATTRS) {
      const value = element.getAttribute(attr);
      if (!value) continue;

      // ✅ FIX 5: pipe-separated "full.jpg|xs.jpg" format
      //   → ပထမ URL ကိုသာ src ထဲ ထည့် (xs URL ဖယ်)
      //   → browser က valid single URL တစ်ခုကိုသာ မြင်
      if (value.includes("|")) {
        const firstUrl = value.split("|")[0].trim();
        element.setAttribute(
          attr,
          rewriteOneUrl(firstUrl, this.baseTargetUrl, this.incomingUrl),
        );
        continue;
      }

      element.setAttribute(
        attr,
        rewriteOneUrl(value, this.baseTargetUrl, this.incomingUrl),
      );
    }

    // srcset
    const srcset = element.getAttribute("srcset");
    if (srcset) {
      element.setAttribute(
        "srcset",
        rewriteSrcset(srcset, this.baseTargetUrl, this.incomingUrl),
      );
    }

    // lazy → eager
    if (element.getAttribute("loading") === "lazy") {
      element.setAttribute("loading", "eager");
    }
  }
}

class StyleAttrRewriteHandler {
  constructor(baseTargetUrl, incomingUrl) {
    this.baseTargetUrl = baseTargetUrl;
    this.incomingUrl   = incomingUrl;
  }
  element(element) {
    const style = element.getAttribute("style");
    if (!style) return;
    element.setAttribute(
      "style",
      rewriteCssUrls(style, this.baseTargetUrl, this.incomingUrl),
    );
  }
}

class NoscriptRewriteHandler {
  constructor(baseTargetUrl, incomingUrl) {
    this.baseTargetUrl = baseTargetUrl;
    this.incomingUrl   = incomingUrl;
    this.buffer        = "";
  }
  text(chunk) {
    this.buffer += chunk.text;
    if (chunk.lastInTextNode) {
      const rewritten = rewriteTextUrls(this.buffer, this.baseTargetUrl, this.incomingUrl);
      chunk.replace(rewritten, { html: true });
      this.buffer = "";
    } else {
      chunk.remove();
    }
  }
}

// ============================================================
//  Rewriters
// ============================================================
function rewriteSrcset(srcset, baseTargetUrl, incomingUrl) {
  return srcset
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const match = trimmed.match(/^(\S+)(\s+.*)?$/);
      if (!match) return trimmed;
      const urlPart    = match[1];
      const descriptor = match[2] || "";
      return `${rewriteOneUrl(urlPart, baseTargetUrl, incomingUrl)}${descriptor}`;
    })
    .join(", ");
}

function rewriteCssUrls(css, baseTargetUrl, incomingUrl) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (full, quote, rawUrl) => {
      const value = rawUrl.trim();
      if (!value) return full;
      return `url("${rewriteOneUrl(value, baseTargetUrl, incomingUrl)}")`;
    })
    .replace(/@import\s+(['"])(.*?)\1/gi, (full, quote, rawUrl) => {
      return `@import "${rewriteOneUrl(rawUrl, baseTargetUrl, incomingUrl)}"`;
    });
}

function rewriteTextUrls(text, baseTargetUrl, incomingUrl) {
  return text.replace(
    /((?:https?:)?\/\/[^\s"'<>\\)|]+)/gi,
    (match) => {
      let raw  = match;
      let tail = "";
      while (/[.,;!?]$/.test(raw)) {
        tail = raw.slice(-1) + tail;
        raw  = raw.slice(0, -1);
      }
      try {
        const absolute = raw.startsWith("//")
          ? new URL(`https:${raw}`)
          : new URL(raw);

        // ✅ FIX: signed URL → そのまま
        if (isSignedUrl(absolute)) return match;

        if (!isAllowedUrl(absolute)) return `about:blank${tail}`;
        return `${proxifyUrl(absolute, incomingUrl)}${tail}`;
      } catch {
        return match;
      }
    },
  );
}

// ✅ FIX 4: JSON-safe rewrite
//   signed URL ပါသော JSON field ကို rewrite မလုပ်
function rewriteJsonTextSafe(text, baseTargetUrl, incomingUrl) {
  try {
    const json    = JSON.parse(text);
    const patched = walkJsonUrls(json, baseTargetUrl, incomingUrl);
    return JSON.stringify(patched);
  } catch {
    // parse မရသော JSON → plain text rewrite
    return rewriteTextUrls(text, baseTargetUrl, incomingUrl);
  }
}

function walkJsonUrls(obj, baseTargetUrl, incomingUrl) {
  if (typeof obj === "string") {
    // pipe format
    if (obj.includes("|") && (obj.startsWith("http") || obj.startsWith("/"))) {
      const parts = obj.split("|");
      return parts.map((p) => safeRewriteJsonUrl(p.trim(), baseTargetUrl, incomingUrl)).join("|");
    }
    return safeRewriteJsonUrl(obj, baseTargetUrl, incomingUrl);
  }
  if (Array.isArray(obj)) return obj.map((v) => walkJsonUrls(v, baseTargetUrl, incomingUrl));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = walkJsonUrls(obj[k], baseTargetUrl, incomingUrl);
    return out;
  }
  return obj;
}

function safeRewriteJsonUrl(str, baseTargetUrl, incomingUrl) {
  if (!str || typeof str !== "string") return str;
  const trimmed = str.trim();
  if (!trimmed.startsWith("http") && !trimmed.startsWith("//")) return str;

  try {
    const abs = new URL(trimmed);
    // ✅ signed URL → direct (rewrite しない)
    if (isSignedUrl(abs)) return abs.toString();
    if (!isAllowedUrl(abs)) return "about:blank";
    return proxifyUrl(abs, incomingUrl);
  } catch {
    return str;
  }
}

function rewriteM3U8(playlist, baseTargetUrl, incomingUrl) {
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes("URI=")) {
        return line.replace(/URI=(["'])(.*?)\1/i, (full, q, uri) => {
          return `URI=${q}${rewriteOneUrl(uri, baseTargetUrl, incomingUrl)}${q}`;
        });
      }
      if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes("URI=")) {
        return line.replace(/URI=(["'])(.*?)\1/i, (full, q, uri) => {
          return `URI=${q}${rewriteOneUrl(uri, baseTargetUrl, incomingUrl)}${q}`;
        });
      }
      if (!trimmed.startsWith("#")) {
        // ✅ FIX: segment URL signed ဆိုရင် direct
        try {
          const abs = new URL(trimmed, baseTargetUrl);
          if (isSignedUrl(abs)) return abs.toString();
        } catch {}
        return rewriteOneUrl(trimmed, baseTargetUrl, incomingUrl);
      }
      return line;
    })
    .join("\n");
}

// ============================================================
//  Ad cleanup
// ============================================================
function removeAdBlocksFromHtml(html) {
  // <script> — player scripts ကို ဆက်ထား
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => {
    const lower = block.toLowerCase();
    if (
      lower.includes("jwplayer") ||
      lower.includes("videojs") ||
      lower.includes("hls.js") ||
      lower.includes("plyr")
    ) return block;
    return AD_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase())) ? "" : block;
  });

  // <iframe>
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (block) => {
    const lower = block.toLowerCase();
    return AD_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase())) ? "" : block;
  });

  return html;
}

function removeAdCodeFromText(text) {
  const lower = text.toLowerCase();
  if (AD_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    text = text.replace(/window\.open\s*\([^)]*\)\s*;?/gi, "");
    text = text.replace(
      /document\.write\s*\([^)]*(ads|pop|iframe)[^)]*\)\s*;?/gi,
      "",
    );
  }
  return text;
}

function injectAntiAdCss(html) {
  const css = `
<style>
[id*="ad" i]:not(video):not([id*="load"]):not([id*="head"]):not([id*="read"]):not([id*="broad"]):not([id*="lead"]):not([id*="trad"]),
[class*="ad-" i]:not([class*="load"]):not([class*="head"]):not([class*="read"]),
[class*="ads" i]:not([class*="loads"]):not([class*="heads"]):not([class*="reads"]),
[class*="banner" i]:not([class*="banner-title"]),
[class*="popunder" i],
[class*="sponsor" i],
iframe[src*="ads" i],
iframe[src*="pop" i] {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
</style>
`;
  return html.includes("</head>")
    ? html.replace("</head>", `${css}</head>`)
    : css + html;
}

// ============================================================
//  Video player patch (injected into <head>)
// ============================================================
function injectVideoPlayerPatch(html, incomingUrl) {
  const proxyBase = `${incomingUrl.protocol}//${incomingUrl.host}${PROXY_PATH}`;

  const patch = `
<script>
(function () {
  "use strict";

  var PROXY_BASE   = ${JSON.stringify(proxyBase)};
  var TARGET_HOST  = ${JSON.stringify(TARGET_HOST)};

  /* ── signed URL detection (client side) ── */
  function isSignedUrl(url) {
    try {
      var u = new URL(url);
      return (
        u.searchParams.has("X-Amz-Signature") ||
        u.searchParams.has("x-amz-signature") ||
        (u.searchParams.has("X-Amz-Expires") && u.searchParams.has("X-Amz-Credential"))
      );
    } catch (e) { return false; }
  }

  /* ── URL → Proxy URL ── */
  function toProxyUrl(url) {
    if (!url || typeof url !== "string") return url;
    var t = url.trim();
    if (
      t.startsWith("blob:") || t.startsWith("data:") ||
      t.startsWith("#")     || t.startsWith("javascript:")
    ) return url;

    // same-origin path
    if (t.startsWith("/") && !t.startsWith("//")) return url;

    try {
      var u = new URL(t, location.href);
      if (u.hostname === location.hostname) return url;
      if (u.pathname === "/__proxy")         return url;

      // ✅ signed URL → direct (proxy 経由しない)
      if (isSignedUrl(u)) return u.toString();

      return PROXY_BASE + "?url=" + encodeURIComponent(u.toString());
    } catch (e) { return url; }
  }

  /* ── JSON deep-walk ── */
  function proxyJsonUrls(obj) {
    if (typeof obj === "string") {
      if (obj.includes("|") && (obj.startsWith("http") || obj.startsWith("/"))) {
        return obj.split("|").map(toProxyUrl).join("|");
      }
      return toProxyUrl(obj);
    }
    if (Array.isArray(obj)) return obj.map(proxyJsonUrls);
    if (obj && typeof obj === "object") {
      var out = {};
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
        out[k] = proxyJsonUrls(obj[k]);
      }
      return out;
    }
    return obj;
  }

  /* ── fetch() override ── */
  var _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    var reqUrl = typeof input === "string" ? input
      : (input instanceof Request ? input.url : String(input));

    // signed URL → proxy に通さない
    if (!isSignedUrl(reqUrl)) {
      reqUrl = toProxyUrl(reqUrl);
    }

    var res = await _fetch(
      typeof input === "string" ? reqUrl : new Request(reqUrl, input),
      init
    );

    var ct = res.headers.get("content-type") || "";

    /* JSON response → deep-rewrite (signed URL 除く) */
    if (ct.includes("application/json") || ct.includes("text/json")) {
      var clone = res.clone();
      try {
        var json    = await clone.json();
        var patched = proxyJsonUrls(json);
        return new Response(JSON.stringify(patched), {
          status:     res.status,
          statusText: res.statusText,
          headers:    res.headers,
        });
      } catch (e) { return res; }
    }
    return res;
  };

  /* ── XMLHttpRequest override ── */
  var _XHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var rest = Array.prototype.slice.call(arguments, 2);
    try {
      var proxied = isSignedUrl(String(url)) ? String(url) : toProxyUrl(String(url));
      this._proxyUrl = proxied;
    } catch (e) { this._proxyUrl = url; }
    return _XHROpen.apply(this, [method, this._proxyUrl].concat(rest));
  };

  /* ── DOM ready patches ── */
  document.addEventListener("DOMContentLoaded", function () {

    /* MutationObserver — 動的 video/source 要素 */
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (!node || !node.getAttribute) return;
          ["src", "data-src", "poster"].forEach(function (attr) {
            var val = node.getAttribute(attr);
            if (val && !isSignedUrl(val)) node.setAttribute(attr, toProxyUrl(val));
          });
          if (node.querySelectorAll) {
            node.querySelectorAll("[src],[data-src]").forEach(function (el) {
              ["src", "data-src"].forEach(function (attr) {
                var v = el.getAttribute(attr);
                if (v && !isSignedUrl(v)) el.setAttribute(attr, toProxyUrl(v));
              });
            });
          }
        });
      });
    }).observe(document.body, { childList: true, subtree: true });

    /* ── Plyr instance patch ── */
    function patchPlyrInstance(player) {
      if (!player || player.__proxied) return;
      player.__proxied = true;
      try {
        var proto   = Object.getPrototypeOf(player);
        var origDesc = Object.getOwnPropertyDescriptor(proto, "source");
        if (origDesc && origDesc.set) {
          var origSet = origDesc.set.bind(player);
          Object.defineProperty(player, "source", {
            get: origDesc.get ? origDesc.get.bind(player) : undefined,
            set: function (src) {
              if (src && Array.isArray(src.sources)) {
                src.sources = src.sources.map(function (s) {
                  if (s && s.src && !isSignedUrl(s.src)) s.src = toProxyUrl(s.src);
                  return s;
                });
              }
              origSet(src);
            },
          });
        }
      } catch (e) {}
    }

    /* window.Plyr constructor override */
    if (window.Plyr) {
      var OrigPlyr = window.Plyr;
      window.Plyr  = function (target, opts) {
        var instance = new OrigPlyr(target, opts);
        patchPlyrInstance(instance);
        return instance;
      };
      Object.assign(window.Plyr, OrigPlyr);
    }

    /* ── img pipe-src fix: src に | が残っていたら最初の部分だけ使う ── */
    document.querySelectorAll("img[src]").forEach(function (img) {
      var src = img.getAttribute("src");
      if (src && src.includes("|")) {
        img.setAttribute("src", src.split("|")[0].trim());
      }
    });

  });

})();
</script>
`;

  return html.includes("<head>")
    ? html.replace("<head>", "<head>" + patch)
    : patch + html;
}
