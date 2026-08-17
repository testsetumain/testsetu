const apiPrefixes = ["/api/", "/uploads/"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (apiPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      return proxyToNodeOrigin(request, env, url);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  }
};

async function proxyToNodeOrigin(request, env, incomingUrl) {
  if (!env.BACKEND_ORIGIN) {
    return json({ error: "Cloudflare BACKEND_ORIGIN is not configured." }, 500);
  }

  const origin = new URL(env.BACKEND_ORIGIN);
  const target = new URL(request.url);
  target.protocol = origin.protocol;
  target.hostname = origin.hostname;
  target.port = origin.port;

  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
  headers.set("x-testsetu-edge", "cloudflare");

  return fetch(new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual"
  }));
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
