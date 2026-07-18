<?php
declare(strict_types=1);

/**
 * Recover the signer of an EIP-191 (personal_sign) message via the localhost
 * sig-verifier microservice (arcodian-sigverify.service). aaPanel disables
 * proc_open/exec, so PHP verifies over 127.0.0.1 with curl instead of spawning
 * node. Fail-closed: returns null (reject) if the service is unreachable.
 */
function arcRecoverSigner(string $message, string $signature): ?string
{
    if (!preg_match('/^0x[a-fA-F0-9]{130}$/', $signature)) {
        return null;
    }
    $endpoint = getenv('ARC_SIGVERIFY_URL') ?: 'http://127.0.0.1:8791/verify';
    $ch = curl_init($endpoint);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(['message' => $message, 'signature' => $signature]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => 4,
    ]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($code < 200 || $code >= 300 || !is_string($raw)) {
        return null;
    }
    $data = json_decode($raw, true);
    $signer = is_array($data) ? ($data['signer'] ?? null) : null;
    if (!is_string($signer)) {
        return null;
    }
    $signer = strtolower($signer);
    return preg_match('/^0x[a-f0-9]{40}$/', $signer) ? $signer : null;
}

/** True when the recovered signer of $message equals $expected (case-insensitive). */
function arcSignedBy(string $message, string $signature, string $expected): bool
{
    $signer = arcRecoverSigner($message, $signature);
    return $signer !== null && $signer === strtolower($expected);
}

/**
 * Look up a token's on-chain creator from the market index, if present.
 * Returns lowercase address, or null when the token is not indexed yet
 * (e.g. immediately after launch, before the indexer picks it up).
 */
function arcIndexedCreator(string $token): ?string
{
    $path = dirname(__DIR__) . '/data/market-index.json';
    $index = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
    foreach ((is_array($index['launches'] ?? null) ? $index['launches'] : []) as $market) {
        if (strtolower((string) ($market['address'] ?? '')) === strtolower($token)) {
            $creator = strtolower((string) ($market['creator'] ?? ''));
            return preg_match('/^0x[a-f0-9]{40}$/', $creator) ? $creator : null;
        }
    }
    return null;
}
