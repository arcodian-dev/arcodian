<?php
// Same-origin proxy for arcexplorer.org's published-source status.
//
// The explorer's API sends no Access-Control-Allow-Origin header, so a
// browser cannot read it directly from arcodian.fun — the Verified badges on
// /contracts silently stayed off. Proxying it server-side is the same pattern
// attest.php and rpc-mainnet.php already use for exactly this reason.
//
// Answers for a batch of addresses in one request, because the contracts page
// asks about ten of them at once and ten separate round trips through a proxy
// is worse than one.
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
// Verification status changes at most once per contract, ever. A short cache
// keeps a page load from re-asking the explorer about the same addresses.
header('Cache-Control: public, max-age=300');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$raw = isset($_GET['addresses']) ? $_GET['addresses'] : '';
$addresses = array_values(array_unique(array_filter(
  array_map('trim', explode(',', $raw)),
  static fn($a) => (bool) preg_match('/^0x[a-fA-F0-9]{40}$/', $a),
)));
if (!$addresses) {
  http_response_code(400);
  echo json_encode(['error' => 'no valid addresses']);
  exit;
}
// Bound the fan-out so this endpoint cannot be used to hammer the explorer.
$addresses = array_slice($addresses, 0, 25);

$out = [];
foreach ($addresses as $address) {
  $ch = curl_init("https://www.arcexplorer.org/api/v1/contracts/{$address}");
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 8,
    CURLOPT_CONNECTTIMEOUT => 4,
    CURLOPT_HTTPHEADER => ['Accept: application/json'],
  ]);
  $resp = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  $verified = false;
  $name = null;
  if ($resp !== false && $code >= 200 && $code < 300) {
    $data = json_decode($resp, true);
    if (is_array($data)) {
      $verified = !empty($data['verified']);
      $name = $data['contractName'] ?? null;
    }
  }
  // An unreachable explorer reports "not verified" rather than an error: the
  // badge is additive, and a page that fails to load because a third-party
  // API is down would be a worse trade.
  $out[strtolower($address)] = ['verified' => $verified, 'name' => $name];
}
echo json_encode(['contracts' => $out]);
