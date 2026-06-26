// ============================================================
//  Cloudflare Pages Function — _worker.js  (functions/_worker.js)
//  javtiful.com proxy  ·  FIXED: video playback via stream-relay
//
//  အဓိက ပြင်ဆင်ချက်:
//   ✅ signed URL / media file → direct redirect မလုပ်တော့ဘဲ
//      Worker ကိုယ်တိုင်က Range-aware stream relay လုပ်ပေး
//      (R2/S3 signed URL က browser direct request မှာ 403/CORS fail ဖြစ်လို့)
//   ✅ upstream fetch မှာ referer/origin header မှန်ကန်စွာ ထည့်ပေး
//   ✅ Range header forward + Accept-Ranges → seek အဆင်ပြေ
// ============================================================

const TARGET_HOST   = "javtiful.com";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const PROXY_PATH    = "/__proxy";
const MEDIA_PATH    = "/__media";   // ✅ NEW: media stream-relay endpoint

const ALLOW_ANY_EXTERNAL_HOST = true;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126 Safari/537.36";

const CDN_WHITELIST_HOSTS = new Set([
  "sspark.genspark.ai",
  "cdn.plyr.io",
  "vjs.zencdn.net",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "www.googletagmanager.com",
  "www.google-analytics.com",
]);

const ALLOWED_HOST_SUFFIXES = [
  TARGET_HOST,
  `www.${TARGET_HOST}`,
];

const AD_KEYWORDS = [
  "adserver", "adsterra", "juicyads", "exoclick", "popads", "popcash",
  "popunder", "doubleclick", "googlesyndication", "histats",
  "trafficjunky", "trafficfactory", "propellerads", "hilltopads",
  "a.exdynsrv.com", "exdynsrv", "revcontent", "mgid", "taboola", "outbrain",
];

const REWRITE_ATTRS = [
  "href", "src", "action", "poster",
  "data-src", "data-href", "data-url",
  "data-original", "data-poster", "data-lazy",
  "data-image", "data-thumb",
];

// ============================================================
//  signed URL / media detection
// ============================================================
function isSignedUrl(url) {
  const u = url instanceof URL ? url : null;
  if (!u) return false;
  return (
    u.searchParams.has("X-Amz-Signature") ||
    u.searchParams.has("x-amz-signature") ||
    u.searchParams.has("Signature") ||
    (u.searchParams.has("X-Amz-Expires") &&
     u.searchParams.has("X-Amz-Credential"))
  );
}

// ✅ media file ဟုတ်/မဟုတ် (video / hls / ts / R2 / Stream host)
function isMediaUrl(url) {
  const u = url instanceof URL ? url : null;
  if (!u) return false;

  const host = (u.hostname || "").toLowerCase();
  const path = (u.pathname || "").toLowerCase();

  if (
    /r2\.cloudflarestorage\.com$/i.test(host) ||
    /\.r2\.dev$/i.test(host) ||
    /cloudflarestream\.com$/i.test(host) ||
    /qyshare\.com$/i.test(host)
  ) {
    return true;
  }

  if (/\.(?:mp4|m3u8|ts|webm|mkv|mov|m4s|mp3|m4a|aac)(?:$|\?)/i.test(path)) {
    return true;
  }

  return false;
}

// ✅ signed URL / cross-origin media → Worker proxy-stream သုံးသင့်/မသင့်
function shouldStreamRelay(url) {
  return isSignedUrl(url) || isMediaUrl(url);
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

  // ✅ NEW: media stream-relay endpoint
  if (incomingUrl.pathname === MEDIA_PATH) {
    return handleMediaRelay(request, incomingUrl);
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

  // ✅ FIX (အဓိက): signed URL / media → redirect အစား stream-relay
  //   browser direct request မှာ R2/S3 signed URL က 403/CORS fail ဖြစ်လို့
  if (shouldStreamRelay(targetUrl)) {
    return relayMedia(request, targetUrl);
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

  // ── Redirect ─────────────────────────────────────────────
  if (isRedirect(upstreamResponse.status)) {
    const location = upstreamResponse.headers.get("location");
    const headers  = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, false);

    if (location) {
      const abs = safeResolveUrl(location, targetUrl);
      if (abs) {
        // ✅ FIX: redirect target က signed/media → media-relay endpoint
        if (shouldStreamRelay(abs)) {
          headers.set("location", mediaProxyUrl(abs, incomingUrl));
        } else if (isAllowedUrl(abs)) {
          headers.set("location", proxifyUrl(abs, incomingUrl));
        }
      }
    }
    return new Response(null, { status: upstreamResponse.status, headers });
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const pathname    = targetUrl.pathname.toLowerCase();

  // ── HTML ─────────────────────────────────────────────────
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

  // ── HLS m3u8 ─────────────────────────────────────────────
  if (
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("application/x-mpegurl") ||
    pathname.endsWith(".m3u8")
  ) {
    let playlist = await upstreamResponse.text();
    playlist = rewriteM3U8(playlist, targetUrl, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "application/vnd.apple.mpegurl; charset=UTF-8");
    headers.set("accept-ranges", "bytes");
    return new Response(playlist, { status: upstreamResponse.status, headers });
  }

  // ── CSS ──────────────────────────────────────────────────
  if (contentType.includes("text/css") || pathname.endsWith(".css")) {
    let css = await upstreamResponse.text();
    css = rewriteCssUrls(css, targetUrl, incomingUrl);
    css = rewriteTextUrls(css, targetUrl, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "text/css; charset=UTF-8");
    return new Response(css, { status: upstreamResponse.status, headers });
  }

  // ── JS / JSON / text ─────────────────────────────────────
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

  // ── Binary ───────────────────────────────────────────────
  const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, false);
  return new Response(upstreamResponse.body, {
    status:     upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

// ============================================================
//  ✅ NEW: Media stream-relay (video ကြည့်လို့ရအောင် အဓိက logic)
//  /__media?url=<encoded media url>
//  Range forward + referer header + chunk pass-through
// ============================================================
async function handleMediaRelay(request, incomingUrl) {
  const raw = incomingUrl.searchParams.get("url");
  if (!raw) return new Response("Missing media url", { status: 400 });

  let mediaUrl;
  try {
    mediaUrl = new URL(decodeURIComponent(raw));
  } catch {
    return new Response("Bad media url", { status: 400 });
  }
  if (mediaUrl.protocol !== "http:" && mediaUrl.protocol !== "https:") {
    return new Response("Invalid protocol", { status: 400 });
  }
  if (isAdUrl(mediaUrl)) return emptyBlockedResponse();

  return relayMedia(request, mediaUrl);
}

// upstream media ကို Range-aware stream relay လုပ်တဲ့ core function
async function relayMedia(request, mediaUrl) {
  const fwd = new Headers();
  fwd.set("User-Agent", UA);
  fwd.set("Accept", "*/*");

  // ✅ referer/origin — signed URL/media host က referer-bound ဖြစ်နိုင်လို့
  //   signed URL မှာ host က R2 ဆို target site ကို referer ပေး
  fwd.set("Referer", `${TARGET_ORIGIN}/`);
  fwd.set("Origin", TARGET_ORIGIN);

  // ✅ seek — client Range ကို တိုက်ရိုက် forward
  const range = request.headers.get("Range");
  if (range) fwd.set("Range", range);

  let upstream;
  try {
    upstream = await fetch(mediaUrl.toString(), {
      method:   request.method === "HEAD" ? "HEAD" : "GET",
      headers:  fwd,
      redirect: "follow",
    });
  } catch (err) {
    return new Response(`Media fetch error: ${err.message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  const respHeaders = new Headers();

  // upstream ၏ range/size/cache header တွေ pass
  for (const h of [
    "content-range", "content-length", "content-type",
    "last-modified", "etag", "accept-ranges",
  ]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (!respHeaders.has("accept-ranges")) {
    respHeaders.set("accept-ranges", "bytes");
  }

  // CORS — browser direct fail ဖြစ်တာ ဒီကနေ ဖြေရှင်း
  for (const [k, v] of corsHeaders().entries()) respHeaders.set(k, v);
  respHeaders.set("x-proxy-by", "cloudflare-pages-function-media");

  // HEAD → body မပါ
  if (request.method === "HEAD") {
    return new Response(null, {
      status:  upstream.status,
      headers: respHeaders,
    });
  }

  // ✅ chunk-by-chunk pass-through — buffer မစုပ်၊ TTFB မြန်
  return new Response(upstream.body, {
    status:  upstream.status,   // 200 (full) / 206 (partial)
    headers: respHeaders,
  });
}

// media-relay endpoint URL ဆောက်
function mediaProxyUrl(targetUrl, incomingUrl) {
  const u = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  return `${MEDIA_PATH}?url=${encodeURIComponent(u.toString())}`;
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

  // ✅ FIX: signed/media → redirect/direct မလုပ်ဘဲ media-relay endpoint
  if (shouldStreamRelay(u)) return mediaProxyUrl(u, incomingUrl);

  if (isTargetHost(u.hostname)) {
    return `${u.pathname}${u.search}${u.hash}`;
  }
  return `${PROXY_PATH}?url=${encodeURIComponent(u.toString())}`;
}

function rewriteOneUrl(value, baseTargetUrl, incomingUrl) {
  const absolute = safeResolveUrl(value, baseTargetUrl);
  if (!absolute) return value;

  // ✅ FIX: signed/media → media-relay endpoint
  if (shouldStreamRelay(absolute)) return mediaProxyUrl(absolute, incomingUrl);

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
  if (CDN_WHITELIST_HOSTS.has(url.hostname)) return true;

  for (const suffix of ALLOWED_HOST_SUFFIXES) {
    if (url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)) return true;
  }
  return ALLOW_ANY_EXTERNAL_HOST;
}

function isAdUrl(url) {
  if (!url) return false;
  const hostname = (url.hostname || "").toLowerCase();
  if (CDN_WHITELIST_HOSTS.has(hostname)) return false;
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
    headers.set("user-agent", UA);
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
    "access-control-allow-methods":  "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
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

    const srcset = element.getAttribute("srcset");
    if (srcset) {
      element.setAttribute(
        "srcset",
        rewriteSrcset(srcset, this.baseTargetUrl, this.incomingUrl),
      );
    }

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

        // ✅ FIX: signed/media → media-relay endpoint
        if (shouldStreamRelay(absolute)) {
          return `${mediaProxyUrl(absolute, incomingUrl)}${tail}`;
        }

        if (!isAllowedUrl(absolute)) return `about:blank${tail}`;
        return `${proxifyUrl(absolute, incomingUrl)}${tail}`;
      } catch {
        return match;
      }
    },
  );
}

function rewriteJsonTextSafe(text, baseTargetUrl, incomingUrl) {
  try {
    const json    = JSON.parse(text);
    const patched = walkJsonUrls(json, baseTargetUrl, incomingUrl);
    return JSON.stringify(patched);
  } catch {
    return rewriteTextUrls(text, baseTargetUrl, incomingUrl);
  }
}

function walkJsonUrls(obj, baseTargetUrl, incomingUrl) {
  if (typeof obj === "string") {
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
    const abs = trimmed.startsWith("//") ? new URL(`https:${trimmed}`) : new URL(trimmed);
    // ✅ FIX: signed/media → media-relay endpoint
    if (shouldStreamRelay(abs)) return mediaProxyUrl(abs, incomingUrl);
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
        // ✅ FIX: segment/playlist URL → media-relay endpoint
        //   (signed ဖြစ်စေ မဖြစ်စေ Range forward လိုလို့ relay သုံး)
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
  const mediaBase = `${incomingUrl.protocol}//${incomingUrl.host}${MEDIA_PATH}`;

  const patch = `
<script>
(function () {
  "use strict";

  var PROXY_BASE  = ${JSON.stringify(proxyBase)};
  var MEDIA_BASE  = ${JSON.stringify(mediaBase)};
  var TARGET_HOST = ${JSON.stringify(TARGET_HOST)};

  /* ── signed URL detection ── */
  function isSignedUrl(url) {
    try {
      var u = new URL(url, location.href);
      return (
        u.searchParams.has("X-Amz-Signature") ||
        u.searchParams.has("x-amz-signature") ||
        (u.searchParams.has("X-Amz-Expires") && u.searchParams.has("X-Amz-Credential"))
      );
    } catch (e) { return false; }
  }

  /* ── media URL detection ── */
  function isMediaUrl(url) {
    try {
      var u = new URL(url, location.href);
      var host = u.hostname.toLowerCase();
      var path = u.pathname.toLowerCase();
      if (
        /r2\\.cloudflarestorage\\.com$/.test(host) ||
        /\\.r2\\.dev$/.test(host) ||
        /cloudflarestream\\.com$/.test(host) ||
        /qyshare\\.com$/.test(host)
      ) return true;
      if (/\\.(?:mp4|m3u8|ts|webm|mkv|mov|m4s|mp3|m4a|aac)(?:$|\\?)/.test(path)) return true;
      return false;
    } catch (e) { return false; }
  }

  function shouldRelay(url) {
    return isSignedUrl(url) || isMediaUrl(url);
  }

  /* ── media-relay endpoint URL ── */
  function toMediaUrl(url) {
    try {
      var u = new URL(url, location.href);
      return MEDIA_BASE + "?url=" + encodeURIComponent(u.toString());
    } catch (e) { return url; }
  }

  /* ── URL → Proxy URL ── */
  function toProxyUrl(url) {
    if (!url || typeof url !== "string") return url;
    var t = url.trim();
    if (
      t.startsWith("blob:") || t.startsWith("data:") ||
      t.startsWith("#")     || t.startsWith("javascript:")
    ) return url;

    // already proxied
    if (t.indexOf(MEDIA_BASE) === 0 || t.indexOf("/__media") === 0) return url;
    if (t.indexOf(PROXY_BASE) === 0 || t.indexOf("/__proxy") === 0) return url;

    try {
      var u = new URL(t, location.href);

      // ✅ signed/media → media-relay endpoint (browser direct fail ဖြစ်လို့)
      if (shouldRelay(u.toString())) return toMediaUrl(u.toString());

      // same-origin path
      if (t.startsWith("/") && !t.startsWith("//")) return url;
      if (u.hostname === location.hostname) return url;

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

    var newUrl = toProxyUrl(reqUrl);

    var res = await _fetch(
      typeof input === "string" ? newUrl : new Request(newUrl, input),
      init
    );

    var ct = res.headers.get("content-type") || "";

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
      this._proxyUrl = toProxyUrl(String(url));
    } catch (e) { this._proxyUrl = url; }
    return _XHROpen.apply(this, [method, this._proxyUrl].concat(rest));
  };

  /* ── DOM ready patches ── */
  document.addEventListener("DOMContentLoaded", function () {

    function patchNodeAttrs(node) {
      if (!node || !node.getAttribute) return;
      ["src", "data-src", "poster"].forEach(function (attr) {
        var val = node.getAttribute(attr);
        if (val) {
          var nu = toProxyUrl(val);
          if (nu !== val) node.setAttribute(attr, nu);
        }
      });
    }

    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          patchNodeAttrs(node);
          if (node.querySelectorAll) {
            node.querySelectorAll("[src],[data-src],source,video").forEach(patchNodeAttrs);
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
                  if (s && s.src) s.src = toProxyUrl(s.src);
                  return s;
                });
              }
              origSet(src);
            },
          });
        }
      } catch (e) {}
    }

    if (window.Plyr) {
      var OrigPlyr = window.Plyr;
      window.Plyr  = function (target, opts) {
        var instance = new OrigPlyr(target, opts);
        patchPlyrInstance(instance);
        return instance;
      };
      Object.assign(window.Plyr, OrigPlyr);
    }

    /* ── existing video/source elements patch ── */
    document.querySelectorAll("video, source").forEach(patchNodeAttrs);

    /* ── img pipe-src fix ── */
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
