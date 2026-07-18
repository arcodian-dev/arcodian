<?php
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
$storeDir = dirname(__DIR__) . '/data/reports';
if (!is_dir($storeDir) && !mkdir($storeDir, 0750, true)) { http_response_code(500); echo json_encode(['error'=>'Report storage unavailable']); exit; }
function reportToken(string $value): ?string { return preg_match('/^0x[a-fA-F0-9]{40}$/', $value) ? strtolower($value) : null; }
function canonicalReportToken(string $token): bool { $path=dirname(__DIR__).'/data/market-index.json'; $index=is_file($path)?json_decode((string)file_get_contents($path),true):null; foreach(is_array($index['launches']??null)?$index['launches']:[] as $market) if(strtolower((string)($market['address']??''))===$token)return true; return false; }
function allReports(string $dir): array { $items=[]; foreach(glob($dir.'/*.json')?:[] as $file){$row=json_decode((string)file_get_contents($file),true);if(is_array($row))$items[]=$row;} return $items; }
if ($_SERVER['REQUEST_METHOD']==='GET') { $groups=[]; foreach(allReports($storeDir) as $row){$token=(string)($row['token']??'');if(!$token)continue;if(!isset($groups[$token]))$groups[$token]=['token'=>$token,'count'=>0,'categories'=>[],'lastReportedAt'=>0];$category=(string)($row['category']??'other');$groups[$token]['count']++;$groups[$token]['categories'][$category]=($groups[$token]['categories'][$category]??0)+1;$groups[$token]['lastReportedAt']=max($groups[$token]['lastReportedAt'],(int)($row['timestamp']??0));}$tokens=array_values($groups);usort($tokens,fn($a,$b)=>$b['count']<=>$a['count']);echo json_encode(['tokens'=>$tokens,'total'=>array_sum(array_column($tokens,'count'))]);exit; }
if ($_SERVER['REQUEST_METHOD']!=='POST'){http_response_code(405);echo json_encode(['error'=>'GET or POST required']);exit;}
$body=json_decode((string)file_get_contents('php://input'),true);$token=reportToken((string)($body['token']??''));$category=(string)($body['category']??'');$detail=trim((string)($body['detail']??''));$allowed=['scam','impersonation','harmful-link','illegal','other'];
if($token===null||!canonicalReportToken($token)||!in_array($category,$allowed,true)||mb_strlen($detail)>240){http_response_code(422);echo json_encode(['error'=>'Invalid report']);exit;}
$now=time();$ip=$_SERVER['REMOTE_ADDR']??'unknown';$fingerprint=hash('sha256',gmdate('Y-m-d').'|'.$ip.'|'.($_SERVER['HTTP_USER_AGENT']??''));$reports=allReports($storeDir);
foreach($reports as $row)if(($row['token']??'')===$token&&($row['fingerprint']??'')===$fingerprint){http_response_code(409);echo json_encode(['error'=>'You already reported this token today']);exit;}
$recent=array_filter($reports,fn($row)=>($row['fingerprint']??'')===$fingerprint&&(int)($row['timestamp']??0)>$now-3600);if(count($recent)>=5){http_response_code(429);echo json_encode(['error'=>'Report limit reached']);exit;}
$id=bin2hex(random_bytes(12));$record=['id'=>$id,'token'=>$token,'category'=>$category,'detail'=>$detail,'timestamp'=>$now,'fingerprint'=>$fingerprint,'status'=>'open'];
if(file_put_contents($storeDir.'/'.$id.'.json',json_encode($record,JSON_UNESCAPED_SLASHES),LOCK_EX)===false){http_response_code(500);echo json_encode(['error'=>'Report could not be stored']);exit;}
http_response_code(201);echo json_encode(['ok'=>true,'id'=>$id]);
