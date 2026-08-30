<?php
// Same-origin Arc Mainnet JSON-RPC proxy. No official Circle endpoint is
// public yet (see contracts.mainnet.json) — every candidate below is a
// third-party community node, independently verified live (eth_chainId ==
// 0x13b2) 2026-08-30. arc-rpc.stakeme.pro, previously the primary, now
// answers "ARC_MAINNET is not enabled for this app" (an Alchemy-side app
// config issue on their end, not ours) and is dropped entirely rather than
// wasting a retry on a deterministic failure. Originally routed through
// this proxy (rather than called directly from the browser) because
// stakeme sent back Access-Control-Allow-Origin: https://www.alchemy.com
// on every response, failing CORS preflight for direct browser fetches —
// same pattern as the existing Arc Testnet proxy (rpc.php).
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
// Some wallets (OKX confirmed 2026-08-03) run their own plain reachability
// probe against a chain's rpcUrls before trusting them — a bare GET/HEAD at
// the URL, no JSON-RPC body. This proxy used to 405 that, which some wallets
// treat as "this RPC is broken" and refuse to use it (or the whole
// wallet_addEthereumChain call) even though the real POST-based JSON-RPC
// path works fine. Answer any non-POST request with 200 instead of 405 so
// that kind of check passes; only the actual proxying logic below requires
// a POST body.
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(200); echo '{"ok":true,"name":"arcodian-arc-mainnet-rpc"}'; exit; }

$body = file_get_contents('php://input');
if ($body === '' || strlen($body) > 262144) {
  http_response_code(400);
  echo '{"jsonrpc":"2.0","error":{"code":-32600,"message":"invalid request"},"id":null}';
  exit;
}

$endpoints = [
  [
    'name' => 'railway-warp',
    'url' => 'https://warp-arc-production.up.railway.app/rpc',
    'headers' => ['Content-Type: application/json'],
  ],
  [
    'name' => 'thirdweb-anon',
    'url' => 'https://5042.rpc.thirdweb.com/',
    'headers' => ['Content-Type: application/json'],
  ],
];
// baracat (arc-mainnet-rpc.baracat.meme) dropped 2026-08-02 — caught ~65
// blocks behind the other two endpoints while still answering every eth_call
// with a stale-but-HTTP-200 result, which (combined with a fixed try-order
// that always hit it first) permanently masked fresher data no matter how
// many times a read was retried. radar-railway (radar-api-rpc.up.railway.app)
// removed 2026-08-30 — that Railway app no longer exists ("Application not
// found", a deterministic 404 on every single request), so it had been
// silently burning a full connect-timeout on every proxied call whenever
// shuffle() picked it first, for however long it's been dead. thirdweb's
// public anonymous endpoint added as a second, independently-hosted
// candidate (works without a client ID, unlike VITE_THIRDWEB_CLIENT_ID
// elsewhere in this codebase) — occasionally rate-limited/errors on its own,
// which is fine, it just falls through to railway-warp same as any other
// failed candidate. Shuffling spreads load across both instead of pinning
// to whichever is listed first, same pattern as the testnet proxy (rpc.php)
// already uses.
shuffle($endpoints);

$attempts = 4;
for ($i = 0; $i < $attempts; $i++) {
  foreach ($endpoints as $endpoint) {
    $ch = curl_init($endpoint['url']);
    curl_setopt_array($ch, [
      CURLOPT_POST => true,
      CURLOPT_POSTFIELDS => $body,
      CURLOPT_HTTPHEADER => $endpoint['headers'],
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_TIMEOUT => 20,
      CURLOPT_CONNECTTIMEOUT => 6,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    // A JSON-RPC-level error (e.g. baracat's own "upstream rate-limited")
    // still comes back as HTTP 200 — treat it as a failed attempt too,
    // instead of forwarding the error body to the caller as if it were data.
    if ($resp !== false && $code >= 200 && $code < 300) {
      $decoded = json_decode($resp, true);
      if (!is_array($decoded) || !isset($decoded['error'])) {
        http_response_code(200);
        echo $resp;
        exit;
      }
    }
  }
  if ($i < $attempts - 1) usleep(400000); // 400ms
}

http_response_code(502);
echo '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Arc Mainnet RPC unavailable"},"id":null}';
