<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['error' => 'POST required']); exit; }
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rate = sys_get_temp_dir() . '/arc-upload-' . hash('sha256', $ip) . '.json';
$now = time(); $window = 3600; $limit = 20;
$hits = is_file($rate) ? json_decode((string) file_get_contents($rate), true) : [];
$hits = array_values(array_filter(is_array($hits) ? $hits : [], fn($time) => is_int($time) && $time > $now - $window));
if (count($hits) >= $limit) { http_response_code(429); echo json_encode(['error' => 'Hourly image upload limit reached']); exit; }
$hits[] = $now; file_put_contents($rate, json_encode($hits), LOCK_EX);
if (!isset($_FILES['image']) || $_FILES['image']['error'] !== UPLOAD_ERR_OK) { http_response_code(400); echo json_encode(['error' => 'Image upload failed']); exit; }
$file = $_FILES['image'];
if ($file['size'] < 1 || $file['size'] > 5 * 1024 * 1024) { http_response_code(413); echo json_encode(['error' => 'Maximum input size is 5 MB']); exit; }
$mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
$loaders = ['image/jpeg' => 'imagecreatefromjpeg', 'image/png' => 'imagecreatefrompng', 'image/webp' => 'imagecreatefromwebp', 'image/gif' => 'imagecreatefromgif'];
if (!isset($loaders[$mime])) { http_response_code(415); echo json_encode(['error' => 'Use PNG, JPG, WebP, or GIF']); exit; }
$source = @$loaders[$mime]($file['tmp_name']);
if (!$source) { http_response_code(422); echo json_encode(['error' => 'Invalid image']); exit; }
$width = imagesx($source); $height = imagesy($source);
$side = min($width, $height); $srcX = intdiv($width - $side, 2); $srcY = intdiv($height - $side, 2);
$target = imagecreatetruecolor(512, 512);
imagealphablending($target, false); imagesavealpha($target, true);
imagecopyresampled($target, $source, 0, 0, $srcX, $srcY, 512, 512, $side, $side);
ob_start(); imagewebp($target, null, 78); $webp = ob_get_clean();
imagedestroy($source); imagedestroy($target);
if (!$webp || strlen($webp) > 350 * 1024) { http_response_code(422); echo json_encode(['error' => 'Compressed image is too large']); exit; }
$hash = hash('sha256', $webp); $dir = dirname(__DIR__) . '/uploads';
if (!is_dir($dir) && !mkdir($dir, 0755, true)) { http_response_code(500); echo json_encode(['error' => 'Storage unavailable']); exit; }
$path = $dir . '/' . $hash . '.webp';
if (!is_file($path) && file_put_contents($path, $webp, LOCK_EX) === false) { http_response_code(500); echo json_encode(['error' => 'Storage write failed']); exit; }
$jwt = trim((string) (getenv('PINATA_JWT') ?: (is_readable('/etc/arcodian/pinata.jwt') ? file_get_contents('/etc/arcodian/pinata.jwt') : '')));
if ($jwt !== '') {
  $tmp = tempnam(sys_get_temp_dir(), 'arc-ipfs-');
  file_put_contents($tmp, $webp, LOCK_EX);
  $curl = curl_init('https://uploads.pinata.cloud/v3/files');
  $post = ['file' => new CURLFile($tmp, 'image/webp', $hash . '.webp'), 'network' => 'public', 'name' => 'arcodian-' . $hash];
  curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $post, CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $jwt], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25]);
  $raw = curl_exec($curl); $code = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE); curl_close($curl); @unlink($tmp);
  $result = is_string($raw) ? json_decode($raw, true) : null;
  $cid = $result['data']['cid'] ?? $result['IpfsHash'] ?? null;
  if ($code >= 200 && $code < 300 && is_string($cid) && preg_match('/^[a-zA-Z0-9]+$/', $cid)) {
    echo json_encode(['url' => 'ipfs://' . $cid, 'gateway' => 'https://gateway.pinata.cloud/ipfs/' . $cid, 'bytes' => strlen($webp), 'width' => 512, 'height' => 512, 'storage' => 'ipfs']); exit;
  }
}
$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host = preg_replace('/[^a-zA-Z0-9.:-]/', '', $_SERVER['HTTP_HOST'] ?? 'arcodian.fun');
echo json_encode(['url' => $scheme . '://' . $host . '/uploads/' . $hash . '.webp', 'bytes' => strlen($webp), 'width' => 512, 'height' => 512, 'storage' => 'local-fallback']);
