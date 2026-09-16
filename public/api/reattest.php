<?php
// Same-origin CCTP re-attestation proxy.
//
// A CCTP v2 message attested at soft finality carries an expirationBlock on
// the destination chain; past it MessageTransmitter rejects the mint with
// "Message expired and must be re-signed". Circle keeps serving the stale
// signature with status "complete", so nothing upstream notices — the claim
// simply reverts. This happened at scale to Arcodian's inbound transfers:
// burns made while Circle was not yet attesting messages destined for Arc
// were all signed as Fast Transfers and every one of them lapsed.
//
// The fix is Circle's own POST /v2/reattest/{nonce}, which re-signs the
// message at hard finality (finalityThresholdExecuted 1000 -> 2000,
// expirationBlock -> 0, i.e. it never expires again). Verified end to end
// 2026-09-16: 17 stuck transfers re-signed within ~60s, no auth required,
// and nothing about the transfer changes except the signature — the mint
// recipient is fixed inside the message, so this cannot redirect funds.
//
// Proxied same-origin for the same reasons attest.php is: browser CORS and
// IRIS rate limits during polling.
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405);
  echo json_encode(['ok' => false, 'error' => 'POST required']);
  exit;
}

$nonce = isset($_GET['nonce']) ? trim($_GET['nonce']) : '';
if (!preg_match('/^0x[a-fA-F0-9]{64}$/', $nonce)) {
  http_response_code(400);
  echo json_encode(['ok' => false, 'error' => 'invalid nonce']);
  exit;
}

$irisHost = (isset($_GET['env']) && $_GET['env'] === 'mainnet')
  ? 'https://iris-api.circle.com'
  : 'https://iris-api-sandbox.circle.com';

$ch = curl_init("{$irisHost}/v2/reattest/{$nonce}");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => '{}',
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 20,
  CURLOPT_CONNECTTIMEOUT => 6,
  CURLOPT_HTTPHEADER => ['Accept: application/json', 'Content-Type: application/json'],
]);
$resp = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($resp === false || $code < 200 || $code >= 300) {
  http_response_code(502);
  echo json_encode(['ok' => false, 'error' => 'Circle did not accept the re-attestation request', 'status' => $code]);
  exit;
}

$data = json_decode($resp, true);
$accepted = is_array($data) && isset($data['message']) && stripos((string) $data['message'], 'successfully') !== false;
echo json_encode(['ok' => $accepted, 'circle' => $data]);
