<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=15');
$rpc = getenv('ARC_RPC_URL') ?: 'https://rpc.testnet.arc.network/';
$started = microtime(true);
$curl = curl_init($rpc);
curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode(['jsonrpc' => '2.0', 'id' => 1, 'method' => 'eth_blockNumber', 'params' => []]), CURLOPT_HTTPHEADER => ['Content-Type: application/json'], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5]);
$raw = curl_exec($curl); $code = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE); $error = curl_error($curl); curl_close($curl);
$body = is_string($raw) ? json_decode($raw, true) : null;
$healthy = $code >= 200 && $code < 300 && isset($body['result']);
$pinataConfigured = trim((string) (getenv('PINATA_JWT') ?: (is_readable('/etc/arcodian/pinata.jwt') ? file_get_contents('/etc/arcodian/pinata.jwt') : ''))) !== '';
http_response_code($healthy ? 200 : 503);
echo json_encode(['status' => $healthy ? 'ok' : 'degraded', 'chain' => 5042002, 'block' => $healthy ? hexdec($body['result']) : null, 'rpcMs' => (int) round((microtime(true) - $started) * 1000), 'uploadsWritable' => is_writable(dirname(__DIR__) . '/uploads'), 'imageStorage' => $pinataConfigured ? 'ipfs-with-local-fallback' : 'local-fallback', 'error' => $healthy ? null : ($error ?: 'RPC unavailable')]);
