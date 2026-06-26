const TARGET_HOST = "javtiful.com";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const PROXY_PATH = "/__proxy";

const ALLOW_ANY_EXTERNAL_HOST = true;

const ALLOWED_HOST_SUFFIXES = [
  TARGET_HOST,
  `www.${TARGET_HOST}`
];

/*
  ⚠️ "onclick" ကို ဖယ်ထုတ်လိုက်ပါ — video player click event တွေ block မဖြစ်အောင်
  ⚠️ "popup" ကို ဖယ်ထုတ်လိုက်ပါ — video player modal/lightbox တွေ hide မဖြစ်အောင်
*/
const AD_KEYWORDS = [
  "ads",
  "adserver",
  "adsterra",
  "juicyads",
  "exoclick",
  "popads",
  "popcash",
  "popunder",
  "doubleclick",
  "googlesyndication",
  "google-analytics",
  "googletagmanager",
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
  "outbrain"
];

/*
  data-lazy, data-srcset တွေပါ ထည့်ထားပါတယ် — lazy-load image တွေ ပြပါစေ
*/
const REWRITE_ATTRS = [
  "href",
  "src",
  "action",
  "poster",
  "data-src",
  "data-href",
  "data-url",
  "data-original",
  "data-poster",
  "data-lazy",
  "data-srcset",
  "data-image",
  "data-thumb"
];

export async function onRequest(context) {
  const request = context.request;
  const incomingUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  let targetUrl;

  try {
    targetUrl = getTargetUrl(incomingUrl);
  } catch (err) {
    return new Response("Bad proxy URL", { status: 400 });
  }

  if (!isAllowedUrl(targetUrl)) {
    return new Response("Blocked by proxy filter", { status: 403 });
  }

  if (isAdUrl(targetUrl)) {
    return emptyBlockedResponse();
  }

  const upstreamHeaders = buildRequestHeaders(request, targetUrl);

  const fetchInit = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "manual"
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
      headers: corsHeaders()
    });
  }

  if (isRedirect(upstreamResponse.status)) {
    const location = upstreamResponse.headers.get("location");
    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, false);

    if (location) {
      const absoluteLocation = safeResolveUrl(location, targetUrl);
      if (absoluteLocation && isAllowedUrl(absoluteLocation)) {
        headers.set("location", proxifyUrl(absoluteLocation, incomingUrl));
      }
    }

    return new Response(null, {
      status: upstreamResponse.status,
      headers
    });
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const pathname = targetUrl.pathname.toLowerCase();

  // ── HTML ──────────────────────────────────────────────────────────────────
  if (contentType.includes("text/html")) {
    let html = await upstreamResponse.text();

    html = removeAdBlocksFromHtml(html);
    html = rewriteTextUrls(html, targetUrl, incomingUrl);
    html = injectAntiAdCss(html);
    /*
      Video player ကို proxy ကနေ boot လုပ်ဖို့ helper script inject
      — jwplayer / videojs / hls.js source rewrite support
    */
    html = injectVideoPlayerPatch(html, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "text/html; charset=UTF-8");

    const responseForRewrite = new Response(html, {
      status: upstreamResponse.status,
      headers
    });

    return new HTMLRewriter()
      .on("script, iframe, embed, object", new RemoveAdElementHandler(targetUrl))
      .on(
        "a, link, img, script, iframe, source, video, audio, form, embed, object, track",
        new AttrRewriteHandler(targetUrl, incomingUrl)
      )
      .on("[style]", new StyleAttrRewriteHandler(targetUrl, incomingUrl))
      /*
        ✅ FIX: noscript ထဲမှာ ပုံ URL တွေ ပါတတ်တာကြောင့် rewrite လုပ်ပေး
      */
      .on("noscript", new NoscriptRewriteHandler(targetUrl, incomingUrl))
      .transform(responseForRewrite);
  }

  // ── HLS m3u8 ──────────────────────────────────────────────────────────────
  if (
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("application/x-mpegurl") ||
    pathname.endsWith(".m3u8")
  ) {
    let playlist = await upstreamResponse.text();
    playlist = rewriteM3U8(playlist, targetUrl, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "application/vnd.apple.mpegurl; charset=UTF-8");

    return new Response(playlist, {
      status: upstreamResponse.status,
      headers
    });
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  if (contentType.includes("text/css") || pathname.endsWith(".css")) {
    let css = await upstreamResponse.text();
    css = rewriteCssUrls(css, targetUrl, incomingUrl);
    css = rewriteTextUrls(css, targetUrl, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "text/css; charset=UTF-8");

    return new Response(css, {
      status: upstreamResponse.status,
      headers
    });
  }

  // ── JS / JSON / XML / text ────────────────────────────────────────────────
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
    /*
      ✅ FIX: JS file ကို ad keyword check မလုပ်ခင်
      video player script မဟုတ်ကြောင်း သေချာစစ်ပြီးမှ ad remove လုပ်
    */
    if (!isVideoPlayerScript(targetUrl.pathname)) {
      text = removeAdCodeFromText(text);
    }
    text = rewriteTextUrls(text, targetUrl, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);

    return new Response(text, {
      status: upstreamResponse.status,
      headers
    });
  }

  // ── Binary (images / video segments / mp4 / ts / webm) ───────────────────
  const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, false);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers
  });
}

/* =========================
   URL / Proxy helpers
========================= */

function getTargetUrl(incomingUrl) {
  if (incomingUrl.pathname === PROXY_PATH) {
    const raw = incomingUrl.searchParams.get("url");
    if (!raw) throw new Error("Missing url parameter");

    const decoded = decodeURIComponent(raw);
    const target = new URL(decoded);

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
  ) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
}

function proxifyUrl(targetUrl, incomingUrl) {
  const u = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);

  if (isAdUrl(u)) {
    return "about:blank";
  }

  if (isTargetHost(u.hostname)) {
    return `${u.pathname}${u.search}${u.hash}`;
  }

  return `${PROXY_PATH}?url=${encodeURIComponent(u.toString())}`;
}

function rewriteOneUrl(value, baseTargetUrl, incomingUrl) {
  const absolute = safeResolveUrl(value, baseTargetUrl);
  if (!absolute) return value;

  if (!isAllowedUrl(absolute)) return "about:blank";
  return proxifyUrl(absolute, incomingUrl);
}

function isTargetHost(hostname) {
  return hostname === TARGET_HOST || hostname.endsWith(`.${TARGET_HOST}`);
}

function isAllowedUrl(url) {
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return false;
  }

  if (isAdUrl(url)) {
    return false;
  }

  if (isTargetHost(url.hostname)) {
    return true;
  }

  for (const suffix of ALLOWED_HOST_SUFFIXES) {
    if (url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)) {
      return true;
    }
  }

  return ALLOW_ANY_EXTERNAL_HOST;
}

function isAdUrl(url) {
  if (!url) return false;

  const value = `${url.hostname}${url.pathname}${url.search}`.toLowerCase();

  return AD_KEYWORDS.some((keyword) => value.includes(keyword.toLowerCase()));
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

/*
  ✅ FIX: Video player library script တွေ မမှားဘဲ detect လုပ်ဖို့
  jwplayer / videojs / hls.js / plyr / flowplayer path များ
*/
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

/* =========================
   Headers
========================= */

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
  headers.set("origin", targetUrl.origin);

  if (!headers.get("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
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

  const cors = corsHeaders();
  for (const [k, v] of cors.entries()) {
    headers.set(k, v);
  }

  headers.set("x-proxy-by", "cloudflare-pages-function");

  return headers;
}

function corsHeaders() {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*"
  });
}

function rewriteSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie();
    headers.delete("set-cookie");

    for (let cookie of cookies) {
      cookie = cookie.replace(/;\s*Domain=[^;]+/gi, "");
      cookie = cookie.replace(/;\s*Secure/gi, "; Secure");
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
  return new Response("", {
    status: 204,
    headers: corsHeaders()
  });
}

/* =========================
   HTMLRewriter handlers
========================= */

class RemoveAdElementHandler {
  constructor(baseTargetUrl) {
    this.baseTargetUrl = baseTargetUrl;
  }

  element(element) {
    const attrs = ["src", "href", "data-src", "data-url"];

    for (const attr of attrs) {
      const value = element.getAttribute(attr);
      if (!value) continue;

      const absolute = safeResolveUrl(value, this.baseTargetUrl);
      if (absolute && isAdUrl(absolute)) {
        element.remove();
        return;
      }

      const lower = value.toLowerCase();
      if (AD_KEYWORDS.some((keyword) => lower.includes(keyword))) {
        element.remove();
        return;
      }
    }
  }
}

class AttrRewriteHandler {
  constructor(baseTargetUrl, incomingUrl) {
    this.baseTargetUrl = baseTargetUrl;
    this.incomingUrl = incomingUrl;
  }

  element(element) {
    for (const attr of REWRITE_ATTRS) {
      const value = element.getAttribute(attr);
      if (!value) continue;

      element.setAttribute(
        attr,
        rewriteOneUrl(value, this.baseTargetUrl, this.incomingUrl)
      );
    }

    const srcset = element.getAttribute("srcset");
    if (srcset) {
      element.setAttribute(
        "srcset",
        rewriteSrcset(srcset, this.baseTargetUrl, this.incomingUrl)
      );
    }

    /*
      ✅ FIX: loading="lazy" attribute ရှိတဲ့ img တွေ
      browser က မဖတ်ခင် proxy URL ပြောင်းပေးထားပြီးသား ဖြစ်စေ
    */
    const loading = element.getAttribute("loading");
    if (loading === "lazy") {
      element.setAttribute("loading", "eager");
    }
  }
}

class StyleAttrRewriteHandler {
  constructor(baseTargetUrl, incomingUrl) {
    this.baseTargetUrl = baseTargetUrl;
    this.incomingUrl = incomingUrl;
  }

  element(element) {
    const style = element.getAttribute("style");
    if (!style) return;

    element.setAttribute(
      "style",
      rewriteCssUrls(style, this.baseTargetUrl, this.incomingUrl)
    );
  }
}

/*
  ✅ FIX: noscript ထဲမှာ ပုံ URL တွေ ပါတတ်
  HTMLRewriter ဖြင့် inner HTML rewrite မဆောင်နိုင်လို့
  text content ကို ဖတ်ပြီး replace လုပ်ပေးသည်
*/
class NoscriptRewriteHandler {
  constructor(baseTargetUrl, incomingUrl) {
    this.baseTargetUrl = baseTargetUrl;
    this.incomingUrl = incomingUrl;
    this.buffer = "";
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

/* =========================
   Rewriters
========================= */

function rewriteSrcset(srcset, baseTargetUrl, incomingUrl) {
  return srcset
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;

      const match = trimmed.match(/^(\S+)(\s+.*)?$/);
      if (!match) return trimmed;

      const urlPart = match[1];
      const descriptor = match[2] || "";

      return `${rewriteOneUrl(urlPart, baseTargetUrl, incomingUrl)}${descriptor}`;
    })
    .join(", ");
}

function rewriteCssUrls(css, baseTargetUrl, incomingUrl) {
  return css
    .replace(
      /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
      (full, quote, rawUrl) => {
        const value = rawUrl.trim();
        if (!value) return full;

        const rewritten = rewriteOneUrl(value, baseTargetUrl, incomingUrl);
        return `url("${rewritten}")`;
      }
    )
    .replace(
      /@import\s+(['"])(.*?)\1/gi,
      (full, quote, rawUrl) => {
        const rewritten = rewriteOneUrl(rawUrl, baseTargetUrl, incomingUrl);
        return `@import "${rewritten}"`;
      }
    );
}

function rewriteTextUrls(text, baseTargetUrl, incomingUrl) {
  return text.replace(
    /((?:https?:)?\/\/[^\s"'<>\\)]+)/gi,
    (match) => {
      let raw = match;

      let tail = "";
      while (/[.,;!?]$/.test(raw)) {
        tail = raw.slice(-1) + tail;
        raw = raw.slice(0, -1);
      }

      try {
        const absolute = raw.startsWith("//")
          ? new URL(`https:${raw}`)
          : new URL(raw);

        if (!isAllowedUrl(absolute)) {
          return `about:blank${tail}`;
        }

        return `${proxifyUrl(absolute, incomingUrl)}${tail}`;
      } catch {
        return match;
      }
    }
  );
}

function rewriteM3U8(playlist, baseTargetUrl, incomingUrl) {
  const lines = playlist.split(/\r?\n/);

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();

    if (!trimmed) return line;

    if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes("URI=")) {
      return line.replace(/URI=(["'])(.*?)\1/i, (full, quote, uri) => {
        const rewrittenUri = rewriteOneUrl(uri, baseTargetUrl, incomingUrl);
        return `URI=${quote}${rewrittenUri}${quote}`;
      });
    }

    /*
      ✅ FIX: #EXT-X-MEDIA / #EXT-X-STREAM-INF ထဲမှာ URI= ပါတာကို rewrite
      Multi-bitrate HLS stream တွေ proxy ကနေ pass ဖြစ်စေ
    */
    if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes("URI=")) {
      return line.replace(/URI=(["'])(.*?)\1/i, (full, quote, uri) => {
        const rewrittenUri = rewriteOneUrl(uri, baseTargetUrl, incomingUrl);
        return `URI=${quote}${rewrittenUri}${quote}`;
      });
    }

    if (!trimmed.startsWith("#")) {
      return rewriteOneUrl(trimmed, baseTargetUrl, incomingUrl);
    }

    return line;
  });

  return rewritten.join("\n");
}

/* =========================
   Ad cleanup
========================= */

function removeAdBlocksFromHtml(html) {
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => {
    const lower = block.toLowerCase();
    /*
      ✅ FIX: video player related script တွေ မဖျက်မိအောင်
      src attribute ရှိတဲ့ external script ကိုသာ check
    */
    if (
      lower.includes("jwplayer") ||
      lower.includes("videojs") ||
      lower.includes("hls.js") ||
      lower.includes("plyr")
    ) {
      return block;
    }
    return AD_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))
      ? ""
      : block;
  });

  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (block) => {
    const lower = block.toLowerCase();
    return AD_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))
      ? ""
      : block;
  });

  return html;
}

function removeAdCodeFromText(text) {
  const lower = text.toLowerCase();

  if (AD_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))) {
    text = text.replace(/window\.open\s*\([^)]*\)\s*;?/gi, "");
    text = text.replace(
      /document\.write\s*\([^)]*(ads|pop|iframe)[^)]*\)\s*;?/gi,
      ""
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

  if (html.includes("</head>")) {
    return html.replace("</head>", `${css}</head>`);
  }

  return css + html;
}

/*
  ✅ FIX: Video player ကို proxy-aware ဖြစ်စေဖို့ runtime patch inject
  jwplayer / videojs setup call ထဲမှာ file/src URL တွေကို proxy URL ပြောင်းပေး
*/
function injectVideoPlayerPatch(html, incomingUrl) {
  const proxyBase = `${incomingUrl.protocol}//${incomingUrl.host}${PROXY_PATH}`;

  const patch = `
<script>
(function() {
  const PROXY_BASE = ${JSON.stringify(proxyBase)};

  function toProxyUrl(url) {
    if (!url || typeof url !== "string") return url;
    if (url.startsWith("/") && !url.startsWith("//")) return url;
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    try {
      const u = new URL(url, location.href);
      if (u.hostname === location.hostname) return url;
      return PROXY_BASE + "?url=" + encodeURIComponent(u.toString());
    } catch(e) {
      return url;
    }
  }

  /* jwplayer patch */
  const _jwplayer = window.jwplayer;
  if (typeof _jwplayer !== "undefined") {
    const origSetup = _jwplayer.prototype && _jwplayer.prototype.setup;
    if (origSetup) {
      _jwplayer.prototype.setup = function(config) {
        if (config && config.file) config.file = toProxyUrl(config.file);
        if (config && Array.isArray(config.sources)) {
          config.sources = config.sources.map(function(s) {
            if (s && s.file) s.file = toProxyUrl(s.file);
            return s;
          });
        }
        return origSetup.call(this, config);
      };
    }
  }

  /* videojs / hls.js src patch via MutationObserver */
  const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeName === "SOURCE" || node.nodeName === "VIDEO") {
          ["src", "data-src"].forEach(function(attr) {
            const val = node.getAttribute && node.getAttribute(attr);
            if (val) node.setAttribute(attr, toProxyUrl(val));
          });
        }
      });
    });
  });

  document.addEventListener("DOMContentLoaded", function() {
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
</script>
`;

  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${patch}`);
  }

  return patch + html;
}
