const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PAGES = { "/a/": "a.html", "/b/": "b.html" };

function decodeJwt(token) {
  if (!token) return null;
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

function decodeHeaderJson(header) {
  if (!header) return null;
  return JSON.parse(Buffer.from(header, "base64").toString());
}

function readEnvFile(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function sendJson(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://app");

    if (req.method === "GET" && PAGES[pathname]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      fs.createReadStream(path.join(__dirname, "public", PAGES[pathname])).pipe(res);
      return;
    }

    if (pathname === "/b/config.json") {
      const env = readEnvFile("/generated/creds.env");
      sendJson(res, {
        authority: "http://zitadel.localhost:8080",
        clientId: env.SPA_CLIENT_ID,
        projectId: env.WEB_PROJECT_ID,
      });
      return;
    }

    if (pathname === "/a/me") {
      sendJson(res, decodeHeaderJson(req.headers["x-id-token"]));
      return;
    }

    const claims = decodeJwt(req.headers["x-access-token"]);
    const userinfo = decodeHeaderJson(req.headers["x-userinfo"]);

    console.log(req.headers["x-access-token"], req.headers["x-userinfo"], req.headers["x-roles"], claims, userinfo);
    sendJson(res, {
      message: `hello from node (${req.method} ${pathname})`,
      sub: claims?.sub,
      user: userinfo?.preferred_username ?? claims?.preferred_username,
      aud: claims?.aud,
      roles: req.headers["x-roles"] ? req.headers["x-roles"].split(",") : [],
    });
  })
  .listen(3000, () => console.log("app listening on :3000"));
