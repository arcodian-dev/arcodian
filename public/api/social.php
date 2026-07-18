<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/lib/verify.php';

$storeDir = dirname(__DIR__) . '/data/social';
if (!is_dir($storeDir) && !mkdir($storeDir, 0755, true)) {
  http_response_code(500); echo json_encode(['error' => 'Social storage unavailable']); exit;
}
function addressKey(string $value): ?string {
  return preg_match('/^0x[a-fA-F0-9]{40}$/', $value) ? strtolower($value) : null;
}
function validSocialUrl(string $value, array $hosts): bool {
  if ($value === '') return true;
  if (strlen($value) > 160 || !filter_var($value, FILTER_VALIDATE_URL)) return false;
  $host = strtolower((string) parse_url($value, PHP_URL_HOST));
  $host = preg_replace('/^www\./', '', $host) ?? $host;
  return in_array($host, $hosts, true) && strtolower((string) parse_url($value, PHP_URL_SCHEME)) === 'https';
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $token = addressKey((string) ($_GET['token'] ?? ''));
  if ($token === null) { http_response_code(400); echo json_encode(['error' => 'Valid token required']); exit; }
  $path = $storeDir . '/' . substr($token, 2) . '.json';
  $social = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
  echo json_encode(['social' => is_array($social) ? $social : null]); exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['error' => 'GET or POST required']); exit; }

$raw = file_get_contents('php://input');
$body = is_string($raw) ? json_decode($raw, true) : null;
$token = addressKey((string) ($body['token'] ?? ''));
$creator = addressKey((string) ($body['creator'] ?? ''));
$twitter = trim((string) ($body['twitter'] ?? ''));
$discord = trim((string) ($body['discord'] ?? ''));
$timestamp = (int) ($body['timestamp'] ?? 0);
$signature = (string) ($body['signature'] ?? '');
$now = time();
if ($token === null || $creator === null || ($twitter === '' && $discord === '') ||
    !validSocialUrl($twitter, ['x.com', 'twitter.com']) ||
    !validSocialUrl($discord, ['discord.gg', 'discord.com']) ||
    abs($now - $timestamp) > 600 || !preg_match('/^0x[a-fA-F0-9]{130}$/', $signature)) {
  http_response_code(422); echo json_encode(['error' => 'Invalid signed social links']); exit;
}
$signed = "Arcodian coin links\nToken: {$token}\nTimestamp: {$timestamp}\nX: {$twitter}\nDiscord: {$discord}";
if (!arcSignedBy($signed, $signature, $creator)) {
  http_response_code(401); echo json_encode(['error' => 'Signature does not match creator']); exit;
}
$onchainCreator = arcIndexedCreator($token);
if ($onchainCreator !== null && $onchainCreator !== strtolower($creator)) {
  http_response_code(403); echo json_encode(['error' => 'Only the token creator can set links']); exit;
}

$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rate = sys_get_temp_dir() . '/arc-social-' . hash('sha256', $ip) . '.json';
$hits = is_file($rate) ? json_decode((string) file_get_contents($rate), true) : [];
$hits = array_values(array_filter(is_array($hits) ? $hits : [], fn($time) => is_int($time) && $time > $now - 3600));
if (count($hits) >= 10) { http_response_code(429); echo json_encode(['error' => 'Social link limit reached']); exit; }

$record = ['token' => $token, 'creator' => $creator, 'twitter' => $twitter, 'discord' => $discord, 'timestamp' => $timestamp, 'signature' => $signature];
$path = $storeDir . '/' . substr($token, 2) . '.json';
if (is_file($path)) { http_response_code(409); echo json_encode(['error' => 'Coin links already registered']); exit; }
if (file_put_contents($path, json_encode($record, JSON_UNESCAPED_SLASHES), LOCK_EX) === false) {
  http_response_code(500); echo json_encode(['error' => 'Social links could not be stored']); exit;
}
$hits[] = $now; file_put_contents($rate, json_encode($hits), LOCK_EX);
http_response_code(201); echo json_encode(['social' => $record], JSON_UNESCAPED_SLASHES);
