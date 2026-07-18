<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/lib/verify.php';

$storeDir = dirname(__DIR__) . '/data/community';
if (!is_dir($storeDir) && !mkdir($storeDir, 0755, true)) {
  http_response_code(500); echo json_encode(['error' => 'Community storage unavailable']); exit;
}

function tokenKey(string $token): ?string {
  return preg_match('/^0x[a-fA-F0-9]{40}$/', $token) ? strtolower($token) : null;
}
function readPosts(string $path): array {
  $items = is_file($path) ? json_decode((string) file_get_contents($path), true) : [];
  return is_array($items) ? array_values($items) : [];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $token = tokenKey((string) ($_GET['token'] ?? ''));
  if ($token === null) { http_response_code(400); echo json_encode(['error' => 'Valid token required']); exit; }
  echo json_encode(['posts' => array_slice(array_reverse(readPosts($storeDir . '/' . substr($token, 2) . '.json')), 0, 100)]); exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['error' => 'GET or POST required']); exit; }

$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rate = sys_get_temp_dir() . '/arc-community-' . hash('sha256', $ip) . '.json';
$now = time(); $hits = is_file($rate) ? json_decode((string) file_get_contents($rate), true) : [];
$hits = array_values(array_filter(is_array($hits) ? $hits : [], fn($time) => is_int($time) && $time > $now - 3600));
if (count($hits) >= 20) { http_response_code(429); echo json_encode(['error' => 'Community post limit reached']); exit; }

$raw = file_get_contents('php://input');
$body = is_string($raw) ? json_decode($raw, true) : null;
$token = tokenKey((string) ($body['token'] ?? ''));
$author = tokenKey((string) ($body['author'] ?? ''));
$message = trim((string) ($body['message'] ?? ''));
$timestamp = (int) ($body['timestamp'] ?? 0);
$signature = (string) ($body['signature'] ?? '');
if ($token === null || $author === null || mb_strlen($message) < 2 || mb_strlen($message) > 280 || abs($now - $timestamp) > 600 || !preg_match('/^0x[a-fA-F0-9]{130}$/', $signature)) {
  http_response_code(422); echo json_encode(['error' => 'Invalid signed post']); exit;
}
$signed = "Arcodian community post\nToken: {$token}\nTimestamp: {$timestamp}\nMessage: {$message}";
if (!arcSignedBy($signed, $signature, $author)) {
  http_response_code(401); echo json_encode(['error' => 'Signature does not match author']); exit;
}
$message = strip_tags($message);
$post = ['id' => hash('sha256', $token . $author . $timestamp . $signature), 'token' => $token, 'author' => $author, 'message' => $message, 'timestamp' => $timestamp, 'signature' => $signature];
$path = $storeDir . '/' . substr($token, 2) . '.json';
$handle = fopen($path, 'c+');
if ($handle === false || !flock($handle, LOCK_EX)) { http_response_code(500); echo json_encode(['error' => 'Storage lock failed']); exit; }
$existingRaw = stream_get_contents($handle); $posts = $existingRaw ? json_decode($existingRaw, true) : [];
$posts = is_array($posts) ? $posts : [];
if (!array_filter($posts, fn($item) => ($item['id'] ?? '') === $post['id'])) $posts[] = $post;
$posts = array_slice($posts, -500); rewind($handle); ftruncate($handle, 0); fwrite($handle, json_encode($posts)); fflush($handle); flock($handle, LOCK_UN); fclose($handle);
$hits[] = $now; file_put_contents($rate, json_encode($hits), LOCK_EX);
http_response_code(201); echo json_encode(['post' => $post]);
