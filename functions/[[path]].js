const TARGET_HOST = "javtiful.com";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const PROXY_PATH = "/__proxy";

/*
  Video/CDN URL တွေ proxy ကနေသွားစေဖို့ true ထားထားပါတယ်။
  Production မှာ safer ဖြစ်ချင်ရင် false ထားပြီး ALLOWED_HOST_SUFFIXES ထဲ CDN domain တွေ ထည့်ပါ။
*/
const ALLOW_ANY_EXTERNAL_HOST = true;

/*
  ALLOW_ANY_EXTERNAL_HOST = false လုပ်မယ်ဆိုရင်
  video CDN domain တွေကို ဒီထဲထည့်ပါ။
  ဥပမာ:
  "cdn.example.com",
  "examplecdn.net"
*/
const ALLOWED_HOST_SUFFIXES = [
  TARGET_HOST,
  `www.${TARGET_HOST}`
];

/*
  Ads / popunder / tracker / analytics domain keyword များ
  မပျောက်သေးတဲ့ ads ရှိရင် DevTools > Network ထဲက domain/keyword ကို ဒီထဲ ထပ်ထည့်ပါ။
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
  "onclick",
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

const REWRITE_ATTRS = [
  "href",
  "src",
  "action",
  "poster",
  "data-src",
  "data-href",
  "data-url",
  "data-original",
  "data-poster"
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

  /*
    Redirect Location ကိုလည်း proxy URL ပြန်ပြောင်းပေးရန်
  */
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

  /*
    HTML rewrite
  */
  if (contentType.includes("text/html")) {
    let html = await upstreamResponse.text();

    html = removeAdBlocksFromHtml(html);
    html = rewriteTextUrls(html, targetUrl, incomingUrl);
    html = injectAntiAdCss(html);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);
    headers.set("content-type", "text/html; charset=UTF-8");

    const responseForRewrite = new Response(html, {
      status: upstreamResponse.status,
      headers
    });

    return new HTMLRewriter()
      .on("script, iframe, embed, object", new RemoveAdElementHandler(targetUrl))
      .on("a, link, img, script, iframe, source, video, audio, form, embed, object, track", new AttrRewriteHandler(targetUrl, incomingUrl))
      .on("[style]", new StyleAttrRewriteHandler(targetUrl, incomingUrl))
      .transform(responseForRewrite);
  }

  /*
    HLS playlist / m3u8 rewrite
    Video segments တွေ မူရင်း URL မသွားဘဲ proxy ကနေသွားစေဖို့ အရေးကြီးပါတယ်။
  */
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

  /*
    CSS rewrite
  */
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

  /*
    JS / JSON / XML / text ထဲက URL များ rewrite
  */
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
    text = removeAdCodeFromText(text);
    text = rewriteTextUrls(text, targetUrl, incomingUrl);

    const headers = buildResponseHeaders(upstreamResponse.headers, incomingUrl.host, true);

    return new Response(text, {
      status: upstreamResponse.status,
      headers
    });
  }

  /*
    Images / video segments / mp4 / ts / webm စသည်တို့
    binary response ဖြစ်လို့ body မပြင်ဘဲ headers သာ clean လုပ်ပြီး ပြန်ပေးသည်။
  */
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

  /*
    Main target domain ဖြစ်ရင် pretty path အနေနဲ့ same-origin သုံး
    ဥပမာ https://javtiful.com/video/abc => /video/abc
  */
  if (isTargetHost(u.hostname)) {
    return `${u.pathname}${u.search}${u.hash}`;
  }

  /*
    CDN / external media / third-party resource များ
    proxy endpoint မှတဆင့် သွားစေ
  */
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

/* =========================
   Headers
========================= */

function buildRequestHeaders(request, targetUrl) {
  const headers = new Headers(request.headers);

  /*
    Upstream fetch အတွက် မလိုအပ်/ပြဿနာဖြစ်နိုင်သော headers များဖယ်
  */
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

  /*
    Proxy page ထဲ rewrite လုပ်ထားတာတွေ browser က block မလုပ်အောင်
  */
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  headers.delete("permissions-policy");
  headers.delete("cross-origin-opener-policy");
  headers.delete("cross-origin-embedder-policy");
  headers.delete("cross-origin-resource-policy");

  /*
    Body modify လုပ်ထားရင် length/encoding မမှန်တော့လို့ ဖယ်
  */
  if (modifiedBody) {
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("etag");
  }

  /*
    Cookie domain mismatch မဖြစ်အောင် Domain attribute ကို ဖယ်ရန်
    Browser က proxy domain အတွက် cookie သိမ်းနိုင်စေသည်။
  */
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
  /*
    Cloudflare runtime မှာ getSetCookie ရရင် multiple Set-Cookie ကို handle လုပ်နိုင်သည်။
  */
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
  return css.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (full, quote, rawUrl) => {
      const value = rawUrl.trim();
      if (!value) return full;

      const rewritten = rewriteOneUrl(value, baseTargetUrl, incomingUrl);
      return `url("${rewritten}")`;
    }
  ).replace(
    /@import\s+(['"])(.*?)\1/gi,
    (full, quote, rawUrl) => {
      const rewritten = rewriteOneUrl(rawUrl, baseTargetUrl, incomingUrl);
      return `@import "${rewritten}"`;
    }
  );
}

function rewriteTextUrls(text, baseTargetUrl, incomingUrl) {
  /*
    JS / HTML / JSON ထဲမှာပါတဲ့ absolute URL များ rewrite
    ဥပမာ https://cdn.xxx/video.m3u8 => /__proxy?url=...
  */
  return text.replace(
    /((?:https?:)?\/\/[^\s"'<>\\)]+)/gi,
    (match) => {
      let raw = match;

      /*
        URL နောက်က punctuation ပါလာရင် ခွဲထုတ်
      */
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

    /*
      #EXT-X-KEY:METHOD=AES-128,URI="key.key"
      Key URI ကိုလည်း proxy rewrite
    */
    if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes("URI=")) {
      return line.replace(/URI=(["'])(.*?)\1/i, (full, quote, uri) => {
        const rewrittenUri = rewriteOneUrl(uri, baseTargetUrl, incomingUrl);
        return `URI=${quote}${rewrittenUri}${quote}`;
      });
    }

    /*
      Comment / metadata line မဟုတ်ရင် segment URL ဖြစ်နိုင်
    */
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
  /*
    Ads keyword ပါတဲ့ script block များဖယ်
  */
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => {
    const lower = block.toLowerCase();
    return AD_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))
      ? ""
      : block;
  });

  /*
    Ads keyword ပါတဲ့ iframe များဖယ်
  */
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
    /*
      JS file တစ်ခုလုံး ad network ဖြစ်နိုင်ရင် empty ပြန်
      အလွန် aggressive မဖြစ်စေရန် full remove မလုပ်ဘဲ common pop calls များဖယ်
    */
    text = text.replace(/window\.open\s*\([^)]*\)\s*;?/gi, "");
    text = text.replace(/document\.write\s*\([^)]*(ads|pop|iframe)[^)]*\)\s*;?/gi, "");
  }

  return text;
}

function injectAntiAdCss(html) {
  const css = `
<style>
[id*="ad" i],
[class*="ad-" i],
[class*="ads" i],
[class*="banner" i],
[class*="popup" i],
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
