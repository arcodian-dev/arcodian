<?php
// Same-origin CCTP attestation proxy. Circle's IRIS is queried per source domain;
// if a pending claim stored the wrong source, a direct lookup returns nothing and
// the mint looks impossible. This proxy takes only the burn hash and tries every
// CCTP domain server-side, returning the first message it finds — so a burn can
// always be claimed regardless of which domain the client thinks it came from.
// It also shields the browser from IRIS rate limits during polling.
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$hash = isset($_GET['hash']) ? trim($_GET['hash']) : '';
if (!preg_match('/^0x[a-fA-F0-9]{64}$/', $hash)) {
  http_response_code(400);
  echo json_encode(['messages' => [], 'error' => 'invalid hash']);
  exit;
}

// If the caller knows the source domain, try it first; then sweep the rest.
$domains = [26, 0, 6, 3, 2, 1, 7];
if (isset($_GET['domain']) && ctype_digit($_GET['domain'])) {
  $pref = (int) $_GET['domain'];
  $domains = array_values(array_unique(array_merge([$pref], $domains)));
}

// Testnet and mainnet are separate Circle deployments with separate Iris
// hosts (sandbox vs production) — the client tells us which one the burn
// happened on via ?env=mainnet, since the two networks are otherwise
// indistinguishable from just a domain number (numbering is shared).
$irisHost = (isset($_GET['env']) && $_GET['env'] === 'mainnet')
  ? 'https://iris-api.circle.com'
  : 'https://iris-api-sandbox.circle.com';

foreach ($domains as $d) {
  $url = "{$irisHost}/v2/messages/{$d}?transactionHash={$hash}";
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 12,
    CURLOPT_CONNECTTIMEOUT => 6,
    CURLOPT_HTTPHEADER => ['Accept: application/json'],
  ]);
  $resp = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  if ($resp === false || $code < 200 || $code >= 300) continue;
  $data = json_decode($resp, true);
  $row = isset($data['messages'][0]) ? $data['messages'][0] : null;
  // Match when Circle knows this burn on this domain — either the full message is
  // ready, OR it is still confirming (message null, status pending_confirmations).
  // Returning the pending row lets the UI say "still attesting" instead of the
  // misleading "not on Circle's records".
  if ($row && (!empty($row['message']) || !empty($row['status']))) {
    $data['sourceDomain'] = $d;
    echo json_encode($data);
    exit;
  }
}

echo json_encode(['messages' => []]);
