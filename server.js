// Tiny static server for TrevorFM. No dependencies.
// Run: node server.js  ->  http://127.0.0.1:8888
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8888;
const ROOT = __dirname;
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

http
  .createServer((req, res) => {
    // localhost and 127.0.0.1 are different storage origins in the browser;
    // force one so settings/login never end up split across the two.
    if ((req.headers.host || "").startsWith("localhost")) {
      res.writeHead(301, { Location: `http://127.0.0.1:${PORT}${req.url}` });
      return res.end();
    }
    let urlPath = req.url.split("?")[0];
    // OAuth callback and any client-side route serve the app shell.
    if (urlPath === "/" || urlPath === "/callback") urlPath = "/index.html";
    const filePath = path.join(ROOT, path.normalize(urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      });
      res.end(data);
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`TrevorFM on air at http://127.0.0.1:${PORT}`);
  });
