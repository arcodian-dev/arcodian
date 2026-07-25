<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['error' => 'POST required']); exit; }

// Rate limit (mirror agent-metadata.php): 20/hour per IP.
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rate = sys_get_temp_dir() . '/arc-jobmeta-' . hash('sha256', $ip) . '.json';
$now = time(); $window = 3600; $limit = 20;
$hits = is_file($rate) ? json_decode((string) file_get_contents($rate), true) : [];
$hits = array_values(array_filter(is_array($hits) ? $hits : [], fn($t) => is_int($t) && $t > $now - $window));
if (count($hits) >= $limit) { http_response_code(429); echo json_encode(['error' => 'Hourly limit reached']); exit; }
$hits[] = $now; file_put_contents($rate, json_encode($hits), LOCK_EX);

$body = file_get_contents('php://input');
if ($body === false || strlen($body) < 2 || strlen($body) > 32768) { http_response_code(413); echo json_encode(['error' => 'Body must be 2 B - 32 KB']); exit; }
$decoded = json_decode($body, true);
// A job description must carry at least a title; other fields (brief, requirements,
// deliverableSpec, budgetUSDC, provider, evaluator) are optional and pinned as-is.
if (!is_array($decoded) || !isset($decoded['title'])) { http_response_code(400); echo json_encode(['error' => 'Invalid job JSON (title required)']); exit; }
// Re-encode canonically so the pinned bytes are stable and the CID / descHash is deterministic per content.
$canonical = json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

$jwt = trim((string) (getenv('PINATA_JWT') ?: (is_readable('/etc/arcodian/pinata.jwt') ? file_get_contents('/etc/arcodian/pinata.jwt') : '')));
if ($jwt !== '') {
  $tmp = tempnam(sys_get_temp_dir(), 'arc-job-');
  file_put_contents($tmp, $canonical, LOCK_EX);
  $curl = curl_init('https://uploads.pinata.cloud/v3/files');
  $post = ['file' => new CURLFile($tmp, 'application/json', 'job-metadata.json'), 'network' => 'public', 'name' => 'arcodian-job-' . hash('sha256', $canonical)];
  curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $post, CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $jwt], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25]);
  $raw = curl_exec($curl); $code = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE); curl_close($curl); @unlink($tmp);
  $result = is_string($raw) ? json_decode($raw, true) : null;
  $cid = $result['data']['cid'] ?? $result['IpfsHash'] ?? null;
  if ($code >= 200 && $code < 300 && is_string($cid) && preg_match('/^[a-zA-Z0-9]+$/', $cid)) {
    echo json_encode(['url' => 'ipfs://' . $cid, 'gateway' => 'https://gateway.pinata.cloud/ipfs/' . $cid, 'storage' => 'ipfs']); exit;
  }
}
// Fallback: content-address on our host by sha256 when Pinata is unavailable.
$dir = dirname(__DIR__) . '/job-metadata';
if (!is_dir($dir) && !mkdir($dir, 0755, true)) { http_response_code(500); echo json_encode(['error' => 'Storage unavailable']); exit; }
$hash = hash('sha256', $canonical); $path = $dir . '/' . $hash . '.json';
if (!is_file($path) && file_put_contents($path, $canonical, LOCK_EX) === false) { http_response_code(500); echo json_encode(['error' => 'Storage write failed']); exit; }
$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host = preg_replace('/[^a-zA-Z0-9.:-]/', '', $_SERVER['HTTP_HOST'] ?? 'arcodian.fun');
echo json_encode(['url' => $scheme . '://' . $host . '/job-metadata/' . $hash . '.json?sha256=' . $hash, 'storage' => 'local-fallback']);
