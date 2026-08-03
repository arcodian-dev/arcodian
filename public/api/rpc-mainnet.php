<?php
// Same-origin Arc Mainnet JSON-RPC proxy.
// arc-rpc.stakeme.pro (the only working Arc Mainnet RPC we've found — no
// official Circle endpoint is public yet, see contracts.mainnet.json) sends
// back Access-Control-Allow-Origin: https://www.alchemy.com on every
// response — a leftover/misconfigured header from whatever infra they proxy
// through. That fails CORS preflight for every browser-side fetch to it
// directly, silently breaking every direct-RPC read in the frontend (Market
// live-launch reads, the Landing mainnet radar, Wallet balance checks,
// AgentPay/ArcPay live reads) while server-side script/cast calls (which
// don't enforce CORS) looked completely fine — found 2026-07-31 after a
// freshly-launched mainnet coin didn't show up anywhere in the UI. Routing
// through this same-origin proxy sidesteps it entirely, same pattern as the
// existing Arc Testnet proxy (rpc.php).
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
    'name' => 'radar-railway',
    'url' => 'https://radar-api-rpc.up.railway.app',
    'headers' => ['Content-Type: application/json'],
  ],
];
// baracat (arc-mainnet-rpc.baracat.meme) dropped 2026-08-02 — caught ~65
// blocks behind the other two endpoints while still answering every eth_call
// with a stale-but-HTTP-200 result, which (combined with a fixed try-order
// that always hit it first) permanently masked fresher data no matter how
// many times a read was retried. Shuffling spreads load across the
// remaining two instead of pinning to whichever is listed first, same
// pattern as the testnet proxy (rpc.php) already uses.
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
