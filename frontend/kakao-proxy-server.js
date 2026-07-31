// 로컬 테스트 전용 CORS 프록시. kakao-transit-test.html이 브라우저에서
// 카카오 API를 직접 호출하면 CORS로 막히므로, 이 서버가 대신 호출해서 돌려준다.
// 실행: node kakao-proxy-server.js
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 8787;

function loadEnvKey(name) {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return null;
  const line = fs.readFileSync(envPath, "utf8")
    .split("\n")
    .find(l => l.trim().startsWith(name + "="));
  return line ? line.split("=").slice(1).join("=").trim() : null;
}

const KAKAO_REST_API_KEY = loadEnvKey("EXPO_PUBLIC_KAKAO_REST_API_KEY");
const KAKAO_JS_API_KEY = loadEnvKey("EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY");

if (!KAKAO_REST_API_KEY) {
  console.error("EXPO_PUBLIC_KAKAO_REST_API_KEY를 .env에서 찾을 수 없습니다. integrate/.env 파일을 확인하세요.");
  process.exit(1);
}

function proxyToKakao(kakaoPath, res) {
  https.get(
    `https://dapi.kakao.com${kakaoPath}`,
    { headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` } },
    kakaoRes => {
      let body = "";
      kakaoRes.on("data", chunk => (body += chunk));
      kakaoRes.on("end", () => {
        res.writeHead(kakaoRes.statusCode || 200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(body);
      });
    }
  ).on("error", err => {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: err.message }));
  });
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 테스트 페이지 자체도 이 서버에서 서빙한다.
  // (file:// 로 열면 카카오 지도 JS SDK가 도메인 검증에서 막힐 수 있어서, http://localhost 오리진으로 열어야 한다)
  if (url.pathname === "/" || url.pathname === "/kakao-transit-test.html") {
    const filePath = path.join(__dirname, "kakao-transit-test.html");
    fs.readFile(filePath, "utf8", (err, html) => {
      if (err) {
        res.writeHead(500);
        res.end("kakao-transit-test.html을 찾을 수 없습니다: " + err.message);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    return;
  }

  if (url.pathname === "/config") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ jsKey: KAKAO_JS_API_KEY }));
    return;
  }

  if (url.pathname === "/local-search") {
    const query = url.searchParams.get("query") || "";
    proxyToKakao(`/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=8`, res);
    return;
  }

  if (url.pathname === "/transit") {
    proxyToKakao(`/v2/routing/publictraffic?${url.searchParams.toString()}`, res);
    return;
  }

  res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT} 에서 열어주세요 (이 창은 테스트하는 동안 계속 켜두세요).`);
});
