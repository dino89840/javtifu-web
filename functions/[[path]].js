const TARGET_DOMAIN = "javtiful.com";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  
  // Target URL သို့ ပြောင်းလဲရန် ဆောက်လုပ်ခြင်း
  const targetUrl = new URL(url.pathname + url.search, `https://${TARGET_DOMAIN}`);

  // Request Headers များကို ပြင်ဆင်ခြင်း (Target site မှ block မလုပ်နိုင်ရန်)
  const modifiedHeaders = new Headers(context.request.headers);
  modifiedHeaders.set("Host", TARGET_DOMAIN);
  modifiedHeaders.set("Referer", `https://${TARGET_DOMAIN}/`);

  try {
    const response = await fetch(targetUrl.toString(), {
      method: context.request.method,
      headers: modifiedHeaders,
      body: context.request.body,
      redirect: "follow"
    });

    const contentType = response.headers.get("content-type") || "";

    // HTML ဖြစ်ပါက Link များ ပြောင်းလဲခြင်းနှင့် Ads များ ဖယ်ရှားခြင်း ပြုလုပ်မည်
    if (contentType.includes("text/html")) {
      let htmlText = await response.text();

      // ဒိုမိန်းအမည်များကို မိမိ proxy ဒိုမိန်းသို့ ပြောင်းလဲရန်
      const proxyDomain = url.host;
      htmlText = htmlText.replaceAll(`https://${TARGET_DOMAIN}`, `https://${proxyDomain}`);
      htmlText = htmlText.replaceAll(`//${TARGET_DOMAIN}`, `//${proxyDomain}`);

      // HTMLRewriter အသုံးပြု၍ ကြော်ငြာ script များနှင့် element များကို ဖယ်ရှားခြင်း
      const rewriter = new HTMLRewriter()
        // ကြော်ငြာ script များ၊ popunder script များနှင့် iframe များကို ဖယ်ရှားရန်
        .on("script", {
          element(element) {
            const src = element.getAttribute("src") || "";
            // အသုံးများသော ကြော်ငြာ network စာသားများ ပါဝင်ပါက ဖယ်ရှားမည်
            if (
              src.includes("juicyads") || 
              src.includes("exoclick") || 
              src.includes("popads") || 
              src.includes("popunder") || 
              src.includes("a.exdynsrv.com")
            ) {
              element.remove();
            }
          }
        })
        // Popunder နှင့် ကြော်ငြာ iframe များကို ဖယ်ရှားခြင်း
        .on("iframe", {
          element(element) {
            const src = element.getAttribute("src") || "";
            if (src.includes("ads") || src.includes("pop") || src.includes("juicy")) {
              element.remove();
            }
          }
        })
        // စာမျက်နှာရှိ floating banner များကို ဖယ်ရှားရန် (တားဆီးလိုသော class/id ရှိပါက ထည့်သွင်းနိုင်သည်)
        .on(".ads, .ad-banner, #popunder", {
          element(element) {
            element.remove();
          }
        });

      const modifiedResponse = rewriter.transform(new Response(htmlText, {
        headers: response.headers
      }));

      // Content-Security-Policy header ကြောင့် block မဖြစ်စေရန် ဖယ်ရှားခြင်း
      modifiedResponse.headers.delete("content-security-policy");
      return modifiedResponse;
    }

    // HTML မဟုတ်သော အခြားဖိုင်များ (JS, CSS, Images, Video streams) အတွက် ပုံမှန်အတိုင်း ပြန်ပေးရန်
    return response;

  } catch (error) {
    return new Response("Proxy Error: " + error.message, { status: 500 });
  }
}
