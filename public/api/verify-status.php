<?php
// Same-origin proxy for arc.exploreme.pro's smart-contract verification
// lookup. Same story as rpc-mainnet.php: the explorer's API sends back no
// Access-Control-Allow-Origin header at all, so every direct browser fetch
// to it is blocked by CORS (confirmed 2026-07-31 — worked fine server-side
// via curl all session, silently failed from the browser). This sidesteps
// it by fetching server-side, where CORS doesn't apply.
declare(strict_types=1);
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=60');

$address = (string) ($_GET['address'] ?? '');
if (!preg_match('/^0x[a-fA-F0-9]{40}$/', $address)) {
  http_response_code(400);
  echo json_encode(['error' => 'Valid address required']);
  exit;
}

$ch = curl_init("https://api.arc.exploreme.pro/api/v2/smart-contracts/{$address}");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 10,
  CURLOPT_CONNECTTIMEOUT => 5,
]);
$resp = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($resp === false || $code < 200 || $code >= 300) {
  http_response_code(200);
  echo json_encode(['verified' => null]);
  exit;
}
$data = json_decode($resp, true);
// `name` is frequently null even on a genuinely verified contract (seen on
// our own multi-part-verified tokens) — `verified_at`/`match_type` are the
// reliable signal this explorer actually sets only once verification
// succeeded.
echo json_encode(['verified' => is_array($data) && (!empty($data['verified_at']) || !empty($data['match_type']))]);
