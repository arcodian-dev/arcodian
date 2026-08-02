<?php
// Same-origin Arc Testnet JSON-RPC proxy.
// The public Arc RPCs rate-limit (429) browsers under load; routing reads through
// this proxy (which the VPS reaches at 200) and rotating across endpoints keeps
// the wallet, bridge, swap, and market reliable. Forwards any JSON-RPC method.
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo '{"error":"POST only"}'; exit; }

$body = file_get_contents('php://input');
if ($body === '' || strlen($body) > 262144) {
  http_response_code(400);
  echo '{"jsonrpc":"2.0","error":{"code":-32600,"message":"invalid request"},"id":null}';
  exit;
}

$endpoints = [
  'https://rpc.testnet.arc.network/',
  'https://rpc.blockdaemon.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
];
shuffle($endpoints); // spread load across providers

foreach ($endpoints as $url) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 20,
    CURLOPT_CONNECTTIMEOUT => 6,
  ]);
  $resp = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  if ($resp !== false && $code >= 200 && $code < 300) {
    http_response_code(200);
    echo $resp;
    exit;
  }
}

http_response_code(502);
echo '{"jsonrpc":"2.0","error":{"code":-32603,"message":"All Arc RPC endpoints unavailable"},"id":null}';
