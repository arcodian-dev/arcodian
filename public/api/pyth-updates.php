<?php
// Same-origin proxy for Pyth Hermes signed price updates, used by /stocks.
//
// ArcStockMarket is a Pyth pull-oracle consumer: every buy, sell, deposit and
// withdraw carries the latest signed update for the stocks it prices, and the
// contract posts it to Pyth on Arc (update fee 0) before reading. Hermes
// answers 401 without an API key, so the browser cannot fetch updates
// itself. The key stays server-side, in shared/pyth-secret.php beside the
// webroot (same layout and reasons as shared/rpc-secret.php), and never
// reaches the bundle or the repo.
//
// GET /api/pyth-updates.php?ids=<hex>,<hex>
//   → {"ok":true,"updates":["0x…"],"prices":{"<id>":{"price":"…","conf":"…","expo":-5,"publishTime":…}}}
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-store');

// Only the feeds the market lists (plus EUR/USD for Lend), so the proxy
// cannot be used to spend the key's quota on arbitrary feeds.
const ALLOWED = [
  'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593', // NVDA
  '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688', // AAPL
  '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1', // TSLA
  '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5', // SPY
  '9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d', // QQQ
  'd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1', // MSFT
  'b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a', // AMZN
  '5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6', // GOOGL
  '78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe', // META
  'fee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245', // COIN
  'a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b', // EUR/USD
];

function fail(int $code, string $message): void {
  http_response_code($code);
  echo json_encode(['ok' => false, 'error' => $message]);
  exit;
}

$ids = [];
foreach (explode(',', (string)($_GET['ids'] ?? '')) as $raw) {
  $id = strtolower(preg_replace('/^0x/i', '', trim($raw)));
  if ($id === '') continue;
  if (!in_array($id, ALLOWED, true)) fail(400, 'unknown feed');
  $ids[$id] = true;
}
$ids = array_keys($ids);
sort($ids);
if (!$ids) fail(400, 'no feeds');

$key = null;
foreach ([__DIR__ . '/../../../shared/pyth-secret.php', __DIR__ . '/../../shared/pyth-secret.php'] as $candidate) {
  if (is_readable($candidate)) { $key = @include $candidate; break; }
}
if (!is_string($key) || $key === '') fail(503, 'price service not configured');

// Every open /stocks tab polls; a 2-second shared cache keeps many viewers
// on one upstream request. Updates this fresh still pass the contract's
// 60-second age limit with room to spare.
$cacheFile = sys_get_temp_dir() . '/arcodian-pyth-' . sha1(implode(',', $ids)) . '.json';
if (is_readable($cacheFile) && time() - filemtime($cacheFile) < 2) {
  $cached = file_get_contents($cacheFile);
  if ($cached !== false && $cached !== '') { echo $cached; exit; }
}

$query = implode('&', array_map(fn($id) => 'ids[]=0x' . $id, $ids)) . '&encoding=hex&parsed=true';
$ch = curl_init('https://hermes.pyth.network/v2/updates/price/latest?' . $query);
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 8,
  CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key, 'Accept: application/json'],
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
if ($body === false || $status !== 200) fail(502, 'price service unavailable (' . $status . ')');

$data = json_decode($body, true);
if (!is_array($data) || !isset($data['binary']['data'])) fail(502, 'bad price response');

$prices = [];
foreach ($data['parsed'] ?? [] as $feed) {
  $p = $feed['price'] ?? null;
  if (!is_array($p)) continue;
  $prices['0x' . strtolower($feed['id'])] = [
    'price' => (string)$p['price'],
    'conf' => (string)$p['conf'],
    'expo' => (int)$p['expo'],
    'publishTime' => (int)$p['publish_time'],
  ];
}
$out = json_encode([
  'ok' => true,
  'updates' => array_map(fn($hex) => '0x' . $hex, $data['binary']['data']),
  'prices' => $prices,
]);
@file_put_contents($cacheFile, $out, LOCK_EX);
echo $out;
