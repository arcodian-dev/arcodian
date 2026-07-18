<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: image/svg+xml; charset=utf-8');
header('Cache-Control: public, max-age=60');
header('X-Content-Type-Options: nosniff');

function esc(string $value): string { return htmlspecialchars($value, ENT_QUOTES | ENT_XML1, 'UTF-8'); }
function validAddress(string $value): ?string { return preg_match('/^0x[a-fA-F0-9]{40}$/', $value) ? strtolower($value) : null; }
function marketByAddress(array $launches, string $address): ?array {
  foreach ($launches as $market) if (strtolower((string)($market['address'] ?? '')) === $address) return $market;
  return null;
}
function decimal18(string $value): float {
  if (!preg_match('/^\d+$/', $value)) return 0.0;
  return (float)$value / 1e18;
}

$path = dirname(__DIR__) . '/data/market-index.json';
$index = is_file($path) ? json_decode((string)file_get_contents($path), true) : null;
$launches = is_array($index['launches'] ?? null) ? $index['launches'] : [];
$token = validAddress((string)($_GET['token'] ?? ''));
$arenaRaw = explode(',', (string)($_GET['arena'] ?? ''));
$arenaAddresses = array_values(array_filter(array_map('validAddress', $arenaRaw)));
$arena = count($arenaAddresses) === 2;

if (!$arena && $token === null) { http_response_code(400); echo '<svg xmlns="http://www.w3.org/2000/svg"/>'; exit; }
$first = $arena ? marketByAddress($launches, $arenaAddresses[0]) : marketByAddress($launches, $token);
$second = $arena ? marketByAddress($launches, $arenaAddresses[1]) : null;
if (!$first || ($arena && !$second)) { http_response_code(404); echo '<svg xmlns="http://www.w3.org/2000/svg"/>'; exit; }

$symbol = esc((string)($first['symbol'] ?? 'COIN'));
$name = esc((string)($first['name'] ?? 'Arc market'));
$reserve = decimal18((string)($first['reserve'] ?? '0'));
$threshold = max(decimal18((string)($first['threshold'] ?? '1')), 0.000001);
$progress = !empty($first['graduated']) ? 100 : min(100, ($reserve / $threshold) * 100);
$symbol2 = $second ? esc((string)($second['symbol'] ?? 'COIN')) : '';
$volume = decimal18((string)($first['volume24h'] ?? '0'));
$headline = $arena ? '$' . $symbol . '  VS  $' . $symbol2 : '$' . $symbol;
$subline = $arena ? 'TWO MARKETS ENTER THE ORBIT' : $name;
$metric = $arena ? 'WEEKLY COIN ARENA' : number_format($progress, 2) . '% TO GRADUATION';
$detail = $arena ? 'Ranked from confirmed onchain activity' : number_format($volume, 2) . ' USDC volume · public curve · burned LP ownership';
?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Arcodian share card">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071c2d"/><stop offset=".58" stop-color="#123e54"/><stop offset="1" stop-color="#08705d"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="#70e1bd" stop-opacity=".42"/><stop offset="1" stop-color="#70e1bd" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1020" cy="88" r="340" fill="url(#glow)"/>
  <circle cx="965" cy="315" r="178" fill="none" stroke="#70e1bd" stroke-opacity=".34" stroke-width="2"/>
  <circle cx="965" cy="315" r="112" fill="none" stroke="#f5d876" stroke-opacity=".45"/>
  <circle cx="1077" cy="315" r="12" fill="#f5d876"/>
  <text x="72" y="82" fill="#a7f3d0" font-family="Arial,sans-serif" font-size="20" font-weight="700" letter-spacing="5">ARCODIAN · ARC MARKETS</text>
  <text x="72" y="240" fill="#ffffff" font-family="Arial,sans-serif" font-size="<?= $arena ? '68' : '96' ?>" font-weight="800" letter-spacing="-3"><?= $headline ?></text>
  <text x="76" y="292" fill="#c8dce5" font-family="Arial,sans-serif" font-size="24" font-weight="600" letter-spacing="2"><?= $subline ?></text>
  <rect x="72" y="360" width="560" height="106" rx="22" fill="#ffffff" fill-opacity=".08" stroke="#ffffff" stroke-opacity=".15"/>
  <text x="102" y="403" fill="#70e1bd" font-family="Arial,sans-serif" font-size="18" font-weight="800" letter-spacing="2"><?= esc($metric) ?></text>
  <text x="102" y="440" fill="#ffffff" font-family="Arial,sans-serif" font-size="20" font-weight="600"><?= esc($detail) ?></text>
  <text x="72" y="566" fill="#ffffff" font-family="Arial,sans-serif" font-size="25" font-weight="800">arcodian.fun</text>
  <text x="1128" y="566" text-anchor="end" fill="#c8dce5" font-family="Arial,sans-serif" font-size="18">Markets should show their workings.</text>
</svg>
