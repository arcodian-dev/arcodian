<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: private, max-age=30');

$address = strtolower(trim((string)($_GET['address'] ?? '')));
if (!preg_match('/^0x[a-f0-9]{40}$/', $address)) {
    http_response_code(400); echo json_encode(['error' => 'invalid address']); exit;
}

function get_json(string $url): ?array {
    $ctx = stream_context_create(['http' => ['timeout' => 15, 'header' => "User-Agent: ArcodianIndexer/1.0\r\n"]]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false) return null;
    $value = json_decode($raw, true);
    return is_array($value) ? $value : null;
}
function rpc_used(string $rpc, string $nonce): bool {
    $payload = json_encode(['jsonrpc'=>'2.0','id'=>1,'method'=>'eth_call','params'=>[['to'=>'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275','data'=>'0xfeb61724'.substr($nonce,2)],'latest']]);
    $ctx = stream_context_create(['http'=>['method'=>'POST','timeout'=>15,'header'=>"Content-Type: application/json\r\nUser-Agent: ArcodianIndexer/1.0\r\n",'content'=>$payload]]);
    $raw = @file_get_contents($rpc, false, $ctx);
    $value = $raw === false ? null : json_decode($raw, true);
    return isset($value['result']) && hexdec(substr((string)$value['result'], -2)) > 0;
}

$explorer = 'https://testnet.arcscan.app/api?module=account&action=txlist&address='.urlencode($address).'&page=1&offset=1000&sort=desc';
$txs = get_json($explorer)['result'] ?? [];
$messenger = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa';
$domainChains = [0 => 11155111, 1 => 43113, 2 => 11155420, 3 => 421614, 6 => 84532, 7 => 80002, 26 => 5042002];
$domainRpcs = [0=>'https://ethereum-sepolia-rpc.publicnode.com',1=>'https://api.avax-test.network/ext/bc/C/rpc',2=>'https://sepolia.optimism.io',3=>'https://sepolia-rollup.arbitrum.io/rpc',6=>'https://sepolia.base.org',7=>'https://rpc-amoy.polygon.technology',26=>'https://rpc.blockdaemon.testnet.arc.io'];
$rows = [];
foreach (is_array($txs) ? $txs : [] as $tx) {
    if (strtolower((string)($tx['to'] ?? '')) !== $messenger || (string)($tx['isError'] ?? '1') !== '0') continue;
    $input = strtolower((string)($tx['input'] ?? ''));
    if (!str_starts_with($input, '0x8e0250ee') || strlen($input) < 10 + 64 * 3) continue;
    $args = substr($input, 10);
    $amount = ltrim(substr($args, 0, 64), '0') ?: '0';
    $amount = base_convert($amount, 16, 10);
    $domain = hexdec(substr($args, 64, 64));
    $recipient = '0x'.substr($args, 64 * 3 - 40, 40);
    $hash = strtolower((string)$tx['hash']);
    $iris = get_json('https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash='.urlencode($hash));
    $message = $iris['messages'][0] ?? null;
    $nonce = is_array($message) ? (string)($message['decodedMessage']['nonce'] ?? '') : '';
    $attestationReady = is_array($message) && ($message['status'] ?? '') === 'complete';
    $minted = $nonce !== '' && isset($domainRpcs[$domain]) ? rpc_used($domainRpcs[$domain], $nonce) : false;
    $rows[] = ['burnHash'=>$hash,'fromChainId'=>5042002,'toChainId'=>$domainChains[$domain] ?? 0,'amount'=>$amount,'recipient'=>$recipient,'createdAt'=>(int)($tx['timeStamp'] ?? 0)*1000,'updatedAt'=>(int)($tx['timeStamp'] ?? 0)*1000,'status'=>$minted?'completed':'pending','attestationReady'=>$attestationReady,'note'=>$minted?'Mint verified from destination nonce.':($attestationReady?'Attestation ready; destination mint is still unclaimed.':'Waiting for Circle attestation.')];
}
echo json_encode(['version'=>1,'address'=>$address,'source'=>'Arcscan + Circle CCTP','history'=>$rows], JSON_UNESCAPED_SLASHES);
