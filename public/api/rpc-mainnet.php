<?php
// Same-origin Arc Mainnet JSON-RPC proxy. Circle's own endpoints went
// public 2026-09-16 (see $primary below) and now lead the pool; the
// third-party community nodes that carried this from 2026-08-30 until then,
// each independently verified live (eth_chainId == 0x13b2), are kept behind
// them as fallbacks. arc-rpc.stakeme.pro, previously the primary, now
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

// Circle's official Arc Mainnet endpoints, published on docs.arc.io
// (arc/references/connect-to-arc) on 2026-09-16, the day of the public
// mainnet launch — until then no official endpoint existed at all, which is
// what the comment at the top of this file describes. All four verified
// live from this server before the switch: correct chainId (0x13b2), real
// head blocks, 0.12-0.50s round trip, and no failures across a 20-request
// parallel burst.
//
// Split into primary/fallback instead of one shuffled pool. The official
// four are shuffled among themselves to spread load (same reasoning as
// before), but the legacy community endpoints stay in fixed order AFTER
// them rather than being mixed in, because they are no longer equivalent:
// on launch night arc-scan answered "temporarily out of capacity" /
// "rate limiting requests from this client" / 503, railway-warp returned
// 400, and thirdweb threw "could not coalesce error" — a shuffle that can
// deal any of those first turns a healthy request into a retry round-trip.
// They are kept because none of the official endpoints serves a
// many-address eth_getLogs except blockdaemon, and arc-scan does when it is
// healthy (~92,000-block ranges), so they are still worth having last.
// Only the two endpoints that survive sustained traffic are primary. Firing
// 60 eth_calls in ~1.5s, blockdaemon and drpc served 60/60 while
// rpc.mainnet.arc.io served 29/60 and quicknode 26/60, the rest coming back
// "rate limit exceeded" — and this proxy concentrates EVERY browser's reads
// onto one server IP, so it hits those limits far harder than any single
// visitor would. The two rate-limited official endpoints are demoted to
// fallbacks rather than dropped: they are Circle's own and answer fine at
// lower volume.
// A keyed Alchemy endpoint, when one is configured, leads everything. Measured
// against the unauthenticated endpoints: 200/200 eth_calls served in 7.3s
// where blockdaemon (also 200/200) took 11.2s, and it handles the
// many-address getLogs shape too (it caps by response SIZE rather than block
// range, so a wide query asks you to split rather than refusing outright).
//
// The key is read from shared/rpc-secret.php, deliberately OUTSIDE this repo
// and outside every release directory. A version of the Zeeve mainnet RPC key
// was committed to this public repository from 2026-08-04 to 2026-08-30 and
// had to be rotated; keyed endpoints do not go in tracked files again. The
// file returns an array of URLs, is absent on any machine without a key, and
// is not reachable over HTTP (shared/ sits beside the webroot; only its data
// and uploads directories are symlinked in).
// Two candidate paths because __DIR__ resolves through the `current` symlink
// to the real release directory: from releases/<ts>/api/ the shared directory
// is three levels up, while a plain (unversioned) docroot puts it two. Try
// both rather than assuming a layout.
$keyed = [];
$secretPath = null;
foreach ([__DIR__ . '/../../../shared/rpc-secret.php', __DIR__ . '/../../shared/rpc-secret.php'] as $candidate) {
  if (is_readable($candidate)) { $secretPath = $candidate; break; }
}
if ($secretPath !== null) {
  $configured = @include $secretPath;
  if (is_array($configured)) {
    foreach ($configured as $url) {
      if (is_string($url) && str_starts_with($url, 'https://')) {
        $keyed[] = ['name' => 'keyed', 'url' => $url, 'headers' => ['Content-Type: application/json']];
      }
    }
  }
}

$primary = [
  [
    'name' => 'arc-blockdaemon',
    'url' => 'https://rpc.blockdaemon.mainnet.arc.io',
    'headers' => ['Content-Type: application/json'],
  ],
  [
    'name' => 'arc-drpc',
    'url' => 'https://rpc.drpc.mainnet.arc.io',
    'headers' => ['Content-Type: application/json'],
  ],
];
$fallback = [
  [
    'name' => 'arc-official',
    'url' => 'https://rpc.mainnet.arc.io',
    'headers' => ['Content-Type: application/json'],
  ],
  [
    'name' => 'arc-quicknode',
    'url' => 'https://rpc.quicknode.mainnet.arc.io',
    'headers' => ['Content-Type: application/json'],
  ],
  [
    'name' => 'arc-scan',
    'url' => 'https://rpc.arc-scan.org/',
    'headers' => ['Content-Type: application/json'],
  ],
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
shuffle($primary);
// Keyed endpoints are not shuffled in: they are strictly better, so they go
// first and the public pool becomes the fallback behind them.
$endpoints = array_merge($keyed, $primary, $fallback);

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
