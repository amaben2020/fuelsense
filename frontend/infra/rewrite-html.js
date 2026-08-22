// Maps clean URLs onto the files a Next.js static export actually writes.
//
// `next build` with output:'export' emits one flat file per route --
// /pricing.html, /dashboard/orders/new.html -- but the browser asks for
// /pricing. S3 has no concept of "try adding .html", so without this every
// route except the index would 404. Runs on viewer-request, before the cache.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // The distribution's default root object covers "/" itself, but an empty
  // URI can still arrive from some clients.
  if (uri === '' || uri === '/') {
    request.uri = '/index.html';
    return request;
  }

  // Anything with a file extension is a real asset (JS, CSS, svg, the .txt
  // RSC payloads) and must pass through untouched.
  if (/\.[a-zA-Z0-9]+$/.test(uri)) {
    return request;
  }

  // /pricing/ and /pricing must both resolve to /pricing.html.
  if (uri.endsWith('/')) {
    uri = uri.slice(0, -1);
  }

  request.uri = uri + '.html';
  return request;
}
