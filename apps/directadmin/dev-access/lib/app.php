<?php
function h($v){return htmlspecialchars((string)$v,ENT_QUOTES|ENT_SUBSTITUTE,'UTF-8');}
function env_user(){return getenv('USERNAME') ?: (getenv('USER') ?: get_current_user());}
function directadmin_ssh_host_valid($host){
 if(!is_string($host)||$host===''||strlen($host)>253||trim($host)!==$host||strpos($host,"\0")!==false) return false;
 if(filter_var($host,FILTER_VALIDATE_IP,FILTER_FLAG_IPV4)!==false) return true;
 if(preg_match('/\A(?=.{1,253}\z)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\z/D',$host)!==1) return false;
 return true;
}
function directadmin_ssh_port_valid($port){
 if(!is_string($port)||preg_match('/^[0-9]{1,5}$/D',$port)!==1) return false;
 $value=(int)$port;
 return $value>=1&&$value<=65535;
}
function directadmin_ssh_connection_info(){
 $identity=directadmin_identity_context();
 $username=is_array($identity)?($identity['username']??''):'';
 if(!is_string($username)||preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/D',$username)!==1) $username='';
 $configuredHost=getenv('TITAN_DEV_ACCESS_SSH_HOST');
 $hostSource='configured';
 if($configuredHost===false||$configuredHost===''){
  $configuredHost=getenv('SERVER_NAME');
  if($configuredHost===false||$configuredHost==='') $configuredHost=$_SERVER['SERVER_NAME']??'';
  $hostSource='directadmin-panel-host';
 }
 $host=directadmin_ssh_host_valid($configuredHost)?$configuredHost:'';
 $configuredPort=getenv('TITAN_DEV_ACCESS_SSH_PORT');
 $portSource='configured';
 if($configuredPort===false||$configuredPort===''){
  $configuredPort='22';
  $portSource='default';
 }
 $port=directadmin_ssh_port_valid($configuredPort)?(string)(int)$configuredPort:'';
 return ['username'=>$username,'host'=>$host,'port'=>$port,'host_source'=>$hostSource,'port_source'=>$portSource];
}
function directadmin_ssh_connection_command($info){
 if(!is_array($info)||!directadmin_ssh_host_valid($info['host']??null)||!directadmin_ssh_port_valid($info['port']??null)||
    !is_string($info['username']??null)||preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/D',$info['username'])!==1) return '';
 return 'ssh -p '.(string)(int)$info['port'].' '.$info['username'].'@'.$info['host'];
}
function directadmin_identity_uid_allowed($uid){return is_int($uid)&&$uid>0;}
function directadmin_identity_context(){
 if(!function_exists('posix_geteuid')||!function_exists('posix_getpwuid')||!function_exists('posix_getpwnam')) return null;
 $uid=posix_geteuid(); $account=@posix_getpwuid($uid);
 if(!directadmin_identity_uid_allowed($uid)||!$account||!isset($account['name'],$account['dir'])) return null;
 $username=(string)(getenv('USERNAME') ?: getenv('USER') ?: '');
 if($username===''||preg_match('/^[A-Za-z0-9_.-]{1,128}$/D',$username)!==1) return null;
 $named=@posix_getpwnam($username);
 if(!$named||!isset($named['uid'])||(int)$named['uid']!==$uid) return null;
 $accountHome=realpath($account['dir']);
 if(!$accountHome||!is_dir($accountHome)) return null;
 $requestedHome=getenv('HOME');
 $home=($requestedHome!==false&&$requestedHome!=='')?realpath($requestedHome):$accountHome;
 if(!$home||!is_dir($home)||!path_within($home,$accountHome)) return null;
 $stat=@stat($home);
 if(!$stat||!isset($stat['uid'])||(int)$stat['uid']!==$uid) return null;
 return ['uid'=>$uid,'username'=>$username,'home'=>$home];
}
function home_dir(){
 if(PHP_SAPI==='cli'){
  $context=directadmin_identity_context();
  if($context!==null) return $context['home'];
  if(function_exists('posix_geteuid')&&function_exists('posix_getpwuid')){
   $account=@posix_getpwuid(posix_geteuid());
   if($account&&isset($account['dir'])) return $account['dir'];
  }
  return '/nonexistent';
 }
 $u=env_user(); $p=function_exists('posix_getpwnam')?@posix_getpwnam($u):false;
 return ($p&&isset($p['dir']))?$p['dir']:(getenv('HOME')?:'/tmp');
}
function csrf_secret_file(){ return home_dir().'/.titan-dev-access/csrf.key'; }
function csrf_secret(){
 $path=csrf_secret_file(); $dir=dirname($path);
 if(!is_dir($dir) && !@mkdir($dir,0700,true) && !is_dir($dir)) throw new RuntimeException('Unable to create CSRF directory.');
 @chmod($dir,0700);
 if(!is_file($path)){
  $secret=bin2hex(random_bytes(32)); $tmp=$path.'.tmp.'.getmypid();
  if(file_put_contents($tmp,$secret,LOCK_EX)===false) throw new RuntimeException('Unable to create CSRF secret.');
  @chmod($tmp,0600);
  if(!@rename($tmp,$path)){ @unlink($tmp); throw new RuntimeException('Unable to install CSRF secret.'); }
 }
 @chmod($path,0600);
 $secret=trim((string)@file_get_contents($path));
 if(strlen($secret)<32) throw new RuntimeException('Invalid CSRF secret.');
 return $secret;
}
function csrf(){ return hash_hmac('sha256','titan_dev_access_form_v2',csrf_secret()); }
function check_csrf(){
 $v=$_POST['csrf']??null;
 return is_string($v) && preg_match('/^[a-f0-9]{64}$/D',$v)===1 && hash_equals(csrf(),$v);
}
function post_string($name,$default=''){
 $v=$_POST[$name]??$default;
 return is_string($v)?$v:$default;
}
function directadmin_role_can_mutate($role){return $role==='admin'&&PHP_SAPI==='cli'&&directadmin_identity_context()!==null;}
function directadmin_post_field_names(){return ['csrf','cwd','command','run','public_key','add_key','remove_key','expected_fingerprint'];}
function directadmin_validate_post_fields($fields){
 if(!is_array($fields)||count($fields)>count(directadmin_post_field_names())) throw new RuntimeException('Invalid form fields.');
 $allowed=array_flip(directadmin_post_field_names()); $size=0;
 foreach($fields as $name=>$value){
  if(!is_string($name)||!isset($allowed[$name])||!is_string($value)) throw new RuntimeException('Invalid form field.');
  if(strpos($value,"\0")!==false||preg_match('//u',$value)!==1) throw new RuntimeException('Invalid form value.');
  $size+=strlen($name)+strlen($value);
  if($size>16384||strlen($value)>16384) throw new RuntimeException('Form data exceeds the limit.');
 }
 $actions=0;
 foreach(['run','add_key','remove_key'] as $action){
  if(!array_key_exists($action,$fields)) continue;
  $actions++;
  if($action==='remove_key'){
   if(preg_match('/^[0-9]{1,9}$/D',$fields[$action])!==1) throw new RuntimeException('Invalid form action.');
  }elseif($fields[$action]!=='1'){
   throw new RuntimeException('Invalid form action.');
  }
 }
 if($actions>1) throw new RuntimeException('Ambiguous form action.');
 $hasExpectedFingerprint=array_key_exists('expected_fingerprint',$fields);
 $hasRemoveKey=array_key_exists('remove_key',$fields);
 if($hasExpectedFingerprint!==$hasRemoveKey) throw new RuntimeException('Invalid form action.');
 return $fields;
}
function directadmin_parse_form_body($body){
 if(!is_string($body)||strlen($body)>16386) throw new RuntimeException('Form data exceeds the limit.');
 if($body!==''){
  if(substr($body,-2)==="\r\n") $body=substr($body,0,-2);
  elseif(substr($body,-1)==="\n") $body=substr($body,0,-1);
  if($body==='') throw new RuntimeException('Malformed form terminator.');
 }
 if(strlen($body)>16384) throw new RuntimeException('Form data exceeds the limit.');
 if(strpbrk($body,"\r\n")!==false) throw new RuntimeException('Malformed form terminator.');
 if($body==='') return [];
 $pairs=explode('&',$body);
 if(count($pairs)>count(directadmin_post_field_names())) throw new RuntimeException('Too many form fields.');
 $fields=[];
 foreach($pairs as $pair){
  if($pair===''||preg_match('/%(?![a-f0-9]{2})/i',$pair)) throw new RuntimeException('Malformed form encoding.');
  $equals=strpos($pair,'=');
  if($equals===false||$equals===0) throw new RuntimeException('Malformed form field.');
  $name=urldecode(substr($pair,0,$equals));
  $value=urldecode(substr($pair,$equals+1));
  if(array_key_exists($name,$fields)) throw new RuntimeException('Duplicate form field.');
  if($name===''||strpos($name,'[')!==false||strpos($name,']')!==false) throw new RuntimeException('Array form fields are not allowed.');
  $fields[$name]=$value;
 }
 return directadmin_validate_post_fields($fields);
}
function directadmin_form_content_length(){
 $raw=getenv('CONTENT_LENGTH');
 if($raw===false||$raw==='') return null;
 if(preg_match('/^[0-9]{1,5}$/D',(string)$raw)!==1) throw new RuntimeException('Invalid content length.');
 $length=(int)$raw;
 if($length>16384) throw new RuntimeException('Form data exceeds the limit.');
 return $length;
}
function directadmin_validate_form_content_type(){
 $type=getenv('CONTENT_TYPE');
 if($type!==false&&$type!==''&&preg_match('/^application\/x-www-form-urlencoded(?:\s*;|$)/i',trim((string)$type))!==1){
  throw new RuntimeException('Unsupported form content type.');
 }
}
function directadmin_request_error_code($exception){
 $message=$exception instanceof Throwable?$exception->getMessage():'';
 $codes=[
  'Invalid content length.'=>'content_length_invalid',
  'Form data exceeds the limit.'=>'body_oversized',
  'Unsupported form content type.'=>'content_type_invalid',
  'Query data exceeds the limit.'=>'query_oversized',
  'Malformed query encoding.'=>'query_malformed',
  'Form fields cannot be supplied in the query string.'=>'query_form_fields',
  'Unable to read request body.'=>'stdin_unavailable',
  'Request body length mismatch.'=>'body_length_mismatch',
  'Malformed form terminator.'=>'malformed_terminator',
  'Too many form fields.'=>'too_many_fields',
  'Malformed form encoding.'=>'form_malformed',
  'Malformed form field.'=>'form_malformed',
  'Duplicate form field.'=>'duplicate_field',
  'Array form fields are not allowed.'=>'array_field',
  'Invalid form fields.'=>'field_count_invalid',
  'Invalid form field.'=>'field_invalid',
  'Invalid form value.'=>'field_value_invalid',
  'Ambiguous form action.'=>'action_ambiguous',
  'Invalid form action.'=>'action_invalid',
  'Invalid DirectAdmin POST marker.'=>'post_marker_invalid',
  'Raw DirectAdmin POST body is unavailable.'=>'raw_post_missing'
 ];
 return is_string($message)&&isset($codes[$message])?$codes[$message]:'request_rejected';
}
function directadmin_request_declared_length_hint(){
 $raw=getenv('CONTENT_LENGTH');
 if(!is_string($raw)||preg_match('/^[0-9]{1,5}$/D',$raw)!==1) return null;
 $length=(int)$raw;
 return $length<=16384?$length:null;
}
function directadmin_request_diagnostic($exception){
 $transport=$_SERVER['TDA_REQUEST_TRANSPORT']??'unknown';
 if(!in_array($transport,['stdin','environment','query','marker','unavailable','unknown'],true)) $transport='unknown';
 $observed=$_SERVER['TDA_REQUEST_BODY_BYTES_READ']??null;
 if(!is_int($observed)||$observed<0||$observed>16387) $observed=null;
 $terminalClass=$_SERVER['TDA_REQUEST_TERMINAL_CLASS']??'unknown';
 if(!in_array($terminalClass,['empty','nul','lf','crlf','cr','control','high-bit','printable','unknown'],true)) $terminalClass='unknown';
 return [
  'code'=>directadmin_request_error_code($exception),
  'transport'=>$transport,
  'declared_bytes'=>directadmin_request_declared_length_hint(),
  'body_bytes_read'=>$observed,
  'terminal_class'=>$terminalClass
 ];
}
function directadmin_request_diagnostic_summary(){
 $diagnostic=$_SERVER['TDA_REQUEST_DIAGNOSTIC']??null;
 if(!is_array($diagnostic)) return 'code=request_rejected transport=unknown declared_bytes=unknown body_bytes_read=unknown terminal_class=unknown';
 $codes=['content_length_invalid','body_oversized','content_type_invalid','query_oversized','query_malformed','query_form_fields','stdin_unavailable','body_length_mismatch','malformed_terminator','too_many_fields','form_malformed','duplicate_field','array_field','field_count_invalid','field_invalid','field_value_invalid','action_ambiguous','action_invalid','post_marker_invalid','raw_post_missing','request_rejected'];
 $code=$diagnostic['code']??'request_rejected';
 if(!in_array($code,$codes,true)) $code='request_rejected';
 $transport=$diagnostic['transport']??'unknown';
 if(!in_array($transport,['stdin','environment','query','marker','unavailable','unknown'],true)) $transport='unknown';
 $declared=$diagnostic['declared_bytes']??null;
 if(!is_int($declared)||$declared<0||$declared>16384) $declared='unknown';
 $observed=$diagnostic['body_bytes_read']??null;
 if(!is_int($observed)||$observed<0||$observed>16387) $observed='unknown';
 $terminalClass=$diagnostic['terminal_class']??'unknown';
 if(!in_array($terminalClass,['empty','nul','lf','crlf','cr','control','high-bit','printable','unknown'],true)) $terminalClass='unknown';
 return 'code='.$code.' transport='.$transport.' declared_bytes='.$declared.' body_bytes_read='.$observed.' terminal_class='.$terminalClass;
}
function directadmin_request_body_length_matches($body,$expectedLength){
 if(!is_string($body)||($expectedLength!==null&&(!is_int($expectedLength)||$expectedLength<0))) return false;
 if($expectedLength===null||strlen($body)===$expectedLength) return true;
 if(strlen($body)===$expectedLength+1&&substr($body,-1)==="\n") return true;
 if(strlen($body)===$expectedLength+2&&substr($body,-2)==="\r\n") return true;
 return false;
}
function directadmin_normalize_stdin_transport_terminator($body,$expectedLength){
 if(!is_string($body)||$body===''||substr($body,-1)!=="\0") return $body;
 if($expectedLength!==null&&(!is_int($expectedLength)||$expectedLength<0)) return $body;
 $length=strlen($body);
 $prefix=substr($body,0,-1);
 if($prefix===''||strpos($prefix,"\0")!==false) return $body;
 if($expectedLength!==null&&$length!==$expectedLength+1) return $body;
 return $prefix;
}
function directadmin_request_terminal_byte_class($body){
 if(!is_string($body)||$body==='') return 'empty';
 $length=strlen($body);
 if($length>=2&&substr($body,-2)==="\r\n") return 'crlf';
 $last=ord($body[$length-1]);
 if($last===0) return 'nul';
 if($last===10) return 'lf';
 if($last===13) return 'cr';
 if($last<32||$last===127) return 'control';
 if($last>=128) return 'high-bit';
 return 'printable';
}
function directadmin_fields_from_stdin($expectedLength){
 directadmin_validate_form_content_type();
 $stream=@fopen('php://stdin','rb');
 if(!$stream) throw new RuntimeException('Unable to read request body.');
 $body=stream_get_contents($stream,16387);
 fclose($stream);
 if(!is_string($body)) throw new RuntimeException('Unable to read request body.');
 $_SERVER['TDA_REQUEST_BODY_BYTES_READ']=strlen($body);
 $_SERVER['TDA_REQUEST_TERMINAL_CLASS']=directadmin_request_terminal_byte_class($body);
 if(strlen($body)>16386) throw new RuntimeException('Form data exceeds the limit.');
 // Normalize one raw NUL only at the pipe_post stdin boundary and only when it is outside the declared form bytes.
 // The strict form parser still rejects interior, repeated, encoded, and invalid UTF-8 values.
 $body=directadmin_normalize_stdin_transport_terminator($body,$expectedLength);
 if(!directadmin_request_body_length_matches($body,$expectedLength)) throw new RuntimeException('Request body length mismatch.');
 return directadmin_parse_form_body($body);
}
function directadmin_fields_from_request(){
 $marker=getenv('POST');
 $_SERVER['TDA_REQUEST_TRANSPORT']=$marker==='stdin=true'?'stdin':(($marker!==false&&$marker!=='')?'environment':'unknown');
 $_SERVER['TDA_REQUEST_BODY_BYTES_READ']=null;
 $length=directadmin_form_content_length();
 directadmin_validate_form_content_type();
 $query=(string)(getenv('QUERY_STRING')?:'');
 if(strlen($query)>16384){
  $_SERVER['TDA_REQUEST_TRANSPORT']='query';
  throw new RuntimeException('Query data exceeds the limit.');
 }
 if($query!==''){
  $_SERVER['TDA_REQUEST_TRANSPORT']='query';
  foreach(explode('&',$query) as $pair){
   $rawName=explode('=',$pair,2)[0];
   if(preg_match('/%(?![a-f0-9]{2})/i',$rawName)) throw new RuntimeException('Malformed query encoding.');
   $queryName=strtolower(urldecode($rawName));
   foreach(directadmin_post_field_names() as $field){
    if($queryName===$field||strncmp($queryName,$field.'[',strlen($field)+1)===0) throw new RuntimeException('Form fields cannot be supplied in the query string.');
   }
  }
 }
 if($marker==='stdin=true'){
  $_SERVER['TDA_REQUEST_TRANSPORT']='stdin';
  return directadmin_fields_from_stdin($length);
 }
 if($marker!==false&&$marker!==''){
  if(strncmp($marker,'stdin=',6)===0){
   $_SERVER['TDA_REQUEST_TRANSPORT']='marker';
   throw new RuntimeException('Invalid DirectAdmin POST marker.');
  }
  $_SERVER['TDA_REQUEST_TRANSPORT']='environment';
  $_SERVER['TDA_REQUEST_BODY_BYTES_READ']=strlen($marker);
  $_SERVER['TDA_REQUEST_TERMINAL_CLASS']=directadmin_request_terminal_byte_class($marker);
  if(strlen($marker)>16386) throw new RuntimeException('Form data exceeds the limit.');
  if(!directadmin_request_body_length_matches($marker,$length)) throw new RuntimeException('Request body length mismatch.');
  return directadmin_parse_form_body($marker);
 }
 $_SERVER['TDA_REQUEST_TRANSPORT']='unavailable';
 throw new RuntimeException('Raw DirectAdmin POST body is unavailable.');
}
function bootstrap_directadmin_request($role='admin'){
 if(!in_array($role,['admin','reseller','user'],true)) $role='user';
 $_SERVER['TDA_ROLE']=$role;
 if(PHP_SAPI!=='cli') return;
 $method=strtoupper(trim((string)(getenv('REQUEST_METHOD')?:'GET')));
 $_POST=[]; $_SERVER['REQUEST_METHOD']=$method;
 unset($_SERVER['TDA_REQUEST_REJECTED'],$_SERVER['TDA_REQUEST_DIAGNOSTIC'],$_SERVER['TDA_REQUEST_TRANSPORT'],$_SERVER['TDA_REQUEST_BODY_BYTES_READ'],$_SERVER['TDA_REQUEST_TERMINAL_CLASS']);
 if(!in_array($method,['GET','POST'],true)){
  $_SERVER['REQUEST_METHOD']='POST'; $_SERVER['TDA_REQUEST_REJECTED']='input'; return;
 }
 if(directadmin_identity_context()===null){
  $_SERVER['TDA_REQUEST_REJECTED']='context'; return;
 }
 if($method!=='POST') return;
 if(!directadmin_role_can_mutate($role)){
  $_SERVER['TDA_REQUEST_REJECTED']='role'; return;
 }
 try{$_POST=directadmin_fields_from_request();}
 catch(Throwable $e){$_POST=[];$_SERVER['TDA_REQUEST_DIAGNOSTIC']=directadmin_request_diagnostic($e);$_SERVER['TDA_REQUEST_REJECTED']='input';}
}
function key_dir(){return home_dir().'/.ssh';}
function key_file(){return key_dir().'/authorized_keys';}
function directadmin_ssh_blob_read_string($blob,&$offset){
 if(!is_string($blob)||!is_int($offset)) return null;
 $total=strlen($blob);
 if($offset<0||$offset>$total||$total-$offset<4) return null;
 $header=unpack('Nlength',substr($blob,$offset,4));
 if(!is_array($header)||!isset($header['length'])) return null;
 $offset+=4;
 $length=$header['length'];
 if(!is_int($length)||$length<0||$length>$total-$offset) return null;
 $value=substr($blob,$offset,$length);
 $offset+=$length;
 return $value;
}
function directadmin_ssh_blob_valid_positive_mpint($value){
 if(!is_string($value)||$value==='') return false;
 $length=strlen($value);
 $first=ord($value[0]);
 if(($first&0x80)!==0) return false;
 if($first===0&&($length===1||(ord($value[1])&0x80)===0)) return false;
 return true;
}
function valid_pubkey($k){
 if(!is_string($k)||strpos($k,"\0")!==false) return false;
 $line=trim($k);
 if($line===''||strpos($line,"\r")!==false||strpos($line,"\n")!==false) return false;
 if(preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/',$line)===1) return false;
 if(preg_match('/\A(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))[ \t]+([A-Za-z0-9+\/]+={0,2})(?:[ \t]+[^\r\n]*)?\z/D',$line,$matches)!==1) return false;
 $blob=base64_decode($matches[2],true);
 if(!is_string($blob)||base64_encode($blob)!==$matches[2]) return false;
 $offset=0;
 $blobType=directadmin_ssh_blob_read_string($blob,$offset);
 if($blobType!==$matches[1]) return false;
 if($matches[1]==='ssh-ed25519'){
  $public=directadmin_ssh_blob_read_string($blob,$offset);
  if(!is_string($public)||strlen($public)!==32) return false;
 }elseif($matches[1]==='ssh-rsa'){
  $exponent=directadmin_ssh_blob_read_string($blob,$offset);
  $modulus=directadmin_ssh_blob_read_string($blob,$offset);
  if(!directadmin_ssh_blob_valid_positive_mpint($exponent)||!directadmin_ssh_blob_valid_positive_mpint($modulus)) return false;
 }else{
  $curve=directadmin_ssh_blob_read_string($blob,$offset);
  $point=directadmin_ssh_blob_read_string($blob,$offset);
  $expectedCurve=substr($matches[1],strlen('ecdsa-sha2-'));
  $pointLengths=['nistp256'=>65,'nistp384'=>97,'nistp521'=>133];
  if($curve!==$expectedCurve||!is_string($point)||strlen($point)!==$pointLengths[$expectedCurve]||$point[0]!=="\x04") return false;
 }
 return $offset===strlen($blob);
}
function ensure_ssh(){
 $identity=directadmin_identity_context();
 if(!is_array($identity)||!isset($identity['uid'],$identity['home'])) throw new RuntimeException('DirectAdmin execution identity is unavailable.');
 $uid=(int)$identity['uid'];$home=realpath($identity['home']);$directory=key_dir();
 if($uid<=0||!$home||is_link($directory)) throw new RuntimeException('SSH key storage path is unsafe.');
 if(!is_dir($directory)&&!@mkdir($directory,0700)) throw new RuntimeException('Unable to create .ssh directory.');
 clearstatcache(true,$directory);$directoryStat=@lstat($directory);$realDirectory=realpath($directory);
 if(!$directoryStat||(($directoryStat['mode']&0170000)!==0040000)||(int)$directoryStat['uid']!==$uid||$realDirectory!==$home.'/.ssh'||!@chmod($directory,0700)) throw new RuntimeException('SSH key storage path is unsafe.');
 $file=key_file();$fileStat=@lstat($file);
 if($fileStat===false){
  $created=@fopen($file,'x+b');
  if(is_resource($created)){@fclose($created);if(!@chmod($file,0600)) throw new RuntimeException('Unable to secure authorized_keys permissions.');}
  clearstatcache(true,$file);$fileStat=@lstat($file);
 }
 if(!$fileStat||(($fileStat['mode']&0170000)!==0100000)||(int)$fileStat['uid']!==$uid||is_link($file)||!@chmod($file,0600)) throw new RuntimeException('authorized_keys is not a safe regular file.');
 return true;
}
function directadmin_authorized_keys_lines($contents){
 if(!is_string($contents)||$contents==='') return [];
 $lines=preg_split('/\r\n|\n/',$contents);
 if($lines===false) return [];
 if($lines&&end($lines)==='') array_pop($lines);
 return $lines;
}
function directadmin_authorized_key_ignored_line($line){
 if(!is_string($line)) return false;
 $content=ltrim($line," \t");
 return $content===''||$content[0]==='#';
}
function directadmin_authorized_key_prefix_token($line,&$offset){
 $length=strlen($line);
 while($offset<$length&&($line[$offset]===' '||$line[$offset]==="\t"))$offset++;
 if($offset>=$length)return null;
 $token='';$quoted=false;$escaped=false;
 for(;$offset<$length;$offset++){
  $char=$line[$offset];
  if($escaped){$token.=$char;$escaped=false;continue;}
  if($quoted&&$char==='\\'){$token.=$char;$escaped=true;continue;}
  if($char==='"'){$quoted=!$quoted;$token.=$char;continue;}
  if(!$quoted&&($char===' '||$char==="\t"))break;
  if(preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/',$char)===1)return null;
  $token.=$char;
 }
 if($quoted||$escaped||$token==='')return null;
 return $token;
}
function directadmin_authorized_key_identity($line){
 if(!is_string($line)||$line===''||strlen($line)>16384||strpos($line,"\0")!==false||directadmin_authorized_key_ignored_line($line)) return null;
 $offset=0;$first=directadmin_authorized_key_prefix_token($line,$offset);if(!is_string($first))return null;
 $second=directadmin_authorized_key_prefix_token($line,$offset);if(!is_string($second))return null;
 $algorithms=['ssh-ed25519','ssh-rsa'];
 foreach(['nistp256','nistp384','nistp521'] as $curve)$algorithms[]='ecdsa-sha2-'.$curve;
 if(in_array($first,$algorithms,true)){$algorithm=$first;$blobToken=$second;}
 else{$algorithm=$second;$blobToken=directadmin_authorized_key_prefix_token($line,$offset);}
 if(!in_array($algorithm,$algorithms,true)||!is_string($blobToken)||!valid_pubkey($algorithm.' '.$blobToken)) return null;
 $blob=base64_decode($blobToken,true);
 if(!is_string($blob)) return null;
 return ['identity'=>$algorithm.':'.hash('sha256',$blob),'fingerprint'=>'SHA256:'.rtrim(base64_encode(hash('sha256',$blob,true)),'=')];
}
function directadmin_authorized_keys_lock(){
 ensure_ssh();
 $path=key_dir().'/.authorized_keys.lock';$stat=@lstat($path);
 if($stat===false){
  $created=@fopen($path,'x+b');
  if(is_resource($created)){@fclose($created);if(!@chmod($path,0600)) throw new RuntimeException('Unable to secure authorized_keys lock.');}
  clearstatcache(true,$path);$stat=@lstat($path);
 }
 $identity=directadmin_identity_context();$uid=is_array($identity)?(int)($identity['uid']??-1):-1;
 if(!$stat||$uid<=0||(($stat['mode']&0170000)!==0100000)||(int)$stat['uid']!==$uid||is_link($path)) throw new RuntimeException('authorized_keys lock path is unsafe.');
 $handle=@fopen($path,'r+b');
 if(!is_resource($handle)) throw new RuntimeException('Unable to lock authorized_keys.');
 $opened=@fstat($handle);$current=@lstat($path);
 if(!$opened||!$current||(($opened['mode']&0170000)!==0100000)||(int)$opened['uid']!==$uid||$opened['dev']!==$current['dev']||$opened['ino']!==$current['ino']||!@chmod($path,0600)||!@flock($handle,LOCK_EX)){
  @fclose($handle);throw new RuntimeException('Unable to lock authorized_keys.');
 }
 clearstatcache(true,$path);$after=@lstat($path);$locked=@fstat($handle);
 if(!$after||!$locked||is_link($path)||$after['dev']!==$locked['dev']||$after['ino']!==$locked['ino']||(int)$after['uid']!==$uid){@flock($handle,LOCK_UN);@fclose($handle);throw new RuntimeException('authorized_keys lock changed unexpectedly.');}
 return $handle;
}
function directadmin_authorized_keys_read(){
 $path=key_file();$before=@lstat($path);$identity=directadmin_identity_context();$uid=is_array($identity)?(int)($identity['uid']??-1):-1;
 if(!$before||$uid<=0||is_link($path)||(($before['mode']&0170000)!==0100000)||(int)$before['uid']!==$uid) throw new RuntimeException('authorized_keys is not a safe regular file.');
 $handle=@fopen($path,'rb');
 if(!is_resource($handle)) throw new RuntimeException('Unable to read authorized_keys.');
 $opened=@fstat($handle);$current=@lstat($path);
 if(!$opened||!$current||$opened['dev']!==$before['dev']||$opened['ino']!==$before['ino']||$current['dev']!==$opened['dev']||$current['ino']!==$opened['ino']||(int)$opened['uid']!==$uid){@fclose($handle);throw new RuntimeException('authorized_keys changed unexpectedly.');}
 $contents=@stream_get_contents($handle,1048577);@fclose($handle);
 if(!is_string($contents)||strlen($contents)>1048576) throw new RuntimeException('authorized_keys exceeds the supported size.');
 $before['content_sha256']=hash('sha256',$contents);
 return [$contents,$before];
}
function directadmin_authorized_keys_write_atomic($contents,$expectedStat){
 if(!is_string($contents)||strlen($contents)>1048576||!is_array($expectedStat)||!is_string($expectedStat['content_sha256']??null)) return false;
 $directory=realpath(key_dir());$path=key_file();$current=@lstat($path);$identity=directadmin_identity_context();$uid=is_array($identity)?(int)($identity['uid']??-1):-1;
 if(!$directory||$uid<=0||!$current||is_link($path)||(($current['mode']&0170000)!==0100000)||(int)$current['uid']!==$uid||$current['dev']!==$expectedStat['dev']||$current['ino']!==$expectedStat['ino']) return false;
 $temporary=@tempnam($directory,'.authorized_keys.');
 if(!is_string($temporary)||realpath(dirname($temporary))!==$directory){if(is_string($temporary))@unlink($temporary);return false;}
 $handle=@fopen($temporary,'wb');
 if(!is_resource($handle)){@unlink($temporary);return false;}
 $ok=@chmod($temporary,0600);$offset=0;$length=strlen($contents);
 while($ok&&$offset<$length){$written=@fwrite($handle,substr($contents,$offset));if(!is_int($written)||$written<=0){$ok=false;break;}$offset+=$written;}
 if($ok)$ok=@fflush($handle);
 if($ok&&function_exists('fsync'))$ok=@fsync($handle);
 if(!@fclose($handle))$ok=false;
 clearstatcache(true,$temporary);$tempStat=@lstat($temporary);
 if(!$ok||!$tempStat||(($tempStat['mode']&0170000)!==0100000)||(int)$tempStat['uid']!==$uid||(($tempStat['mode']&0777)!==0600)){@unlink($temporary);return false;}
 try{[$latestContents,$latestStat]=directadmin_authorized_keys_read();}catch(Throwable $e){@unlink($temporary);return false;}
 clearstatcache(true,$path);$beforeRename=@lstat($path);
 if(!hash_equals($expectedStat['content_sha256'],hash('sha256',$latestContents))||$latestStat['dev']!==$expectedStat['dev']||$latestStat['ino']!==$expectedStat['ino']||!$beforeRename||is_link($path)||$beforeRename['dev']!==$expectedStat['dev']||$beforeRename['ino']!==$expectedStat['ino']||!@rename($temporary,$path)){@unlink($temporary);return false;}
 clearstatcache(true,$path);$final=@lstat($path);
 return $final!==false&&!is_link($path)&&(($final['mode']&0170000)===0100000)&&(int)$final['uid']===$uid&&(($final['mode']&0777)===0600);
}
function add_key($k){
 $k=is_string($k)?trim($k):'';
 if(!valid_pubkey($k)) return 'Invalid public key format.';
 $lock=null;
 try{
  $lock=directadmin_authorized_keys_lock();[$contents,$stat]=directadmin_authorized_keys_read();$incoming=directadmin_authorized_key_identity($k);
  if(!$incoming) return 'Invalid public key format.';
  foreach(directadmin_authorized_keys_lines($contents) as $line){$existing=directadmin_authorized_key_identity($line);if($existing&&$existing['identity']===$incoming['identity'])return 'Key already installed.';}
  $updated=$contents;if($updated!==''&&substr($updated,-1)!=="\n")$updated.="\n";$updated.=$k."\n";
  if(!directadmin_authorized_keys_write_atomic($updated,$stat))return 'Unable to update authorized_keys safely.';
  return 'Public key installed.';
 }catch(Throwable $e){return 'Unable to update authorized_keys safely.';}
 finally{if(is_resource($lock)){@flock($lock,LOCK_UN);@fclose($lock);}}
}
function remove_key($idx,$expectedFingerprint){
 if(!is_int($idx)||$idx<0) return 'Key not found.';
 if(!is_string($expectedFingerprint)||preg_match('/\ASHA256:[A-Za-z0-9+\/]{43}\z/D',$expectedFingerprint)!==1)return 'Key list changed; reload before revoking.';
 $lock=null;
 try{
  $lock=directadmin_authorized_keys_lock();[$contents,$stat]=directadmin_authorized_keys_read();$lines=directadmin_authorized_keys_lines($contents);$visible=[];
  foreach($lines as $line)if(!directadmin_authorized_key_ignored_line($line))$visible[]=$line;
  if(!isset($visible[$idx]))return 'Key not found.';
  $targetIdentity=directadmin_authorized_key_identity($visible[$idx]);
  if(!$targetIdentity||!hash_equals($expectedFingerprint,$targetIdentity['fingerprint']))return 'Key list changed; reload before revoking.';
  $remaining=[];$removed=false;
  foreach($lines as $line){
   if(directadmin_authorized_key_ignored_line($line)){$remaining[]=$line;continue;}
   $identity=directadmin_authorized_key_identity($line);
   if($identity&&hash_equals($targetIdentity['identity'],$identity['identity'])){$removed=true;continue;}
   $remaining[]=$line;
  }
  if(!$removed)return 'Key not found.';
  $updated=$remaining?implode("\n",$remaining)."\n":'';
  if(!directadmin_authorized_keys_write_atomic($updated,$stat))return 'Unable to update authorized_keys safely.';
  return 'Key revoked.';
 }catch(Throwable $e){return 'Unable to update authorized_keys safely.';}
 finally{if(is_resource($lock)){@flock($lock,LOCK_UN);@fclose($lock);}}
}
function fingerprints(){
 ensure_ssh();$contents=@file_get_contents(key_file());if(!is_string($contents)||strlen($contents)>1048576)throw new RuntimeException('Unable to read authorized_keys safely.');
 $out=[];$index=0;foreach(directadmin_authorized_keys_lines($contents) as $line){if(directadmin_authorized_key_ignored_line($line))continue;$identity=directadmin_authorized_key_identity($line);$out[]=[$index++,$identity?$identity['fingerprint']:'fingerprint unavailable'];}
 return $out;
}
function path_within($path,$root){
 $path=rtrim(str_replace('\\','/',(string)$path),'/'); $root=rtrim(str_replace('\\','/',(string)$root),'/');
 return $path===$root || ($root!=='' && strncmp($path,$root.'/',strlen($root)+1)===0);
}
function safe_cwd($requested){
 $home=realpath(home_dir())?:home_dir();
 $requested=is_string($requested)?trim($requested):'';
 $cwd=$requested!==''?realpath($requested):$home;
 if(!$cwd || !is_dir($cwd) || !path_within($cwd,$home)) return $home;
 return $cwd;
}
function directadmin_terminal_sensitive_component($component){
 if(!is_string($component)||$component==='') return false;
 $name=strtolower($component);
 if(in_array($name,[
  '.ssh','.aws','.azure','.config','.docker','.gnupg','.kube','.npm','.composer','.pki','.terraform','.vault','.titan-dev-access',
  '.git','.hg','.svn','.env','.netrc','.npmrc','.pypirc','.gitconfig','.git-credentials','.my.cnf','.pgpass','.bash_history','.zsh_history',
  'auth.json','credentials.json','authorized_keys','authorized_keys2','.bashrc','.profile','.bash_profile','.zshrc','.zprofile','.zshenv'
 ],true)) return true;
 if(strncmp($name,'.env.',5)===0) return true;
 if(substr($name,-4)==='.env') return true;
 if(preg_match('/^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/D',$name)===1) return true;
 if(preg_match('/^(?:authorized_keys|authorized_keys2)(?:$|[._-])/D',$name)===1) return true;
 if(preg_match('/(?:^|[._-])(?:secrets?|tokens?|credentials?|passwords?|passwd|private[-_]?key)(?:[._-]|$)/D',$name)===1) return true;
 return preg_match('/\.(?:pem|key|p12|pfx|ppk|p8|jks|keystore)$/D',$name)===1;
}
function directadmin_terminal_path_components_safe($path,$home,$base,$expectedType,$allowAbsolute=false){
 if(!is_string($path)||$path===''||strlen($path)>4096||strpos($path,"\0")!==false||strpos($path,'\\')!==false) return null;
 if(preg_match('/[\x00-\x20\x7f*?\[\]{}$`"\']/', $path)===1) return null;
 $home=realpath($home);$base=realpath($base);
 if($home===false||$base===false||!is_dir($home)||!is_dir($base)||!path_within($base,$home)||directadmin_terminal_sensitive_component(basename($base))) return null;
 $absolute=strpos($path,'/')===0;
 if($absolute){
  if(!$allowAbsolute||!path_within($path,$home)) return null;
  $relative=$path===$home?'':substr($path,strlen($home)+1);
  $current=$home;
 }else{
  if($path[0]==='~'||$path[0]==='-') return null;
  $relative=$path;
  $current=$base;
 }
 $segments=$relative===''?[]:explode('/',$relative);
 foreach($segments as $index=>$segment){
  if($segment===''||$segment==='..') return null;
  if($segment==='.') continue;
  if(directadmin_terminal_sensitive_component($segment)) return null;
  $current.='/'.$segment;
  $stat=@lstat($current);
  if(!is_array($stat)) return null;
  $type=$stat['mode']&0170000;
  if($type===0120000) return null;
  $last=$index===count($segments)-1;
  if(!$last&&$type!==0040000) return null;
  if($last){
   $matches=$expectedType==='file'?$type===0100000:($expectedType==='directory'?$type===0040000:in_array($type,[0040000,0100000],true));
   if(!$matches) return null;
   if($type===0100000&&(!isset($stat['nlink'])||(int)$stat['nlink']!==1)) return null;
  }
 }
 $resolved=realpath($current);
 if($resolved===false||$resolved!==$current||!path_within($resolved,$home)||directadmin_terminal_path_sensitive($resolved)) return null;
 $finalStat=@lstat($resolved);
 if(!is_array($finalStat)) return null;
 $finalType=$finalStat['mode']&0170000;
 if($expectedType==='file'&&$finalType!==0100000) return null;
 if($expectedType==='directory'&&$finalType!==0040000) return null;
 if($expectedType==='either'&&!in_array($finalType,[0040000,0100000],true)) return null;
 if($finalType===0100000&&(!isset($finalStat['nlink'])||(int)$finalStat['nlink']!==1)) return null;
 return $resolved;
}
function directadmin_terminal_path_sensitive($path){
 if(!is_string($path)||$path==='') return true;
 foreach(explode('/',str_replace('\\','/',$path)) as $component){
  if(directadmin_terminal_sensitive_component($component)) return true;
 }
 return false;
}
function directadmin_terminal_cwd($requested){
 $home=realpath(home_dir());
 if($home===false) return null;
 $requested=is_string($requested)?trim($requested):'';
 if($requested==='') $requested=$home;
 elseif(strpos($requested,'/')!==0) $requested=$home.'/'.$requested;
 return directadmin_terminal_path_components_safe($requested,$home,$home,'directory',true);
}
function directadmin_terminal_restore_cwd($restore){
 if(is_string($restore)&&$restore!==''&&@chdir($restore)) return true;
 $home=realpath(home_dir());
 return $home!==false&&@chdir($home);
}
/**
 * Pin the validated directory as this request's cwd before starting a child.
 * proc_open's string cwd would resolve the pathname again after validation.
 */
function directadmin_terminal_enter_verified_cwd($path){
 if(!is_string($path)||$path===''||strlen($path)>4096) return null;
 $home=realpath(home_dir());
 if($home===false||!path_within($path,$home)||directadmin_terminal_path_sensitive($path)||realpath($path)!==$path) return null;
 $before=@lstat($path);
 if(!is_array($before)||(($before['mode']&0170000)!==0040000)) return null;
 $restore=getcwd();
 if(!is_string($restore)||$restore===''||!@chdir($path)) return null;
 $actual=getcwd();
 $opened=@stat('.');
 $named=@lstat($path);
 $matches=$actual===$path&&is_array($opened)&&is_array($named)
  &&(($opened['mode']&0170000)===0040000)&&(($named['mode']&0170000)===0040000)
  &&(string)$opened['dev']===(string)$before['dev']&&(string)$opened['ino']===(string)$before['ino']
  &&(string)$named['dev']===(string)$before['dev']&&(string)$named['ino']===(string)$before['ino']
  &&path_within($actual,$home);
 if(!$matches){directadmin_terminal_restore_cwd($restore);return null;}
 return $restore;
}
function directadmin_terminal_checked_arguments($parts,$cwd){
 if(!is_array($parts)||!isset($parts[0])||!is_string($parts[0])) return null;
 [$class,$reason,$allowed]=command_policy(implode(' ',$parts));
 if(!$allowed)return null;
 $parts[0]=strtolower($parts[0]);
 return $parts;
}
function directadmin_git_metadata_path_safe($path,$home,$expectDirectory){
 $stat=@lstat($path);
 if($stat===false) return true;
 $resolved=realpath($path);
 if($resolved===false||!path_within($resolved,$home)) return false;
 return $expectDirectory?is_dir($resolved):is_file($resolved);
}
/**
 * Git follows nested paths under refs and objects. Fail closed on every
 * metadata symlink and bound the scan so a large repository cannot stall a request.
 */
function directadmin_git_metadata_tree_safe($directory,$home,$entryLimit=65536){
 if(!is_int($entryLimit)||$entryLimit<1||$entryLimit>65536) return false;
 $resolvedRoot=realpath($directory);
 $rootStat=@lstat($directory);
 if($resolvedRoot===false||!path_within($resolvedRoot,$home)||$rootStat===false||(($rootStat['mode']&0170000)!==0040000)) return false;
 $pending=[$resolvedRoot];
 $visited=0;
 while($pending){
  $current=array_pop($pending);
  $handle=@opendir($current);
  if($handle===false) return false;
  try{
   while(($entry=@readdir($handle))!==false){
    if($entry==='.'||$entry==='..') continue;
    if(++$visited>$entryLimit) return false;
    $child=$current.'/'.$entry;
    $stat=@lstat($child);
    if($stat===false) return false;
    $type=$stat['mode']&0170000;
    if($type===0120000) return false;
    if($type===0040000){
     $resolved=realpath($child);
     if($resolved===false||!path_within($resolved,$home)) return false;
     $pending[]=$resolved;
     continue;
    }
    if($type!==0100000) return false;
   }
  }finally{
   @closedir($handle);
  }
 }
 return true;
}
function directadmin_git_resolve_path($path,$base,$home,$expectDirectory){
 if(!is_string($path)||$path===''||strpos($path,"\0")!==false) return null;
 $candidate=$path[0]==='/'?$path:rtrim($base,'/').'/'.$path;
 $resolved=realpath($candidate);
 if($resolved===false||!path_within($resolved,$home)) return null;
 if($expectDirectory?!is_dir($resolved):!is_file($resolved)) return null;
 return $resolved;
}
function directadmin_git_read_pointer($file,$label,$base,$home,$expectDirectory){
 if(!directadmin_git_metadata_path_safe($file,$home,false)) return null;
 $resolvedFile=realpath($file);
 if($resolvedFile===false||!is_file($resolvedFile)||!path_within($resolvedFile,$home)) return null;
 $raw=@file_get_contents($resolvedFile,false,null,0,4097);
 if(!is_string($raw)||strlen($raw)>4096||strpos($raw,"\0")!==false) return null;
 if(in_array($label,['commondir','worktree-gitdir'],true)){
  // Git stores linked worktree commondir and reverse gitdir pointers as bare paths.
  $pattern='/\\A([^\\r\\n]+)(?:\\r?\\n)?\\z/D';
 }else{
  $pattern='/\\A'.preg_quote($label,'/').': ([^\\r\\n]+)(?:\\r?\\n)?\\z/D';
 }
 if(preg_match($pattern,$raw,$matches)!==1) return null;
 return directadmin_git_resolve_path($matches[1],$base,$home,$expectDirectory);
}
function directadmin_git_filter_names($context){
 if(!is_array($context)||!isset($context['git_dir'],$context['common_dir'])) return null;
 $paths=[];
 foreach([$context['git_dir'].'/config',$context['git_dir'].'/config.worktree',$context['common_dir'].'/config'] as $path){
  if(in_array($path,$paths,true)) continue;
  $paths[]=$path;
  if(@lstat($path)===false) continue;
  $contents=@file_get_contents($path);
  if(!is_string($contents)||strlen($contents)>1048576) return null;
  // Included config can introduce filter commands after this check. Refuse it
  // rather than trying to model Git's include resolution at request time.
  if(preg_match('/^\s*(?:include(?:If)?\.|\[include(?:If)?(?:\s+"[^"]*")?\])\s*/mi',$contents)===1) return null;
  $sections=[];
  if(preg_match_all('/^\s*\[filter\s+"([^"]*)"\]\s*$/mi',$contents,$sections)===false) return null;
  foreach($sections[1]??[] as $name){
   if(!preg_match('/\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z/D',$name)) return null;
   $names[$name]=true;
  }
  $matches=[];
  if(preg_match_all('/^\s*filter\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.(?:process|clean|smudge|required)\s*=/mi',$contents,$matches)===false) return null;
  foreach($matches[1]??[] as $name) $names[$name]=true;
 }
 return array_keys($names??[]);
}
function directadmin_git_filter_config_args($context){
 $names=directadmin_git_filter_names($context);
 if($names===null) return null;
 $args=[];
 foreach($names as $name){
  foreach(['process','clean','smudge'] as $operation){$args[]='-c';$args[]='filter.'.$name.'.'.$operation.'=';}
  $args[]='-c';$args[]='filter.'.$name.'.required=false';
 }
 return $args;
}
function directadmin_git_alternates_safe($objects,$home){
 if(@lstat($objects)===false) return true;
 if(!directadmin_git_metadata_path_safe($objects,$home,true)) return false;
 $objectsReal=realpath($objects);
 if($objectsReal===false) return false;
 $info=$objectsReal.'/info';
 if(!directadmin_git_metadata_path_safe($info,$home,true)){
  if(@lstat($info)===false) return true;
  return false;
 }
 $alternates=$info.'/alternates';
 if(!directadmin_git_metadata_path_safe($alternates,$home,false)){
  if(@lstat($alternates)===false) return true;
  return false;
 }
 if(@lstat($alternates)===false) return true;
 $resolvedAlternates=realpath($alternates);
 if($resolvedAlternates===false) return false;
 $raw=@file_get_contents($resolvedAlternates,false,null,0,16385);
 if(!is_string($raw)||strlen($raw)>16384||strpos($raw,"\0")!==false) return false;
 if($raw==='') return true;
 $lines=preg_split('/\r?\n/',$raw);
 if(!$lines) return false;
 if(end($lines)==='') array_pop($lines);
 foreach($lines as $line){
  if($line===''||strpos($line,"\r")!==false) return false;
  if(directadmin_git_resolve_path($line,$objectsReal,$home,true)===null) return false;
 }
 return true;
}
function directadmin_git_repository_context($requested){
 $home=realpath(home_dir());
 if($home===false||!is_dir($home)) return null;
 $directory=safe_cwd($requested);
 if(!path_within($directory,$home)) return null;
 $cursor=$directory;
 while(path_within($cursor,$home)){
  $gitEntry=$cursor.'/.git';
  if(@lstat($gitEntry)!==false){
   if(is_dir($gitEntry)){
    $gitDirectory=realpath($gitEntry);
    if($gitDirectory===false||!path_within($gitDirectory,$home)) return null;
   }else{
    $gitDirectory=directadmin_git_read_pointer($gitEntry,'gitdir',$cursor,$home,true);
    if($gitDirectory===null) return null;
   }
   $commonDirectory=$gitDirectory;
   $commonPointer=$gitDirectory.'/commondir';
   if(@lstat($commonPointer)!==false){
    $commonDirectory=directadmin_git_read_pointer($commonPointer,'commondir',$gitDirectory,$home,true);
    if($commonDirectory===null) return null;
   }
   $worktreePointer=$gitDirectory.'/gitdir';
   if(@lstat($worktreePointer)!==false){
    $backPointer=directadmin_git_read_pointer($worktreePointer,'worktree-gitdir',$gitDirectory,$home,false);
    $expectedEntry=realpath($gitEntry);
    if($backPointer===null||$expectedEntry===false||$backPointer!==$expectedEntry) return null;
   }
   foreach(array_values(array_unique([$gitDirectory,$commonDirectory])) as $metadataDirectory){
    if(!directadmin_git_metadata_tree_safe($metadataDirectory,$home)) return null;
    foreach(['HEAD','config','packed-refs','index','shallow','commondir','gitdir'] as $file){
     if(!directadmin_git_metadata_path_safe($metadataDirectory.'/'.$file,$home,false)) return null;
    }
    foreach(['objects','refs','logs'] as $subdirectory){
     $path=$metadataDirectory.'/'.$subdirectory;
     if(!directadmin_git_metadata_path_safe($path,$home,true)&&@lstat($path)!==false) return null;
    }
    if(!directadmin_git_alternates_safe($metadataDirectory.'/objects',$home)) return null;
   }
   return ['root'=>$cursor,'git_dir'=>$gitDirectory,'common_dir'=>$commonDirectory];
  }
  $parent=dirname($cursor);
  if($parent===$cursor||!path_within($parent,$home)) break;
  $cursor=$parent;
 }
 return null;
}
function directadmin_git_command_args($context,$arguments){
 $subcommand=$arguments[0]??null;
 if(in_array($subcommand,['diff','show'],true)){
  foreach(['--no-textconv','--no-ext-diff'] as $flag){
   if(!in_array($flag,$arguments,true)) $arguments[]=$flag;
  }
 }
  $filterArgs=directadmin_git_filter_config_args($context);
  if($filterArgs===null) return null;
  return array_merge([
  'git',
  '--git-dir',$context['git_dir'],
  '--work-tree',$context['root'],
  '-c','core.bare=false',
  '-c','core.worktree='.$context['root'],
  '-c','core.hooksPath=/dev/null',
  '-c','core.fsmonitor=false',
  '-c','credential.helper=',
  '-c','diff.external=',
  '--no-pager'
  ],$filterArgs,$arguments);
}
function directadmin_git_environment(){
 return [
  'PATH'=>'/usr/local/bin:/usr/bin:/bin',
  'HOME'=>home_dir(),
  'GIT_CONFIG_NOSYSTEM'=>'1',
  'GIT_CONFIG_GLOBAL'=>'/dev/null',
  'GIT_OPTIONAL_LOCKS'=>'0',
  'GIT_NO_LAZY_FETCH'=>'1',
  'GIT_TERMINAL_PROMPT'=>'0',
  'GIT_PAGER'=>'cat',
  'PAGER'=>'cat'
 ];
}
function directadmin_git_probe($context,$arguments){
 $commandArguments=directadmin_git_command_args($context,$arguments);
 if($commandArguments===null) return ['status'=>'unknown','output'=>null,'reason'=>'unsafe_filter_config'];
 $argv=array_merge(['/usr/bin/env','timeout','5s'],$commandArguments);
 $spec=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
 $restore=directadmin_terminal_enter_verified_cwd($context['root']??null);
 if($restore===null) return ['status'=>'unknown','output'=>null,'reason'=>'cwd_changed'];
 try{
  $proc=@proc_open($argv,$spec,$pipes,null,directadmin_git_environment(),['bypass_shell'=>true]);
  if(!is_resource($proc)) return ['status'=>'unknown','output'=>null,'reason'=>'spawn_failed'];
  fclose($pipes[0]);
  $out=stream_get_contents($pipes[1],8193);
  $err=stream_get_contents($pipes[2],8193);
  fclose($pipes[1]); fclose($pipes[2]);
  $rc=proc_close($proc);
  if(!is_string($out)||!is_string($err)) return ['status'=>'unknown','output'=>null,'reason'=>'output_read_failed'];
  if(strlen($out)>8192||strlen($err)>8192) return ['status'=>'unknown','output'=>null,'reason'=>'output_oversized'];
  if(in_array($rc,[124,137,143],true)) return ['status'=>'unknown','output'=>null,'reason'=>'timeout'];
  if($rc!==0) return ['status'=>'unknown','output'=>null,'reason'=>'command_failed'];
  return ['status'=>'success','output'=>trim($out),'reason'=>null];
 }finally{directadmin_terminal_restore_cwd($restore);}
}
function directadmin_git_probe_output($probe){
 if(!is_array($probe)||($probe['status']??null)!=='success'||!array_key_exists('output',$probe)||!is_string($probe['output'])) return null;
 return $probe['output'];
}
function directadmin_git_parse_divergence($raw){
 if(!is_string($raw)||strlen($raw)>32||!preg_match('/^(0|[1-9][0-9]{0,9})\t(0|[1-9][0-9]{0,9})$/D',$raw,$matches)) return null;
 return ['ahead'=>(int)$matches[1],'behind'=>(int)$matches[2]];
}
function directadmin_git_readiness_projection($contextAvailable,$repositoryProbe,$branchProbe,$headProbe,$statusProbe,$upstreamProbe){
 $repositoryOutput=directadmin_git_probe_output($repositoryProbe);
 if(!$contextAvailable){
  $repositoryState='unavailable';
  $repository=false;
 }elseif($repositoryOutput==='true'){
  $repositoryState='available';
  $repository=true;
 }elseif($repositoryOutput==='false'){
  $repositoryState='not_repository';
  $repository=false;
 }else{
  $repositoryState='unknown';
  $repository=null;
 }
 $branchOutput=$repository===true?directadmin_git_probe_output($branchProbe):null;
 $headOutput=$repository===true?directadmin_git_probe_output($headProbe):null;
 $statusOutput=$repository===true?directadmin_git_probe_output($statusProbe):null;
 $upstreamOutput=$repository===true?directadmin_git_probe_output($upstreamProbe):null;
 $branchState=$branchOutput===null
  ?($repositoryState==='available'?'unknown':$repositoryState)
  :($branchOutput===''?'detached':'named');
 $branch=$branchState==='named'?redact_text($branchOutput):null;
 $headState=$headOutput===null||$headOutput===''?($repositoryState==='available'?'unknown':$repositoryState):'available';
 $head=$headState==='available'?redact_text($headOutput):null;
 $worktreeState=$statusOutput===null
  ?($repositoryState==='available'?'unknown':$repositoryState)
  :($statusOutput===''?'clean':'dirty');
 $dirty=$worktreeState==='clean'?false:($worktreeState==='dirty'?true:null);
 $divergence=$upstreamOutput===null?null:directadmin_git_parse_divergence($upstreamOutput);
 $upstreamState=$divergence===null
  ?($repositoryState==='available'?'unknown':$repositoryState)
  :'available';
 $claimIssue=null;
 if($branchState==='named'&&preg_match('/^agent\\/issue-([1-9][0-9]{0,17})$/D',$branch,$claimMatch)) $claimIssue=$claimMatch[1];
 $claimValid=$branchState==='detached'?false:($branchState==='named'?($claimIssue!==null):null);
 return [
  'git_repository'=>$repository,
  'git_repository_state'=>$repositoryState,
  'git_branch'=>$branch,
  'git_branch_state'=>$branchState,
  'git_head'=>$head,
  'git_head_state'=>$headState,
  'git_dirty'=>$dirty,
  'git_worktree_state'=>$worktreeState,
  'git_claim_branch_format_valid'=>$claimValid,
  'git_claim_issue_number'=>$claimIssue,
  'git_upstream_configured'=>$divergence===null?null:true,
  'git_upstream_state'=>$upstreamState,
  'git_ahead'=>$divergence['ahead']??null,
  'git_behind'=>$divergence['behind']??null
 ];
}
function command_policy($cmd){
 $cmd=trim((string)$cmd);
 if($cmd==='') return ['EMPTY','Empty command.',false];
 if(strlen($cmd)>4096) return ['UNKNOWN','Command exceeds the 4096 byte limit.',false];
 if(preg_match('/[\\r\\n\\x00;&|><\\x60]/',$cmd)) return ['UNKNOWN','Shell chaining, redirection and metacharacters are not allowed.',false];
 if(strpos($cmd,'$(')!==false || strpos($cmd,'${')!==false) return ['UNKNOWN','Shell expansion is not allowed.',false];
 $parts=preg_split('/\\s+/',$cmd);
 $bin=strtolower($parts[0]??'');
 $arguments=array_slice($parts,1);
 $fileReaders=['cat','head','tail','grep','ls','du','stat'];
 if(in_array($bin,$fileReaders,true)) return ['UNKNOWN','Direct file and directory inspection is disabled because request-time path checks cannot prevent concurrent pathname replacement.',false];
 $readonly=['pwd','whoami','id','uname','date','df','git','php','node','npm','pnpm','composer'];
 if(!in_array($bin,$readonly,true)) return ['UNKNOWN','Command is not in the Developer Portal allowlist.',false];
 foreach($arguments as $arg){
  if(strpos($arg,'../')!==false || $arg==='..' || (strlen($arg)>0 && $arg[0]==='/')) return ['UNKNOWN','Absolute paths and parent traversal are not allowed in terminal arguments.',false];
 }
 if($bin==='git'){
  $allowed=[
   ['status'],
   ['status','--short'],
   ['diff','--stat'],
   ['diff','--name-only'],
   ['log','--oneline','-5'],
   ['branch','--show-current'],
   ['rev-parse','--short','HEAD'],
   ['ls-files'],
   ['describe','--always','--dirty']
  ];
  if(in_array($arguments,$allowed,true)) return ['READ','Allowlisted read-only Git inspection.',true];
  $sub=strtolower($arguments[0]??'');
  $mutating=['add','checkout','clean','commit','config','fetch','merge','mv','pull','push','rebase','remote','reset','restore','rm','switch','tag','update-ref','worktree'];
  if(in_array($sub,$mutating,true)) return ['WRITE','Git mutation or remote inspection is blocked here; use the governed repository workflow.',false];
  return ['UNKNOWN','Git command is outside the exact read-only subcommand and argument allowlist.',false];
 }
 if(in_array($bin,['npm','pnpm','composer'],true)) return ['UNKNOWN','Package-manager commands can execute project code or load configuration and are blocked in the account terminal.',false];
 if($bin==='php'){
  if(in_array($arguments,[['-v'],['--version'],['-m'],['--modules']],true)) return ['VERIFY','PHP runtime diagnostic.',true];
  return ['UNKNOWN','PHP accepts only version and module diagnostics; file linting and arbitrary PHP execution are blocked.',false];
 }
 if($bin==='node'){
  if(in_array($arguments,[['-v'],['--version']],true)) return ['VERIFY','Node runtime diagnostic.',true];
  return ['UNKNOWN','Node script execution is blocked because account code can read HOME files.',false];
 }
 if($bin==='df'){
  if($arguments===[]||$arguments===['-h']) return ['VERIFY','Disk-space diagnostic.',true];
  return ['UNKNOWN','Disk-space diagnostics do not accept filesystem path operands.',false];
 }
 if(in_array($bin,['pwd','whoami','id','uname','date'],true)&&$arguments===[]) return ['READ','Allowlisted identity or environment diagnostic.',true];
 return ['UNKNOWN','Command arguments are outside the bounded terminal policy.',false];
}
function run_cmd($cmd,$cwd){
 [$class,$reason,$allowed]=command_policy($cmd);
 if(!$allowed) return ["Blocked by Developer Portal policy [".$class."]: ".$reason,126,$class];
 $cwd=directadmin_terminal_cwd($cwd);
 if($cwd===null) return ['Blocked by Developer Portal policy [READ]: Working directory must be a non-symlink, non-sensitive directory inside the account HOME.',126,'READ'];
 $parts=preg_split('/\s+/',trim((string)$cmd));
 if(!$parts||!isset($parts[0])) return ['Unable to start command.',127,$class];
 $programParts=directadmin_terminal_checked_arguments($parts,$cwd);
 if($programParts===null) return ['Blocked by Developer Portal policy [READ]: File paths, options or arguments are outside the bounded terminal policy.',126,'READ'];
 $environment=['PATH'=>'/usr/local/bin:/usr/bin:/bin','HOME'=>home_dir()];
 if(strtolower($parts[0])==='git'){
  $context=directadmin_git_repository_context($cwd);
  if($context===null) return ['Blocked by Developer Portal policy [READ]: Git worktree and metadata must resolve inside the account HOME.',126,'READ'];
   $programParts=directadmin_git_command_args($context,array_slice($parts,1));
   if($programParts===null) return ['Blocked by Developer Portal policy [READ]: Repository Git filter configuration is not supported for account-terminal execution.',126,'READ'];
  $cwd=$context['root'];
  $environment=directadmin_git_environment();
 }
 $argv=array_merge(['/usr/bin/env','timeout','30s'],$programParts);
 $spec=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
 $restore=directadmin_terminal_enter_verified_cwd($cwd);
 if($restore===null) return ['Blocked by Developer Portal policy [READ]: Working directory changed during terminal setup.',126,'READ'];
 try{
  $proc=@proc_open($argv,$spec,$pipes,null,$environment,['bypass_shell'=>true]);
  if(!is_resource($proc)) return ['Unable to start command.',127,$class];
  fclose($pipes[0]); stream_set_blocking($pipes[1],false); stream_set_blocking($pipes[2],false);
  $limit=524288; $out=''; $start=microtime(true); $truncated=false;
  while(true){
   $chunk=(string)stream_get_contents($pipes[1]).(string)stream_get_contents($pipes[2]);
   if($chunk!==''){
    $room=$limit-strlen($out);
    if($room>0)$out.=substr($chunk,0,$room);
    if(strlen($chunk)>$room){$truncated=true;@proc_terminate($proc,9);break;}
   }
   $status=proc_get_status($proc);
   if(!$status['running']) break;
   if(microtime(true)-$start>31){@proc_terminate($proc,9);$out.="\n[terminated: timeout]";break;}
   usleep(20000);
  }
  $out.=(string)stream_get_contents($pipes[1]).(string)stream_get_contents($pipes[2]);
  fclose($pipes[1]); fclose($pipes[2]);
  if(strlen($out)>$limit){$out=substr($out,0,$limit);$truncated=true;}
  $rc=proc_close($proc);
  if($truncated)$out.="\n[output truncated at 512 KiB and process terminated]";
  return [redact_text($out),$rc,$class];
 }finally{directadmin_terminal_restore_cwd($restore);}
}
function diagnostics(){
 $bins=['git','ssh','ssh-keygen','php','composer','node','npm','pnpm','curl']; $r=[];
 foreach($bins as $b){$p=trim((string)shell_exec('command -v '.escapeshellarg($b).' 2>/dev/null'));$r[$b]=$p?:null;}
 return $r;
}
function codex_readiness($cwd,$keys,$diag,$includeSshState=false){
 $cwd=safe_cwd($cwd);
 $gitContext=directadmin_git_repository_context($cwd);
 $repositoryProbe=$gitContext!==null?directadmin_git_probe($gitContext,['rev-parse','--is-inside-work-tree']):null;
 $repositoryOutput=directadmin_git_probe_output($repositoryProbe);
 $gitRepo=$gitContext===null?false:($repositoryOutput==='true'?true:($repositoryOutput==='false'?false:null));
 $branchProbe=$gitRepo===true?directadmin_git_probe($gitContext,['branch','--show-current']):null;
 $headProbe=$gitRepo===true?directadmin_git_probe($gitContext,['rev-parse','--short','HEAD']):null;
 $statusProbe=$gitRepo===true?directadmin_git_probe($gitContext,['status','--porcelain']):null;
 // Compare only existing local refs; this never fetches or contacts the remote.
 $upstreamProbe=$gitRepo===true?directadmin_git_probe($gitContext,['rev-list','--left-right','--count','HEAD...@{u}']):null;
 $gitReadiness=directadmin_git_readiness_projection($gitContext!==null,$repositoryProbe,$branchProbe,$headProbe,$statusProbe,$upstreamProbe);
 $sshDir=key_dir(); $auth=key_file();
 return [
  'cwd'=>$cwd,
  'cwd_readable'=>is_readable($cwd),
  'cwd_writable'=>is_writable($cwd),
  'git_repository'=>$gitReadiness['git_repository'],
  'git_repository_state'=>$gitReadiness['git_repository_state'],
  'git_branch'=>$gitReadiness['git_branch'],
  'git_branch_state'=>$gitReadiness['git_branch_state'],
  'git_head'=>$gitReadiness['git_head'],
  'git_head_state'=>$gitReadiness['git_head_state'],
  'git_dirty'=>$gitReadiness['git_dirty'],
  'git_worktree_state'=>$gitReadiness['git_worktree_state'],
  'git_claim_branch_format_valid'=>$gitReadiness['git_claim_branch_format_valid'],
  'git_claim_issue_number'=>$gitReadiness['git_claim_issue_number'],
  'git_upstream_configured'=>$gitReadiness['git_upstream_configured'],
  'git_upstream_state'=>$gitReadiness['git_upstream_state'],
  'git_ahead'=>$gitReadiness['git_ahead'],
  'git_behind'=>$gitReadiness['git_behind'],
  'ssh_public_keys'=>count($keys),
  'ssh_dir_mode'=>$includeSshState&&is_dir($sshDir)?substr(sprintf('%o',fileperms($sshDir)),-4):null,
  'authorized_keys_mode'=>$includeSshState&&is_file($auth)?substr(sprintf('%o',fileperms($auth)),-4):null,
  'disk_free_bytes'=>@disk_free_space($cwd)?:null,
  'git_available'=>!empty($diag['git']),
  'php_available'=>!empty($diag['php']),
  'node_available'=>!empty($diag['node']),
  'npm_available'=>!empty($diag['npm']),
  'pnpm_available'=>!empty($diag['pnpm']),
  'composer_available'=>!empty($diag['composer'])
 ];
}
function normalize_server_node_status($raw){
 if(!is_string($raw)||$raw===''||strlen($raw)>65536) return ['state'=>'UNAVAILABLE','ready'=>false,'checked_at'=>null,'checks'=>[],'reason'=>'invalid-response'];
 $data=json_decode($raw,true);
 if(!is_array($data)||($data['schema']??'')!=='titan.server-node.health.v1') return ['state'=>'UNAVAILABLE','ready'=>false,'checked_at'=>null,'checks'=>[],'reason'=>'invalid-schema'];
 $checks=[];
 foreach(array_slice(is_array($data['checks']??null)?$data['checks']:[],0,16) as $row){
  if(!is_array($row)) continue;
  $id=preg_replace('/[^a-zA-Z0-9_.-]/','',substr((string)($row['id']??''),0,64));
  if($id==='') continue;
  $status=strtolower((string)($row['status']??'unknown'));
  if(!in_array($status,['healthy','unhealthy','unreachable'],true)) $status='unknown';
  $checks[]=['id'=>$id,'status'=>$status,'critical'=>($row['critical']??true)===true,'http_status'=>is_int($row['http_status']??null)?$row['http_status']:null];
 }
 $ready=($data['ready']??false)===true;
 $status=strtolower((string)($data['status']??''));
 $state=$ready&&$status==='healthy'?'CONNECTED':($ready?'DEGRADED':'UNAVAILABLE');
 $checkedAt=(string)($data['checked_at']??'');
 if($checkedAt!==''&&strtotime($checkedAt)===false)$checkedAt='';
 $reason=substr(preg_replace('/[^a-zA-Z0-9_.-]/','',(string)($data['reason']??'')),0,120);
 return ['state'=>$state,'ready'=>$ready,'checked_at'=>$checkedAt?:null,'checks'=>$checks,'reason'=>$reason?:null];
}
function server_node_health(){
 $url='http://127.0.0.1:3099/v1/status';
 $context=stream_context_create(['http'=>['method'=>'GET','timeout'=>2,'ignore_errors'=>true,'header'=>"Accept: application/json\r\nConnection: close\r\n"]]);
 $raw=@file_get_contents($url,false,$context,0,65537);
 if(!is_string($raw)) return ['state'=>'UNAVAILABLE','ready'=>false,'checked_at'=>null,'checks'=>[],'reason'=>'server-node-unreachable'];
 return normalize_server_node_status($raw);
}
function directadmin_ssh_access_script(){
 return <<<'JS'
(function(){
 var host=document.getElementById("tda-ssh-host"),port=document.getElementById("tda-ssh-port"),alias=document.getElementById("tda-ssh-alias"),
  user=document.getElementById("tda-ssh-username"),command=document.getElementById("tda-ssh-command"),
  copy=document.getElementById("tda-ssh-copy"),copyStatus=document.getElementById("tda-ssh-copy-status");
 if(!host||!port||!alias||!user||!command||!copy)return;
 function validHost(value){
  if(value.length===0||value.length>253)return false;
  return value.split(".").every(function(label){
   return label.length>0&&label.length<=63&&/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label);
  });
 }
 function update(){
  var a=alias.value.trim(),h=host.value.trim(),p=port.value.trim(),u=user.textContent.trim(),
   aliasValid=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(a),
   directValid=validHost(h)&&/^[0-9]{1,5}$/.test(p)&&Number(p)>=1&&Number(p)<=65535&&/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(u),
   ok=a!==""?aliasValid:directValid;
  command.textContent=ok?(a!==""?"ssh "+a:"ssh -p "+String(Number(p))+" "+u+"@"+h):"Enter a valid SSH alias, or a valid SSH host and port, to build the command.";
  copy.disabled=!ok;
  return ok;
 }
 host.addEventListener("input",update);
 port.addEventListener("input",update);
 alias.addEventListener("input",update);
 copy.addEventListener("click",function(){
  if(!update())return;
  var value=command.textContent;
  if(navigator.clipboard&&window.isSecureContext){
   navigator.clipboard.writeText(value).then(function(){copyStatus.textContent="Copied";})
    .catch(function(){copyStatus.textContent="Select and copy the command.";});
  }else copyStatus.textContent="Select and copy the command.";
 });
 var error=document.getElementById("tda-ssh-error"),
  diagnose=document.getElementById("tda-ssh-diagnose"),guidance=document.getElementById("tda-ssh-guidance");
 if(error&&diagnose&&guidance)diagnose.addEventListener("click",function(){
  var raw=error.value||"";
  if(raw.length>1000||/[\r\n]/.test(raw.trim())){
   guidance.textContent="Enter one OpenSSH error line of at most 1000 characters. The text stays in this browser and is not submitted or saved.";
   return;
  }
  var text=raw.toLowerCase();
  if(/load key[^\r\n]*permission denied|bad permissions/.test(text)){
   guidance.textContent="Local key-file access failed before server authentication. Check Windows permissions for the private-key file selected by your SSH alias or config; this does not show that the server rejected the public key.";
  }else if(/no such identity|identity file[^\r\n]*(?:no such file|type -1)|load key[^\r\n]*no such file or directory/.test(text)){
   guidance.textContent="The SSH client could not find the configured identity file locally. Check the IdentityFile path in your saved SSH alias/config. The server has not rejected this missing local key.";
  }else if(/permission denied\s*\(publickey\)/.test(text)){
   guidance.textContent="The SSH server was reached, but none of the keys offered by the client were accepted; the expected key may not have been selected. Check your alias IdentityFile/IdentitiesOnly settings, installed public-key fingerprint, DirectAdmin username, host and port.";
  }else if(/could not resolve hostname|name or service not known|temporary failure in name resolution/.test(text)){
   guidance.textContent="The hostname did not resolve. Check the SSH host value and workstation DNS or VPN.";
  }else if(/connection timed out|operation timed out/.test(text)){
   guidance.textContent="No SSH response arrived before timeout. Check the host, port, network route, VPN and host firewall with your administrator.";
  }else if(/connection refused/.test(text)){
   guidance.textContent="The host was reachable but refused this port. Confirm the SSH port and that the SSH service is listening.";
  }else if(/remote host identification has changed|host key verification failed/.test(text)){
   guidance.textContent="The server host key did not match your saved trust record. Stop and verify the server fingerprint with your administrator before changing known_hosts.";
  }else if(/too many authentication failures/.test(text)){
   guidance.textContent="The client offered too many identities. Review your Windows SSH alias or agent configuration; do not remove host trust records to fix this.";
  }else if(/incorrect passphrase|bad passphrase/.test(text)){
   guidance.textContent="The local private-key passphrase was not accepted. This is a workstation key-unlock issue, not server public-key rejection.";
  }else if(text.trim()===""){
   guidance.textContent="Paste one OpenSSH error line. It stays in this browser and is not submitted or saved.";
  }else{
   guidance.textContent="No specific cause matched. Check the displayed username, host and port, then ask your server administrator with the single sanitized error line.";
  }
 });
 update();
})();
JS;
}
function render_directadmin_ssh_access($info,$command,$canInspectKeys,$keys,$token,$canMutate=false){
 echo '<div class="card" id="tda-server-access"><h3>Connect Codex to this server</h3><p>Use this guide to connect a development client from your workstation. The username comes from the validated DirectAdmin Unix account. The host uses the operator setting when present, otherwise the DirectAdmin panel server name; the port defaults to SSH port 22. Confirm the endpoint with your server administrator if SSH uses another address or port.</p>';
 echo '<div class="diag"><div><b>SSH username</b><br><code id="tda-ssh-username">'.h($info['username']?:'unavailable').'</code></div><div><b>Host source</b><br>'.h($info['host_source']).'</div><div><b>Port source</b><br>'.h($info['port_source']).'</div><div><b>Installed public keys</b><br>'.($canInspectKeys?h((string)count($keys)):'Admin role required to inspect fingerprints').'</div></div>';
 echo '<label for="tda-ssh-host">SSH host</label><input id="tda-ssh-host" value="'.h($info['host']).'" autocomplete="off" spellcheck="false" placeholder="server.example.com"><label for="tda-ssh-port">SSH port</label><input id="tda-ssh-port" type="number" min="1" max="65535" value="'.h($info['port']).'" inputmode="numeric"><label for="tda-ssh-alias">Saved SSH alias (optional)</label><input id="tda-ssh-alias" autocomplete="off" spellcheck="false" placeholder="titan">';
 echo '<p class="muted">These fields only build a command in this browser. They are not submitted or saved. With an alias, the command is <code>ssh ALIAS</code> and Windows OpenSSH uses the settings saved for that alias: <code>HostName</code>, <code>User</code>, <code>Port</code>, <code>IdentityFile</code> and <code>IdentitiesOnly</code>. The portal cannot inspect or modify your SSH config or key files. Without an alias, the username is fixed to this DirectAdmin account and the validated host/port are used.</p><p><b>Windows PowerShell command</b></p><code id="tda-ssh-command" style="display:block;padding:10px;border:1px solid var(--tda-border);border-radius:7px;overflow-wrap:anywhere">'.h($command?:'Enter a valid SSH alias, or a valid SSH host and port, to build the command.').'</code><div class="copyrow"><button type="button" id="tda-ssh-copy"'.($command===''?' disabled':'').'>Copy connection command</button><span id="tda-ssh-copy-status" class="copy-status" aria-live="polite"></span></div>';
 echo '<div class="notice"><b>Setup steps</b><ol><li>Use the saved workstation alias that selects the matching key, if one is configured (for example, enter <code>titan</code> above). Compare the installed public-key fingerprint below.</li><li>If no alias selects the intended key, configure an approved local <code>IdentityFile</code> entry on the workstation or ask your endpoint administrator. Never paste or upload a private key.</li><li>Install only the matching public key with the admin-only form below.</li><li>From Windows PowerShell, run the copied command. Confirm an interactive SSH login before treating access as verified.</li></ol></div>';
 echo '<p class="muted">The portal cannot test a workstation private key or verify an end-to-end SSH login. If a saved Windows alias fails, run <code>ssh -v &lt;your-alias&gt;</code> locally and diagnose only one error line below; do not share private-key contents or full verbose logs.</p>';
 echo '<label for="tda-ssh-error">Diagnose one OpenSSH error line</label><textarea id="tda-ssh-error" rows="3" maxlength="1000" placeholder="Paste one error line only. It is handled in this browser, not submitted or saved."></textarea><button type="button" id="tda-ssh-diagnose">Show guidance</button><p id="tda-ssh-guidance" class="notice" aria-live="polite">Guidance will appear here. No diagnostic text leaves this browser.</p>';
 echo '<p class="footer-note">For a local Windows <b>Load key: Permission denied</b> message, OpenSSH cannot read the selected private-key file before server authentication. Check local file permissions with <code>icacls "$env:USERPROFILE\\.ssh\\YOUR_KEY_FILE"</code>; if your Windows account lacks read access, use your endpoint administrator\'s approved repair process. A missing local identity path is a client configuration issue. For <b>Permission denied (publickey)</b>, the server was reached but did not accept an offered key; the expected identity may not have been selected. Compare the public-key fingerprint and check the alias <code>IdentityFile</code>/<code>IdentitiesOnly</code>, username, host and port.</p></div>';
 if($canInspectKeys){
  echo '<div class="card"><h3>Install a workstation public key</h3><p>Paste the single-line <code>.pub</code> public key that matches the private key on the workstation. This admin-only, CSRF-protected action writes only that public key to this DirectAdmin account\'s <code>authorized_keys</code>. Never paste a private key.</p><form method="post" action="?pipe_post=yes"><input type="hidden" name="csrf" value="'.h($token).'"><textarea name="public_key" rows="3" placeholder="ssh-ed25519 AAAA... workstation-key"></textarea><button name="add_key" value="1">Install public key</button></form>';
  if(!$keys) echo '<p>No public keys are installed for this account.</p>';
  foreach($keys as [$i,$fingerprint]){
   if($fingerprint==='fingerprint unavailable')echo '<div class="keyrow"><b>'.h($fingerprint).'</b><p class="muted">Revoke is unavailable because this authorized_keys line could not be validated.</p></div>';
   else echo '<div class="keyrow"><b>'.h($fingerprint).'</b><form method="post" action="?pipe_post=yes"><input type="hidden" name="csrf" value="'.h($token).'"><input type="hidden" name="expected_fingerprint" value="'.h($fingerprint).'"><button name="remove_key" value="'.h($i).'">Revoke</button></form></div>';
  }
  echo '</div>';
 }elseif($canMutate) echo '<div class="card"><h3>Public-key management unavailable</h3><p class="muted">SSH key storage is unsafe or unavailable. No key changes were made; ask the server administrator to repair this account storage through its approved process.</p></div>';
 else echo '<div class="card"><h3>Public-key management</h3><p class="muted">This DirectAdmin role is read-only. Ask an authorized admin to install the matching public key and compare fingerprints; no key material is displayed here.</p></div>';
 echo '<script>'.directadmin_ssh_access_script().'</script>';
}
function redact_text($value){
 $s=(string)$value;
 $patterns=[
  '/(?i)(authorization\s*:\s*bearer\s+)[^\s]+/',
  '/(?i)\b(api[_-]?key|token|secret|password|passwd|cookie|session[_-]?id)\s*[=:]\s*[^\s,;]+/',
  '/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@]+@/i',
  '/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/s'
 ];
 foreach($patterns as $p)$s=preg_replace($p,'$1[REDACTED]',$s);
 return $s;
}
function diagnostics_report($diag,$keys,$readiness=[]){
 $lines=[
  'Titan Developer Portal diagnostics v2',
  'generated_at='.gmdate('c'),
  'user='.env_user(),
  'uid='.(function_exists('posix_geteuid')?posix_geteuid():'unknown'),
  'home='.home_dir(),
  'cwd_policy=HOME_AND_DESCENDANTS_ONLY',
  'terminal_policy=READ_VERIFY_ALLOWLIST',
  'terminal_timeout_seconds=30',
  'terminal_output_limit_bytes=524288',
  'ssh_key_count='.count($keys)
 ];
 foreach($keys as $key)$lines[]='ssh_fingerprint='.redact_text($key[1]);
 foreach($diag as $bin=>$path)$lines[]='binary_'.$bin.'='.($path?:'missing');
 foreach($readiness as $name=>$value){
  if(is_bool($value))$value=$value?'true':'false';
  if($value===null)$value='unknown';
  $lines[]='readiness_'.$name.'='.redact_text((string)$value);
 }
 return redact_text(implode("\n",$lines));
}
function render(){
 $rejected=$_SERVER['TDA_REQUEST_REJECTED']??'';
 if($rejected==='context'){
  echo '<div class="notice">Request rejected: DirectAdmin execution identity is ambiguous. Reopen this page through DirectAdmin.</div>';
  return;
 }
 if($rejected==='input'){
  echo '<div class="notice">Request rejected: malformed or ambiguous form data. <small>Diagnostic: '.h(directadmin_request_diagnostic_summary()).'</small></div>';
  return;
 }
 if($rejected==='role'){
  echo '<div class="notice">Request rejected: this DirectAdmin role is read-only in Developer Portal.</div>';
  return;
 }
 $role=$_SERVER['TDA_ROLE']??'user';
 $canMutate=directadmin_role_can_mutate($role);
 $msg='';$output='';$rc=null;$commandClass=null;$requestedCwd=post_string('cwd','');$cwd=safe_cwd($requestedCwd);
 if(($_SERVER['REQUEST_METHOD']??'GET')==='POST'){
  if(!$canMutate){$msg='Request rejected: this DirectAdmin role is read-only in Developer Portal.';}
  elseif(!check_csrf()){$msg='Request rejected: invalid CSRF token. Open Diagnostics below and use Copy Full Diagnostics.';}
  elseif(isset($_POST['add_key'])){$msg=add_key(post_string('public_key',''));}
  elseif(isset($_POST['remove_key'])){$idx=filter_var(post_string('remove_key',''),FILTER_VALIDATE_INT,['options'=>['min_range'=>0]]);$msg=remove_key($idx===false?-1:$idx,post_string('expected_fingerprint',''));}
  elseif(isset($_POST['run'])){[$output,$rc,$commandClass]=run_cmd(post_string('command',''),$requestedCwd);}
 }
 $uid=function_exists('posix_geteuid')?posix_geteuid():-1; $user=env_user();$home=home_dir();$diag=diagnostics();
 $keyStorageAvailable=true;$keys=[];
 if($canMutate){try{$keys=fingerprints();}catch(Throwable $e){$keys=[];$keyStorageAvailable=false;if($msg==='')$msg='SSH key storage is unsafe or unavailable. No SSH key changes were made.';}}
 $readiness=codex_readiness($cwd,$keys,$diag,$canMutate);$serverNode=server_node_health();$token=$canMutate?csrf():'';$fullDiag=diagnostics_report($diag,$keys,$readiness);
 $sshAccess=directadmin_ssh_connection_info();$sshCommand=directadmin_ssh_connection_command($sshAccess);
 echo '<style>
:root{color-scheme:light dark;--tda-panel:var(--card-background,#fff);--tda-text:var(--text-color,#1f2937);--tda-muted:var(--neutral,#6b7280);--tda-border:var(--border-color,#d9dde5);--tda-primary:var(--primary,#2563eb);--tda-safe:var(--safe,#16803c);--tda-danger:var(--danger,#c62828);--tda-input:var(--input-background,var(--tda-panel));}
@media (prefers-color-scheme:dark){:root{--tda-panel:#18212f;--tda-text:#eef2f7;--tda-muted:#9ca3af;--tda-border:#334155;--tda-input:#0f172a}}
html,body{background:transparent;color:var(--tda-text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0}.tda-wrap{max-width:1180px;margin:0 auto;padding:18px}.tda-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.tda-title{margin:0;font-size:26px;font-weight:700}.tda-sub{color:var(--tda-muted);margin:6px 0 0}.card{background:var(--tda-panel);border:1px solid var(--tda-border);border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.08);margin:0 0 14px}.card h3{margin:0 0 12px;font-size:17px}.diag{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.oktxt{color:var(--tda-safe)}.badtxt{color:var(--tda-danger)}.term{background:#0b1020;color:#e5edf7;border:1px solid #263247;padding:12px;white-space:pre-wrap;min-height:180px;border-radius:8px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}label{display:block;font-size:13px;font-weight:600;margin-top:8px}input,textarea{width:100%;box-sizing:border-box;padding:9px 10px;margin:5px 0 8px;border:1px solid var(--tda-border);border-radius:7px;background:var(--tda-input);color:var(--tda-text)}button{padding:8px 12px;margin:4px 4px 4px 0;border:0;border-radius:7px;background:var(--tda-primary);color:#fff;font-weight:600;cursor:pointer}button[name=remove_key]{background:var(--tda-danger)}.notice{padding:10px 12px;border:1px solid var(--tda-border);border-left:4px solid var(--tda-safe);background:var(--tda-panel);border-radius:7px;margin-bottom:12px}.muted{color:var(--tda-muted)}code{word-break:break-all}.keyrow{border-top:1px solid var(--tda-border);padding:10px 0}.footer-note{font-size:13px;color:var(--tda-muted)}.diagbox{min-height:320px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre}.copyrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.copy-status{font-size:13px;color:var(--tda-safe)}@media(max-width:640px){.tda-wrap{padding:10px}.tda-title{font-size:22px}}
</style><div class="tda-wrap">';
 echo '<div class="tda-head"><div><h2 class="tda-title">Developer Portal</h2><p class="tda-sub">Scoped diagnostics for the current DirectAdmin UNIX account. Role: '.h($role).($canMutate?' · operator actions enabled':' · read-only').'</p></div></div>';
 if($msg) echo '<div class="notice">'.h($msg).'</div>';
 echo '<div class="card"><h3>Diagnostics</h3><div class="diag"><div><b>User</b><br>'.h($user).'</div><div><b>UID</b><br>'.h($uid).'</div><div><b>HOME</b><br>'.h($home).'</div></div><hr style="border:0;border-top:1px solid var(--tda-border);margin:14px 0"><div class="diag">';
 foreach($diag as $b=>$p) echo '<div><b>'.h($b).'</b><br>'.($p?'<span class="oktxt">✓ '.h($p).'</span>':'<span class="muted">—</span>').'</div>'; echo '</div></div>';
 echo '<div class="card"><h3>Codex / Agent Readiness</h3><div class="diag">';
 foreach($readiness as $name=>$value){
  if(is_bool($value)){$display=$value?'yes':'no';$class=$value?'oktxt':'muted';}
  elseif($value===null||$value===''){$display='unknown';$class='muted';}
  else{$display=(string)$value;$class='';}
  echo '<div><b>'.h(str_replace('_',' ',$name)).'</b><br><span class="'.h($class).'">'.h($display).'</span></div>';
 }
 echo '</div></div>';
 echo '<div class="card"><h3>Server Node Health</h3><p class="muted">Read-only projection from the canonical loopback Server Node health bridge. No host action can be executed here.</p><div class="diag">';
 echo '<div><b>State</b><br><span class="'.($serverNode['state']==='CONNECTED'?'oktxt':($serverNode['state']==='DEGRADED'?'':'badtxt')).'">'.h($serverNode['state']).'</span></div>';
 echo '<div><b>Ready</b><br>'.h($serverNode['ready']?'yes':'no').'</div>';
 echo '<div><b>Checked</b><br>'.h($serverNode['checked_at']??'unknown').'</div>';
 echo '<div><b>Reason</b><br>'.h($serverNode['reason']??'—').'</div>';
 echo '</div>';
 if(!$serverNode['checks']) echo '<p class="muted">No dependency checks available.</p>';
 foreach($serverNode['checks'] as $check){
  echo '<div class="keyrow"><b>'.h($check['id']).'</b> · '.h($check['status']).' · '.($check['critical']?'critical':'optional');
  if($check['http_status']!==null) echo ' · HTTP '.h($check['http_status']);
  echo '</div>';
 }
 echo '</div>';
 if($canMutate) {
 echo '<div class="card"><h3>Scoped terminal</h3><p class="muted">Pathless identity, runtime, disk and exact read-only Git diagnostics only. Direct file/directory inspection, PHP lint, builds/tests, shell chaining, redirection, package installation, Git mutation, destructive and privileged commands are blocked.</p><form method="post" action="?pipe_post=yes"><input type="hidden" name="csrf" value="'.h($token).'"><label>Working directory</label><input name="cwd" value="'.h($cwd).'"><label>Command</label><textarea name="command" rows="3" placeholder="git status"></textarea><button name="run" value="1">Run</button></form>';
 if($rc!==null) echo '<p>Class: '.h($commandClass).' · Exit code: '.h($rc).'</p><div class="term">'.h($output).'</div>'; echo '</div>';
 } else {
  echo '<div class="card"><h3>Operator actions</h3><p class="muted">Terminal and SSH key mutation are available only on the DirectAdmin admin route. This role is intentionally read-only.</p></div>';
 }
 render_directadmin_ssh_access($sshAccess,$sshCommand,$canMutate&&$keyStorageAvailable,$keys,$token,$canMutate);
 echo '<div class="card"><h3>Plugin Diagnostics</h3><p class="muted">Read-only support report. Tokens, secrets, passwords, cookies and private-key blocks are redacted.</p><div class="copyrow"><button type="button" onclick="tdaCopyDiagnostics()">Copy Full Diagnostics</button><span id="tda-copy-status" class="copy-status"></span></div><textarea id="tda-full-diagnostics" class="diagbox" readonly>'.h($fullDiag).'</textarea></div>';
 echo '<script>function tdaCopyDiagnostics(){var el=document.getElementById("tda-full-diagnostics"),status=document.getElementById("tda-copy-status"),text=el.value;if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(function(){status.textContent="Copied";}).catch(function(){el.focus();el.select();document.execCommand("copy");status.textContent="Copied";});}else{el.focus();el.select();try{document.execCommand("copy");status.textContent="Copied";}catch(e){status.textContent="Select all and copy manually";}}}</script>';
 echo '<div class="card"><h3>Safety boundary</h3><p class="footer-note">Developer Portal does not grant Titan business authority, root or sudo. Working directories are restricted to HOME and real descendants. Unknown or mutating commands fail closed and must use canonical governed execution elsewhere.</p></div></div>';
}
?>
