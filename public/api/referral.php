<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function wallet(string $value): ?string {
  return preg_match('/^0x[a-fA-F0-9]{40}$/', $value) ? strtolower($value) : null;
}
$dir = dirname(__DIR__) . '/data/referrals';
if (!is_dir($dir) && !mkdir($dir, 0755, true)) { http_response_code(500); echo json_encode(['error'=>'Storage unavailable']); exit; }
$ref = wallet((string) ($_GET['ref'] ?? ''));
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  if ($ref === null) { http_response_code(400); echo json_encode(['error'=>'Valid ref wallet required']); exit; }
  $path = $dir . '/' . substr($ref, 2) . '.json';
  $data = is_file($path) ? json_decode((string) file_get_contents($path), true) : [];
  $days = is_array($data['days'] ?? null) ? $data['days'] : [];
  echo json_encode(['ref'=>$ref,'visits'=>array_sum(array_map(fn($d)=>(int)($d['visits']??0),$days)),'uniqueVisitors'=>array_sum(array_map(fn($d)=>count((array)($d['seen']??[])),$days)),'lastVisit'=>$data['lastVisit']??null]); exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['error'=>'GET or POST required']); exit; }
$body = json_decode((string) file_get_contents('php://input'), true);
$ref = wallet((string) ($body['ref'] ?? ''));
if ($ref === null) { http_response_code(422); echo json_encode(['error'=>'Invalid referral']); exit; }
$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
$ua = substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 180);
$day = gmdate('Y-m-d');
$visitor = hash('sha256', $day . '|' . $ip . '|' . $ua . '|arcodian-ref-v1');
$path = $dir . '/' . substr($ref, 2) . '.json';
$handle = fopen($path, 'c+');
if ($handle === false || !flock($handle, LOCK_EX)) { http_response_code(500); echo json_encode(['error'=>'Storage lock failed']); exit; }
$raw = stream_get_contents($handle); $data = $raw ? json_decode($raw, true) : [];
$data = is_array($data) ? $data : []; $data['days'] = is_array($data['days'] ?? null) ? $data['days'] : [];
$data['days'] = array_filter($data['days'], fn($value,$key)=>strtotime((string)$key) >= strtotime('-30 days'), ARRAY_FILTER_USE_BOTH);
$entry = is_array($data['days'][$day] ?? null) ? $data['days'][$day] : ['visits'=>0,'seen'=>[]];
$isUnique = !in_array($visitor, (array)$entry['seen'], true);
if ($isUnique) { $entry['visits'] = (int)$entry['visits'] + 1; $entry['seen'][] = $visitor; }
$data['days'][$day] = $entry; $data['lastVisit'] = time();
rewind($handle); ftruncate($handle,0); fwrite($handle,json_encode($data)); fflush($handle); flock($handle,LOCK_UN); fclose($handle);
http_response_code(201); echo json_encode(['recorded'=>$isUnique]);
