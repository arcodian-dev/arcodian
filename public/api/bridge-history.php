<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: private, max-age=30');

// Rediscovers a connected wallet's bridge history server-side (so it shows
// up even on a fresh browser with no localStorage) by reading the actual
// on-chain events for that address, on BOTH environments — Arc Mainnet
// (where all real-money bridging happens today) and Arc Testnet. Until
// 2026-09-05 this only ever scanned Arc Testnet's raw TokenMessengerV2
// depositForBurn calls; every Arc Mainnet bridge — which is what real users
// are actually doing (460+ outbound txs recorded in bridge-stats.json) —
// came back as an empty history list for anyone opening Bridge from a
// browser that hadn't personally initiated the transfer, with no way to
// discover or claim a pending mint. Mainnet bridging on Arcodian always
// goes through ArcBridgeRouter (bridgeWithCircle() in App.tsx requires the
// fee router for every mainnet chain), whose BridgeStarted event indexes
// sender, mintRecipient, AND destinationDomain — so it can be queried
// directly by address via eth_getLogs instead of pulling a full tx list.

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
function rpc_post(string $rpc, array $payload): ?array {
    $ctx = stream_context_create(['http' => [
        'method' => 'POST', 'timeout' => 15,
        'header' => "Content-Type: application/json\r\nUser-Agent: ArcodianIndexer/1.0\r\n",
        'content' => json_encode($payload),
    ]]);
    $raw = @file_get_contents($rpc, false, $ctx);
    $value = $raw === false ? null : json_decode($raw, true);
    return is_array($value) ? $value : null;
}
function rpc_used(string $rpc, string $nonce, string $transmitter): bool {
    $value = rpc_post($rpc, ['jsonrpc'=>'2.0','id'=>1,'method'=>'eth_call','params'=>[['to'=>$transmitter,'data'=>'0xfeb61724'.substr($nonce,2)],'latest']]);
    return isset($value['result']) && hexdec(substr((string)$value['result'], -2)) > 0;
}
$rows = [];

// --- Arc Testnet: raw TokenMessengerV2.depositForBurn (no fee router there) ---
$explorer = 'https://testnet.arcscan.app/api?module=account&action=txlist&address='.urlencode($address).'&page=1&offset=1000&sort=desc';
$txs = get_json($explorer)['result'] ?? [];
$testnetMessenger = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa';
$testnetTransmitter = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';
$testnetDomainChains = [0 => 11155111, 1 => 43113, 2 => 11155420, 3 => 421614, 6 => 84532, 7 => 80002, 26 => 5042002];
$testnetDomainRpcs = [0=>'https://ethereum-sepolia-rpc.publicnode.com',1=>'https://api.avax-test.network/ext/bc/C/rpc',2=>'https://sepolia.optimism.io',3=>'https://sepolia-rollup.arbitrum.io/rpc',6=>'https://sepolia.base.org',7=>'https://rpc-amoy.polygon.technology',26=>'https://rpc.blockdaemon.testnet.arc.io'];
foreach (is_array($txs) ? $txs : [] as $tx) {
    if (strtolower((string)($tx['to'] ?? '')) !== $testnetMessenger || (string)($tx['isError'] ?? '1') !== '0') continue;
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
    $minted = $nonce !== '' && isset($testnetDomainRpcs[$domain]) ? rpc_used($testnetDomainRpcs[$domain], $nonce, $testnetTransmitter) : false;
    $rows[] = ['burnHash'=>$hash,'fromChainId'=>5042002,'toChainId'=>$testnetDomainChains[$domain] ?? 0,'amount'=>$amount,'recipient'=>$recipient,'createdAt'=>(int)($tx['timeStamp'] ?? 0)*1000,'updatedAt'=>(int)($tx['timeStamp'] ?? 0)*1000,'status'=>$minted?'completed':'pending','attestationReady'=>$attestationReady,'note'=>$minted?'Mint verified from destination nonce.':($attestationReady?'Attestation ready; destination mint is still unclaimed.':'Waiting for Circle attestation.')];
}

// --- Arc Mainnet: every bridge goes through an ArcBridgeRouter. A live
// eth_getLogs scan across all 5 routers' full block ranges is far too slow
// to run inside one HTTP request (Arbitrum alone spans ~12.5M blocks;
// confirmed 2026-09-05 a single live attempt here took 100s+ and got cut
// off before returning). scripts/bridge-wallet-index.mjs incrementally
// pre-builds a sender->rows index the same way bridge-stats.mjs pre-builds
// aggregate totals; this just filters that file by address (cheap — total
// bridge volume across every chain is in the hundreds of rows) and then
// does the live Circle/nonce check only for this address's own matches.
$mainnetTransmitter = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64';
$mainnetChainRpc = [1=>'https://ethereum-rpc.publicnode.com', 10=>'https://mainnet.optimism.io', 42161=>'https://arb1.arbitrum.io/rpc', 8453=>'https://mainnet.base.org', 5042=>'https://arcodian.fun/api/rpc-mainnet.php'];
$walletIndexPath = getenv('BRIDGE_WALLET_INDEX_PATH') ?: '/www/wwwroot/arcodian.fun/shared/data/bridge-wallet-index.json';
$walletIndex = @file_get_contents($walletIndexPath);
$walletRows = $walletIndex !== false ? (json_decode($walletIndex, true)['rows'] ?? []) : [];
// Index is already newest-first; each match still costs a live IRIS call
// (plus an eth_call when a nonce comes back) so an address with an unusually
// long history — a dev/deployer wallet in practice, confirmed 46 rows took
// 43s end to end — is capped rather than let a real user's page hang on it.
$matchLimit = 40;
$matched = 0;
foreach ($walletRows as $row) {
    if (strtolower((string)($row['sender'] ?? '')) !== $address) continue;
    if (++$matched > $matchLimit) break;
    $hash = strtolower((string)$row['burnHash']);
    $sourceDomain = (int)$row['sourceDomain'];
    $destRpc = $mainnetChainRpc[$row['toChainId']] ?? null;
    $iris = get_json('https://iris-api.circle.com/v2/messages/'.$sourceDomain.'?transactionHash='.urlencode($hash));
    $message = $iris['messages'][0] ?? null;
    $nonce = is_array($message) ? (string)($message['decodedMessage']['nonce'] ?? '') : '';
    $attestationReady = is_array($message) && ($message['status'] ?? '') === 'complete';
    $minted = $nonce !== '' && $destRpc ? rpc_used($destRpc, $nonce, $mainnetTransmitter) : false;
    $rows[] = ['burnHash'=>$hash,'fromChainId'=>(int)$row['fromChainId'],'toChainId'=>(int)$row['toChainId'],'amount'=>(string)$row['amount'],'recipient'=>$address,'createdAt'=>(int)($row['createdAt'] ?? 0),'updatedAt'=>(int)($row['createdAt'] ?? 0),'status'=>$minted?'completed':'pending','attestationReady'=>$attestationReady,'note'=>$minted?'Mint verified from destination nonce.':($attestationReady?'Attestation ready; destination mint is still unclaimed.':'Waiting for Circle attestation.')];
}

usort($rows, fn($a, $b) => ($b['createdAt'] ?? 0) <=> ($a['createdAt'] ?? 0));
echo json_encode(['version'=>2,'address'=>$address,'source'=>'Arcscan + ArcBridgeRouter logs + Circle CCTP','history'=>$rows], JSON_UNESCAPED_SLASHES);
