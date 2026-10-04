<?php
declare(strict_types=1);

function expect_true($condition,string $message):void{
 if(!$condition){fwrite(STDERR,"FAIL: ".$message.PHP_EOL);exit(1);}
}
function remove_test_tree(string $path):void{
 if(is_link($path)||is_file($path)){@unlink($path);return;}
 if(!is_dir($path)) return;
 foreach(scandir($path)?:[] as $entry){
  if($entry==='.'||$entry==='..') continue;
  remove_test_tree($path.'/'.$entry);
 }
 @rmdir($path);
}
function expect_rejected(callable $action,string $message):void{
 try{$action();}catch(Throwable $e){return;}
 expect_true(false,$message);
}
function run_security_git_fixture(array $arguments,string $home):bool{
 $descriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
 $environment=[
  'PATH'=>getenv('PATH')?:'/usr/local/bin:/usr/bin:/bin',
  'HOME'=>$home,
  'GIT_CONFIG_NOSYSTEM'=>'1',
  'GIT_CONFIG_GLOBAL'=>'/dev/null',
  'GIT_TERMINAL_PROMPT'=>'0'
 ];
 $process=@proc_open(array_merge(['git'],$arguments),$descriptors,$pipes,$home,$environment,['bypass_shell'=>true]);
 if(!is_resource($process)) return false;
 fclose($pipes[0]);
 $stdout=(string)stream_get_contents($pipes[1]);
 $stderr=(string)stream_get_contents($pipes[2]);
 fclose($pipes[1]);fclose($pipes[2]);
 return proc_close($process)===0&&$stdout===''&&$stderr==='';
}

function run_security_git_capture(array $arguments,string $home):array{
 $descriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
 $environment=[
  'PATH'=>getenv('PATH')?:'/usr/local/bin:/usr/bin:/bin',
  'HOME'=>$home,
  'GIT_CONFIG_NOSYSTEM'=>'1',
  'GIT_CONFIG_GLOBAL'=>'/dev/null',
  'GIT_TERMINAL_PROMPT'=>'0'
 ];
 $process=@proc_open(array_merge(['git'],$arguments),$descriptors,$pipes,$home,$environment,['bypass_shell'=>true]);
 if(!is_resource($process)) return [127,'','Unable to start fixture Git command.'];
 fclose($pipes[0]);
 $stdout=(string)stream_get_contents($pipes[1]);
 $stderr=(string)stream_get_contents($pipes[2]);
 fclose($pipes[1]);fclose($pipes[2]);
 return [proc_close($process),$stdout,$stderr];
}


expect_true(function_exists('posix_geteuid')&&function_exists('posix_getpwuid')&&function_exists('posix_getpwnam'),'POSIX account context is required for DirectAdmin CLI verification');
$account=posix_getpwuid(posix_geteuid());
expect_true(is_array($account)&&isset($account['name'],$account['dir']),'effective UNIX account must resolve');
$accountHome=realpath($account['dir']);
expect_true($accountHome!==false,'effective UNIX home must resolve');
$root=$accountHome.'/.titan-dev-security-'.bin2hex(random_bytes(6));
$home=$root.'/home/admin';
$sibling=$root.'/home/admin-other';
mkdir($home,0700,true);
mkdir($sibling,0700,true);
register_shutdown_function(static function()use($root):void{remove_test_tree($root);});
putenv('USERNAME='.$account['name']);
putenv('USER='.$account['name']);
putenv('HOME='.$home);

require dirname(__DIR__).'/lib/app.php';

function security_ssh_wire_string(string $value):string{
 return pack('N',strlen($value)).$value;
}
function security_synthetic_public_key(string $algorithm):string{
 if($algorithm==='ssh-ed25519'){
  $public=hex2bin('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  $blob=security_ssh_wire_string('ssh-ed25519').security_ssh_wire_string($public);
 }elseif($algorithm==='ssh-rsa'){
  $exponent="\x01\x00\x01";
  $modulus="\x7f".str_repeat("\xfb",254);
  $blob=security_ssh_wire_string('ssh-rsa').security_ssh_wire_string($exponent).security_ssh_wire_string($modulus);
 }else{
  throw new RuntimeException('Unsupported security-test fixture algorithm.');
 }
 return $algorithm.' '.base64_encode($blob).' synthetic+fixture&marker=literal%25';
}

expect_true(directadmin_identity_context()!==null,'same-account HOME descendant must be accepted');
expect_true(directadmin_identity_uid_allowed(posix_geteuid()),'non-root effective UID must pass the DirectAdmin identity policy');
expect_true(!directadmin_identity_uid_allowed(0),'root execution must fail closed before SSH key management or command diagnostics');
expect_true(!directadmin_identity_uid_allowed(-1),'invalid effective UID must fail closed');
expect_true(directadmin_ssh_host_valid('ssh.example.test'),'ordinary DNS SSH host must be accepted');
expect_true(directadmin_ssh_host_valid('192.0.2.10'),'IPv4 SSH host must be accepted');
expect_true(!directadmin_ssh_host_valid('ssh.example.test;id'),'shell metacharacters in an SSH host must be rejected');
expect_true(!directadmin_ssh_host_valid('-oProxyCommand=id'),'SSH option-shaped host must be rejected');
expect_true(!directadmin_ssh_host_valid('https://ssh.example.test'),'URL syntax must not be accepted as a host');
expect_true(!directadmin_ssh_host_valid('ssh_example.test'),'underscore DNS label must be rejected');
expect_true(!directadmin_ssh_host_valid('ssh.example.test '),'whitespace-padded host must be rejected');
expect_true(!directadmin_ssh_host_valid(str_repeat('a',254)),'overlong SSH host must be rejected');
expect_true(directadmin_ssh_port_valid('22')&&directadmin_ssh_port_valid('65535'),'valid SSH port range endpoints must be accepted');
expect_true(!directadmin_ssh_port_valid('0')&&!directadmin_ssh_port_valid('65536'),'out-of-range SSH ports must be rejected');
expect_true(!directadmin_ssh_port_valid('22;id')&&!directadmin_ssh_port_valid('+22')&&!directadmin_ssh_port_valid('1e3'),'non-decimal or shell-like SSH ports must be rejected');
$oldSshHost=getenv('TITAN_DEV_ACCESS_SSH_HOST');$oldSshPort=getenv('TITAN_DEV_ACCESS_SSH_PORT');$oldServerName=getenv('SERVER_NAME');
putenv('TITAN_DEV_ACCESS_SSH_HOST=ssh.example.test');
putenv('TITAN_DEV_ACCESS_SSH_PORT=2222');
putenv('SERVER_NAME=panel.example.test');
$sshAccess=directadmin_ssh_connection_info();
expect_true(($sshAccess['username']??null)===$account['name']&&($sshAccess['host']??null)==='ssh.example.test'&&($sshAccess['port']??null)==='2222','SSH connection metadata must bind the configured endpoint to the validated DirectAdmin account');
expect_true(directadmin_ssh_connection_command($sshAccess)==='ssh -p 2222 '.$account['name'].'@ssh.example.test','SSH command builder must return only a validated account/host/port tuple');
putenv('TITAN_DEV_ACCESS_SSH_HOST=ssh.example.test;id');
$invalidSshAccess=directadmin_ssh_connection_info();
expect_true(($invalidSshAccess['host']??null)===''&&directadmin_ssh_connection_command($invalidSshAccess)==='','invalid SSH host configuration must fail closed without panel-host fallback');
putenv('TITAN_DEV_ACCESS_SSH_HOST');
putenv('TITAN_DEV_ACCESS_SSH_PORT');
$fallbackSshAccess=directadmin_ssh_connection_info();
expect_true(($fallbackSshAccess['host']??null)==='panel.example.test'&&($fallbackSshAccess['port']??null)==='22','SSH endpoint fallback must use the DirectAdmin server name and default port');
if($oldSshHost===false)putenv('TITAN_DEV_ACCESS_SSH_HOST');else putenv('TITAN_DEV_ACCESS_SSH_HOST='.$oldSshHost);
if($oldSshPort===false)putenv('TITAN_DEV_ACCESS_SSH_PORT');else putenv('TITAN_DEV_ACCESS_SSH_PORT='.$oldSshPort);
if($oldServerName===false)putenv('SERVER_NAME');else putenv('SERVER_NAME='.$oldServerName);
expect_true(directadmin_ssh_connection_command(['username'=>'-oProxyCommand','host'=>'ssh.example.test','port'=>'22'])==='','SSH command builder must reject option-shaped usernames');
putenv('USERNAME='.$account['name']);
putenv('USER=root');
putenv('HOME='.$home);
expect_true(directadmin_identity_context()!==null,'documented USERNAME must remain authoritative when inherited USER differs');
putenv('USER='.$account['name']);
$syntheticEd25519=security_synthetic_public_key('ssh-ed25519');
$syntheticRsa=security_synthetic_public_key('ssh-rsa');
$edParts=explode(' ',$syntheticEd25519,3);
$rsaParts=explode(' ',$syntheticRsa,3);
expect_true(strpos($edParts[1],'+')!==false,'synthetic Ed25519 fixture must exercise an encoded plus sign');
expect_true(strpos($rsaParts[1],'+')!==false&&strpos($rsaParts[1],'/')!==false&&substr($rsaParts[1],-2)==='==','synthetic RSA fixture must exercise plus, slash and padding');
expect_true(valid_pubkey($syntheticEd25519),'valid synthetic Ed25519 public blob must pass');
expect_true(valid_pubkey($syntheticEd25519."\r\n"),'one conventional trailing CRLF must be normalized');
expect_true(valid_pubkey($syntheticRsa),'valid synthetic RSA public blob must pass');
$spaceCorruptedEd25519='ssh-ed25519 '.str_replace('+',' ',$edParts[1]).' synthetic+fixture&marker=literal%25';
expect_true(!valid_pubkey($spaceCorruptedEd25519),'form-decoded plus inside the public blob must not accept a shortened base64 prefix');
$splitEd25519='ssh-ed25519'."\n".$edParts[1].' synthetic+fixture';
expect_true(!valid_pubkey($splitEd25519),'line breaks between the key algorithm and blob must be rejected');
$multilineOptions=$syntheticEd25519."\n".'command="synthetic-option-fixture" '.$syntheticEd25519;
expect_true(!valid_pubkey($multilineOptions),'a second options-bearing authorized_keys record must be rejected');
$wrongEmbeddedType='ssh-ed25519 '.$rsaParts[1].' synthetic+fixture';
expect_true(!valid_pubkey($wrongEmbeddedType),'declared algorithm must match the SSH blob algorithm');
expect_true(add_key($splitEd25519)==='Invalid public key format.','malformed key must be rejected before key-directory setup');
expect_true(!is_dir($home.'/.ssh'),'invalid public key must not create or alter the SSH directory');
$authorizedDirectory=$home.'/.ssh';$authorizedPath=$authorizedDirectory.'/authorized_keys';
expect_true(mkdir($authorizedDirectory,0700),'isolated authorized_keys directory must be created');
$edMaterial=$edParts[0].' '.$edParts[1];$rsaMaterial=$rsaParts[0].' '.$rsaParts[1];
$oddCommentLines=["Alice's \"laptop",'unmatched " comment',"comment ending in backslash\\"];
foreach($oddCommentLines as $comment){
 $oddLine='command="echo hello world",no-pty '.$edMaterial.' '.$comment;
 $oddIdentity=directadmin_authorized_key_identity($oddLine);
 expect_true(is_array($oddIdentity)&&$oddIdentity['identity']===directadmin_authorized_key_identity($syntheticEd25519)['identity'],'authorized-key identity must ignore free-form comments containing apostrophes, unmatched quotes, or trailing backslashes');
}
expect_true(directadmin_authorized_key_identity(" \t ")===null,'blank authorized_keys lines must not count as keys');
$commentedEdLine='# '.$syntheticEd25519.' commented-out-key';
expect_true(directadmin_authorized_key_identity($commentedEdLine)===null,'commented-out public-key material must not count as an active authorization');
expect_true(file_put_contents($authorizedPath,$commentedEdLine."\n")!==false,'comment-only authorized_keys fixture must be written');
chmod($authorizedPath,0600);
expect_true(add_key($syntheticEd25519)==='Public key installed.','commented-out matching material must not block installing a real public key');
expect_true(file_get_contents($authorizedPath)===$commentedEdLine."\n".$syntheticEd25519."\n",'installing a key must preserve an unrelated comment line');
$optionedEdLine='command="echo hello world",no-pty '.$edMaterial.' '.$oddCommentLines[0];
expect_true(file_put_contents($authorizedPath,$optionedEdLine)!==false,'isolated no-final-newline authorized_keys fixture must be written');
chmod($authorizedPath,0600);
$expectedEdIdentity=directadmin_authorized_key_identity($syntheticEd25519);
$existingEdIdentity=directadmin_authorized_key_identity($optionedEdLine);
expect_true(is_array($expectedEdIdentity)&&$existingEdIdentity['identity']===$expectedEdIdentity['identity'],'authorized-key identity must ignore options and comments while parsing quoted options safely');
expect_true($existingEdIdentity['fingerprint']===$expectedEdIdentity['fingerprint'],'same key material with different comments must produce the same SHA-256 fingerprint');
expect_true(add_key($syntheticEd25519.' different comment')==='Key already installed.','a key already present with another comment/options line must not be duplicated');
expect_true(file_get_contents($authorizedPath)===$optionedEdLine,'deduplicating a restricted key must not append a second unrestricted authorization');
expect_true(add_key($syntheticRsa)==='Public key installed.','a distinct key must be appended successfully');
expect_true(file_get_contents($authorizedPath)===$optionedEdLine."\n".$syntheticRsa."\n",'append must add a separating LF when existing authorized_keys has no final newline');
expect_true((fileperms($authorizedPath)&0777)===0600&&(fileowner($authorizedPath)===posix_geteuid()),'atomic key writes must preserve the DirectAdmin owner and restrictive authorized_keys mode');
expect_true(add_key($syntheticRsa.' another comment')==='Key already installed.','same RSA key material with a changed comment must remain a duplicate');
$duplicateEdLines=$commentedEdLine."\n".$optionedEdLine."\n".$edMaterial.' trailing-backslash\\' ."\n".$rsaMaterial."\n";
expect_true(file_put_contents($authorizedPath,$duplicateEdLines)!==false,'duplicate-comment revocation fixture must be written');
chmod($authorizedPath,0600);
$beforeRevokeFingerprints=fingerprints();
expect_true(count($beforeRevokeFingerprints)===3&&$beforeRevokeFingerprints[0][0]===0&&$beforeRevokeFingerprints[1][0]===1&&$beforeRevokeFingerprints[2][0]===2,'blank/comment lines must be excluded from displayed key row indexes');
expect_true(remove_key(0,$expectedEdIdentity['fingerprint'])==='Key revoked.','revoking one displayed duplicate fingerprint row must report success');
expect_true(file_get_contents($authorizedPath)===$commentedEdLine."\n".$rsaMaterial."\n",'revocation must remove every active matching key-material line and preserve comment lines and unrelated keys');
$reorderedKeys=$commentedEdLine."\n".$rsaMaterial." rsa-row\n".$optionedEdLine."\n";
expect_true(file_put_contents($authorizedPath,$reorderedKeys)!==false,'reordered two-client revocation fixture must be written');
chmod($authorizedPath,0600);
expect_true(remove_key(0,$expectedEdIdentity['fingerprint'])==='Key list changed; reload before revoking.','stale displayed key identity must not revoke a different key that moved into the old row');
expect_true(file_get_contents($authorizedPath)===$reorderedKeys,'a stale revocation attempt must not alter authorized_keys');
expect_true(remove_key(1,$expectedEdIdentity['fingerprint'])==='Key revoked.','a refreshed row index paired with its displayed fingerprint must revoke the selected key');
expect_true(file_get_contents($authorizedPath)===$commentedEdLine."\n".$rsaMaterial." rsa-row\n",'fresh revocation must preserve unrelated comments and the other account key');
expect_true(remove_key(0,'SHA256:invalid')==='Key list changed; reload before revoking.','malformed displayed fingerprints must fail closed');
$outsideAuthorizedKeys=$root.'/outside-authorized-keys';
expect_true(file_put_contents($outsideAuthorizedKeys,'sentinel-do-not-change')!==false,'outside symlink sentinel must be created');
expect_true(unlink($authorizedPath)&&symlink($outsideAuthorizedKeys,$authorizedPath),'authorized_keys symlink failure fixture must be installed');
expect_true(add_key($syntheticEd25519)==='Unable to update authorized_keys safely.','unsafe authorized_keys path must return an accurate failure instead of success');
expect_true(file_get_contents($outsideAuthorizedKeys)==='sentinel-do-not-change','unsafe authorized_keys symlink target must remain untouched');
expect_true(unlink($authorizedPath),'unsafe authorized_keys symlink fixture must be removed');
$terminalFields='csrf='.str_repeat('a',64).'&add_key=1';
$terminalLength=strlen($terminalFields);
expect_true(directadmin_request_body_length_matches($terminalFields,$terminalLength),'exact CONTENT_LENGTH must match the unmodified form body');
expect_true(directadmin_request_body_length_matches($terminalFields."\n",$terminalLength),'one terminal LF may be present beyond CONTENT_LENGTH');
expect_true(directadmin_request_body_length_matches($terminalFields."\r\n",$terminalLength),'one terminal CRLF may be present beyond CONTENT_LENGTH');
expect_true(!directadmin_request_body_length_matches($terminalFields."\n\n",$terminalLength),'two terminal LF bytes beyond CONTENT_LENGTH must fail');
expect_true(!directadmin_request_body_length_matches($terminalFields.'x',$terminalLength),'arbitrary CONTENT_LENGTH mismatch must fail');

$nulTerminatedFields=$terminalFields."\0";
expect_true(directadmin_request_terminal_byte_class($terminalFields)==='printable'&&directadmin_request_terminal_byte_class($terminalFields."\n")==='lf'&&directadmin_request_terminal_byte_class($terminalFields."\r\n")==='crlf','terminal-byte diagnostic must return only a bounded fixed class');
expect_true(directadmin_request_terminal_byte_class($nulTerminatedFields)==='nul','raw NUL terminal must be classified without exposing its byte value');
expect_true(directadmin_normalize_stdin_transport_terminator("\0",null)==="\0",'a NUL-only stdin body must not normalize into an empty request');
expect_true(directadmin_normalize_stdin_transport_terminator($nulTerminatedFields,null)===$terminalFields,'one terminal raw NUL may be normalized when CONTENT_LENGTH is unavailable');
expect_true(directadmin_normalize_stdin_transport_terminator($nulTerminatedFields,$terminalLength)===$terminalFields,'one terminal raw NUL may be normalized when CONTENT_LENGTH matches the form prefix');
expect_true(directadmin_normalize_stdin_transport_terminator($nulTerminatedFields,strlen($nulTerminatedFields))===$nulTerminatedFields,'a NUL included in declared CONTENT_LENGTH must not be normalized');
expect_true(directadmin_normalize_stdin_transport_terminator($terminalFields."\0\0",null)===$terminalFields."\0\0",'repeated terminal raw NUL bytes must not be normalized');
expect_true(directadmin_normalize_stdin_transport_terminator("csrf=valid\0&run=1",null)==="csrf=valid\0&run=1",'interior raw NUL bytes must not be normalized');
expect_true(!directadmin_request_body_length_matches($nulTerminatedFields,$terminalLength),'raw NUL is not a generic form length terminator');

$diagnosticReasons=[
 'Invalid content length.'=>'content_length_invalid',
 'Unsupported form content type.'=>'content_type_invalid',
 'Raw DirectAdmin POST body is unavailable.'=>'raw_post_missing',
 'Invalid DirectAdmin POST marker.'=>'post_marker_invalid',
 'Duplicate form field.'=>'duplicate_field',
 'Form fields cannot be supplied in the query string.'=>'query_form_fields',
 'Ambiguous form action.'=>'action_ambiguous',
 'Request body length mismatch.'=>'body_length_mismatch'
];
foreach($diagnosticReasons as $message=>$code) expect_true(directadmin_request_error_code(new RuntimeException($message))===$code,'request error text must map only to static code '.$code);
expect_true(directadmin_request_error_code(new RuntimeException('synthetic-secret-value=must-not-render'))==='request_rejected','unknown request errors must map to a static fallback code');
$_SERVER['TDA_REQUEST_DIAGNOSTIC']=['code'=>'body_length_mismatch','transport'=>'stdin','declared_bytes'=>123,'body_bytes_read'=>125,'terminal_class'=>'nul'];
expect_true(directadmin_request_diagnostic_summary()==='code=body_length_mismatch transport=stdin declared_bytes=123 body_bytes_read=125 terminal_class=nul','request diagnostics must expose only bounded reason, transport, numeric lengths and fixed terminal-byte class');
$_SERVER['TDA_REQUEST_DIAGNOSTIC']=['code'=>'synthetic-secret','transport'=>'/home/private','declared_bytes'=>'secret','body_bytes_read'=>'secret','terminal_class'=>'csrf=must-not-render'];
expect_true(directadmin_request_diagnostic_summary()==='code=request_rejected transport=unknown declared_bytes=unknown body_bytes_read=unknown terminal_class=unknown','diagnostic output must reject unallowlisted codes, transports, lengths and terminal classes');
unset($_SERVER['TDA_REQUEST_DIAGNOSTIC']);
expect_true((directadmin_parse_form_body($terminalFields."\n")['add_key']??null)==='1','one DirectAdmin transport LF must be normalized after the complete form');
expect_true((directadmin_parse_form_body($terminalFields."\r\n")['add_key']??null)==='1','one DirectAdmin transport CRLF must be normalized after the complete form');
expect_rejected(static function()use($terminalFields){directadmin_parse_form_body($terminalFields."\n\n");},'multiple form terminators must remain rejected');
expect_rejected(static function(){directadmin_parse_form_body('csrf=valid&csrf=second');},'duplicate form fields must fail closed');
expect_rejected(static function(){directadmin_parse_form_body('csrf%5B%5D=valid');},'array form fields must fail closed');
expect_rejected(static function(){directadmin_parse_form_body('csrf=valid&remove_key=0');},'key revocation without a displayed fingerprint binding must fail closed');
expect_rejected(static function(){directadmin_parse_form_body('csrf=valid&expected_fingerprint=SHA256%3Ainvalid');},'a displayed fingerprint without a revoke row must fail closed');
expect_rejected(static function(){directadmin_parse_form_body('csrf=valid&remove_key=0&expected_fingerprint%5B%5D=SHA256%3Ainvalid');},'array fingerprint bindings must fail closed');
expect_rejected(static function(){directadmin_parse_form_body('csrf=%ZZ');},'malformed percent encoding must fail closed');

expect_rejected(static function()use($terminalFields){directadmin_parse_form_body($terminalFields."\0");},'raw terminal NUL must remain rejected by the strict parser outside the stdin transport boundary');
expect_rejected(static function(){directadmin_parse_form_body('csrf=valid&command=pwd%00&run=1');},'percent-encoded NUL in a form value must fail closed');
expect_rejected(static function(){directadmin_parse_form_body('csrf=valid&cwd=/home'."\0".'/admin');},'interior raw NUL in a form value must fail closed');
expect_rejected(static function(){directadmin_parse_form_body('csrf=valid&command=%FF');},'invalid UTF-8 in a decoded form value must fail closed');

expect_rejected(static function(){directadmin_parse_form_body('csrf='.str_repeat('a',16385));},'oversized form bodies must fail closed');
expect_rejected(static function(){directadmin_parse_form_body('csrf=valid&run=1&add_key=1');},'multiple actions in one request must fail closed');
$other=posix_getpwnam(posix_geteuid()===0?'nobody':'root');
if($other&&isset($other['uid'])&&(int)$other['uid']!==posix_geteuid()){
 putenv('USERNAME='.$other['name']);
 putenv('USER='.$other['name']);
 putenv('HOME='.$other['dir']);
 expect_true(directadmin_identity_context()===null,'cross-account environment identity must be rejected');
 putenv('USERNAME='.$account['name']);
 putenv('USER='.$account['name']);
 putenv('HOME='.$home);
}

expect_true(path_within($home,$home)===true,'home must be accepted');
expect_true(path_within($home.'/repo',$home)===true,'descendant must be accepted');
expect_true(path_within($sibling,$home)===false,'sibling-prefix path must be rejected');
expect_true(safe_cwd($sibling)===$home,'safe_cwd must fall back to HOME for sibling-prefix escape');

$outside=$root.'/outside';
mkdir($outside,0700,true);
$link=$home.'/escape-link';
if(function_exists('symlink') && @symlink($outside,$link)){
 expect_true(safe_cwd($link)===$home,'symlink escape must resolve outside HOME and be rejected');
}

[$class,, $allowed]=command_policy('git status');
expect_true($allowed===true && $class==='READ','git status must be allowed as READ');

[$class,, $allowed]=command_policy('git push origin main');
expect_true($allowed===false && $class==='WRITE','git push must fail closed as WRITE');

[$class,, $allowed]=command_policy('rm -rf .');
expect_true($allowed===false && $class==='UNKNOWN','unknown/destructive command must fail closed');

[$class,, $allowed]=command_policy('git status; whoami');
expect_true($allowed===false && $class==='UNKNOWN','shell chaining must fail closed');

[$class,, $allowed]=command_policy('cat /etc/passwd');
expect_true($allowed===false && $class==='UNKNOWN','absolute-path reads must fail closed');

foreach([
 'cat README.md',
 'grep -F marker README.md',
 'head -n 1 README.md',
 'tail -n 1 README.md',
 'ls -la',
 'du -sh',
 'stat README.md',
 'php -l README.php',
 'date -f .ssh/id_rsa',
 'df -h README.md',
 'pwd README.md',
 'id .ssh/id_rsa'
] as $pathSelectingCommand){
 [$pathClass,, $pathAllowed]=command_policy($pathSelectingCommand);
 expect_true($pathAllowed===false&&$pathClass==='UNKNOWN',$pathSelectingCommand.' must not select or reopen a user pathname from a child process');
}

[$class,, $allowed]=command_policy('pwd');
expect_true($allowed===true&&$class==='READ','pathless working-directory inspection must remain available');
[$class,, $allowed]=command_policy('df -h');
expect_true($allowed===true&&$class==='VERIFY','pathless disk-space diagnostics must remain available');
[$class,, $allowed]=command_policy('php --version');
expect_true($allowed===true&&$class==='VERIFY','PHP runtime diagnostics must remain available without a source path');

[$class,, $allowed]=command_policy('npm exec rm -rf .');
expect_true($allowed===false && $class==='UNKNOWN','package exec must fail closed because package-manager commands can run account code');
foreach(['npm test','pnpm run verify','composer test','npm --version','node --test'] as $scriptCommand){
 [$scriptClass,, $scriptAllowed]=command_policy($scriptCommand);
 expect_true($scriptAllowed===false&&$scriptClass==='UNKNOWN',$scriptCommand.' must not execute project code with access to account HOME');
}

[$class,, $allowed]=command_policy('php -r phpinfo();');
expect_true($allowed===false && $class==='UNKNOWN','arbitrary PHP execution must fail closed');

[$class,, $allowed]=command_policy('echo $(id)');
expect_true($allowed===false && $class==='UNKNOWN','shell expansion must fail closed');

$redacted=redact_text("token=abc123\nAuthorization: Bearer super-secret\npassword=hunter2\nremote=https://synthetic-user:synthetic-token@example.invalid/repo.git");
expect_true(strpos($redacted,'abc123')===false,'token value must be redacted');
expect_true(strpos($redacted,'super-secret')===false,'bearer token must be redacted');
expect_true(strpos($redacted,'hunter2')===false,'password must be redacted');
expect_true(strpos($redacted,'synthetic-user')===false&&strpos($redacted,'synthetic-token')===false,'URL userinfo must be redacted from command output');
expect_true(strpos($redacted,'example.invalid/repo.git')!==false,'URL redaction should preserve non-secret destination context');

$gitRepo=$home.'/git-repo';
expect_true(mkdir($gitRepo,0700,true),'isolated Git repository fixture must be created');
$gitDescriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
$gitInit=@proc_open(['git','-c','init.defaultBranch=main','init','--quiet',$gitRepo],$gitDescriptors,$gitPipes,$home,[
 'PATH'=>getenv('PATH')?:'/usr/local/bin:/usr/bin:/bin',
 'HOME'=>$home,
 'GIT_CONFIG_NOSYSTEM'=>'1',
 'GIT_CONFIG_GLOBAL'=>'/dev/null'
],['bypass_shell'=>true]);
expect_true(is_resource($gitInit),'synthetic local Git repository must initialize');
fclose($gitPipes[0]);
$gitInitOut=(string)stream_get_contents($gitPipes[1]);
$gitInitErr=(string)stream_get_contents($gitPipes[2]);
fclose($gitPipes[1]); fclose($gitPipes[2]);
expect_true(proc_close($gitInit)===0&&$gitInitOut===''&&$gitInitErr==='','synthetic Git fixture must initialize without errors');
expect_true(directadmin_git_metadata_tree_safe($gitRepo.'/.git',$home,1)===false,'metadata traversal must stop at a small configured entry bound');
$gitContext=directadmin_git_repository_context($gitRepo);
expect_true(is_array($gitContext)&&$gitContext['root']===$gitRepo,'ordinary HOME-contained Git root and gitdir must be accepted');
[$gitStatus,$gitStatusExit,$gitStatusClass]=run_cmd('git status --short',$gitRepo);
expect_true($gitStatusExit===126&&$gitStatusClass==='READ'&&strpos($gitStatus,'Git inspection is unavailable')!==false,'repository Git inspection must fail closed while configuration isolation is pending');

expect_true(directadmin_git_parse_divergence("1\t2")===['ahead'=>1,'behind'=>2],'Git divergence parser must read bounded ahead/behind counts');
foreach(['','1 2',"01\t2","1\t02","1\t2 extra","99999999999\t1","-1\t0"] as $invalidDivergence){
 expect_true(directadmin_git_parse_divergence($invalidDivergence)===null,'malformed or oversized Git divergence must fail closed');
}
foreach(['git rev-list --left-right --count HEAD...@{u}','git rev-parse --symbolic-full-name @{u}'] as $internalOnlyGitCommand){
 [$internalClass,, $internalAllowed]=command_policy($internalOnlyGitCommand);
 expect_true($internalAllowed===false&&$internalClass==='UNKNOWN',$internalOnlyGitCommand.' must not widen the user-facing Git command policy');
}

$workflowRepo=$home.'/workflow-readiness';
expect_true(mkdir($workflowRepo,0700,true),'workflow readiness repository fixture must be created');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'init','--quiet'],$home),'workflow readiness repository must initialize');
expect_true(file_put_contents($workflowRepo.'/base.txt','base')!==false,'workflow base file must be written');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'add','--','base.txt'],$home),'workflow base file must be staged');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'-c','user.name=Developer Portal Security Test','-c','user.email=dev-portal-security-test@example.invalid','commit','--quiet','--message','workflow base'],$home),'workflow base commit must be created');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'branch','--move','agent/issue-1048'],$home),'canonical claim fixture branch must be created');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'switch','--quiet','--create','upstream-side'],$home),'upstream fixture branch must be created');
expect_true(file_put_contents($workflowRepo.'/upstream.txt','upstream')!==false,'upstream side file must be written');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'add','--','upstream.txt'],$home),'upstream side file must be staged');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'-c','user.name=Developer Portal Security Test','-c','user.email=dev-portal-security-test@example.invalid','commit','--quiet','--message','upstream fixture'],$home),'upstream-side commit must be created');
[$upstreamHeadExit,$upstreamHead,$upstreamHeadError]=run_security_git_capture(['-C',$workflowRepo,'rev-parse','HEAD'],$home);
expect_true($upstreamHeadExit===0&&$upstreamHeadError===''&&preg_match('/^[0-9a-f]{40}$/D',trim($upstreamHead))===1,'upstream fixture commit must resolve');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'switch','--quiet','agent/issue-1048'],$home),'canonical claim fixture branch must be checked out');
expect_true(file_put_contents($workflowRepo.'/local.txt','local')!==false,'local side file must be written');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'add','--','local.txt'],$home),'local side file must be staged');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'-c','user.name=Developer Portal Security Test','-c','user.email=dev-portal-security-test@example.invalid','commit','--quiet','--message','local fixture'],$home),'local-side commit must be created');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'update-ref','refs/remotes/origin/agent/issue-1048',trim($upstreamHead)],$home),'local cached upstream ref must be installed');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'config','branch.agent/issue-1048.remote','origin'],$home),'fixture upstream remote name must be configured');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'config','branch.agent/issue-1048.merge','refs/heads/agent/issue-1048'],$home),'fixture upstream branch must be configured');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'remote','add','origin','https://synthetic-user:synthetic-token@example.invalid/repository.git'],$home),'credential-shaped fixture remote must be configured without connecting');
$workflowContext=directadmin_git_repository_context($workflowRepo);
expect_true(is_array($workflowContext),'workflow readiness fixture must pass the HOME-bounded repository resolver');
if(false){
$workflowHeadProbe=directadmin_git_probe($workflowContext,['rev-parse','--verify','HEAD']);
$workflowHeadBefore=directadmin_git_probe_output($workflowHeadProbe);
expect_true(($workflowHeadProbe['status']??null)==='success'&&is_string($workflowHeadBefore)&&preg_match('/^[0-9a-f]{40}$/D',$workflowHeadBefore)===1,'successful Git probes must retain their output and success state');
$workflowConfigBefore=hash_file('sha256',$workflowRepo.'/.git/config');
$workflowReadiness=codex_readiness($workflowRepo,[],['git'=>'/usr/bin/git']);
expect_true($workflowReadiness['git_claim_branch_format_valid']===true&&$workflowReadiness['git_claim_issue_number']==='1048','canonical issue branch must be identified without asserting remote ownership');
expect_true($workflowReadiness['git_repository_state']==='available'&&$workflowReadiness['git_branch_state']==='named'&&$workflowReadiness['git_head_state']==='available','successful repository, branch and HEAD probes must have explicit available states');
expect_true($workflowReadiness['git_upstream_configured']===true&&$workflowReadiness['git_ahead']===1&&$workflowReadiness['git_behind']===1,'local-only comparison must report one ahead and one behind commit');
expect_true($workflowReadiness['git_dirty']===false&&$workflowReadiness['git_worktree_state']==='clean','successful empty status output must mean clean, not unknown');
$workflowJson=json_encode($workflowReadiness);
expect_true(is_string($workflowJson)&&strpos($workflowJson,'synthetic-user')===false&&strpos($workflowJson,'synthetic-token')===false&&strpos($workflowJson,'example.invalid')===false,'workflow readiness must never expose remote URLs or credentials');
$workflowHeadAfter=directadmin_git_probe($workflowContext,['rev-parse','--verify','HEAD']);
expect_true(($workflowHeadAfter['status']??null)==='success'&&directadmin_git_probe_output($workflowHeadAfter)===$workflowHeadBefore,'workflow readiness must not move HEAD or create commits');
expect_true(hash_file('sha256',$workflowRepo.'/.git/config')===$workflowConfigBefore,'workflow readiness must not modify Git configuration');
$workflowStatusAfter=directadmin_git_probe($workflowContext,['status','--porcelain']);
expect_true(($workflowStatusAfter['status']??null)==='success'&&directadmin_git_probe_output($workflowStatusAfter)==='','workflow readiness must not modify the worktree');

$dirtyMarker=$workflowRepo.'/readiness-dirty.txt';
expect_true(file_put_contents($dirtyMarker,'dirty')!==false,'dirty-worktree fixture marker must be written');
$dirtyReadiness=codex_readiness($workflowRepo,[],['git'=>'/usr/bin/git']);
expect_true($dirtyReadiness['git_repository_state']==='available'&&$dirtyReadiness['git_dirty']===true&&$dirtyReadiness['git_worktree_state']==='dirty','successful nonempty status output must be reported as dirty');
expect_true(unlink($dirtyMarker),'dirty-worktree fixture marker must be removed');
$cleanAgain=codex_readiness($workflowRepo,[],['git'=>'/usr/bin/git']);
expect_true($cleanAgain['git_dirty']===false&&$cleanAgain['git_worktree_state']==='clean','worktree must return to clean after fixture cleanup');

expect_true(run_security_git_fixture(['-C',$workflowRepo,'switch','--quiet','--detach','HEAD'],$home),'detached HEAD fixture must be created');
$detachedReadiness=codex_readiness($workflowRepo,[],['git'=>'/usr/bin/git']);
expect_true($detachedReadiness['git_repository']===true&&$detachedReadiness['git_branch']===null&&$detachedReadiness['git_branch_state']==='detached','successful empty branch output must be distinguished as detached');
expect_true($detachedReadiness['git_claim_branch_format_valid']===false&&$detachedReadiness['git_worktree_state']==='clean','detached HEAD is known noncanonical and must not imply a dirty or failed probe');
expect_true(run_security_git_fixture(['-C',$workflowRepo,'switch','--quiet','agent/issue-1048'],$home),'canonical claim branch fixture must be restored');

$oversizedNames=[];
for($i=0;$i<44;$i++){
 $name='oversized-status-'.str_pad((string)$i,3,'0',STR_PAD_LEFT).'-'.str_repeat('x',190);
 expect_true(file_put_contents($workflowRepo.'/'.$name,'x')!==false,'oversized status fixture file must be written');
 $oversizedNames[]=$workflowRepo.'/'.$name;
}
$oversizedProbe=directadmin_git_probe($workflowContext,['status','--porcelain']);
expect_true(($oversizedProbe['status']??null)==='unknown'&&($oversizedProbe['reason']??null)==='output_oversized','Git probe output beyond its existing 8192-byte bound must be unknown');
$oversizedReadiness=codex_readiness($workflowRepo,[],['git'=>'/usr/bin/git']);
expect_true($oversizedReadiness['git_repository']===true&&$oversizedReadiness['git_dirty']===null&&$oversizedReadiness['git_worktree_state']==='unknown','oversized status output must not be misreported as clean');
foreach($oversizedNames as $oversizedName) expect_true(unlink($oversizedName),'oversized status fixture file must be removed');
$cleanAfterOversized=codex_readiness($workflowRepo,[],['git'=>'/usr/bin/git']);
expect_true($cleanAfterOversized['git_dirty']===false&&$cleanAfterOversized['git_worktree_state']==='clean','worktree state must recover after oversized fixture cleanup');
}
$disabledProbe=directadmin_git_probe($workflowContext,['status','--porcelain']);
expect_true(($disabledProbe['status']??null)==='unknown'&&($disabledProbe['reason']??null)==='git_inspection_disabled','repository Git probes must fail closed while configuration isolation is pending');
$disabledReadiness=codex_readiness($workflowRepo,[],['git'=>'/usr/bin/git']);
expect_true($disabledReadiness['git_repository_state']==='unknown'&&$disabledReadiness['git_dirty']===null&&$disabledReadiness['git_worktree_state']==='unknown','automatic readiness must remain unknown while repository Git inspection is disabled');

$successRepositoryProbe=['status'=>'success','output'=>'true','reason'=>null];
$successBranchProbe=['status'=>'success','output'=>'agent/issue-1048','reason'=>null];
$successHeadProbe=['status'=>'success','output'=>'abcdef012345','reason'=>null];
$timeoutProbe=['status'=>'unknown','output'=>null,'reason'=>'timeout'];
$failedStatusProjection=directadmin_git_readiness_projection(true,$successRepositoryProbe,$successBranchProbe,$successHeadProbe,$timeoutProbe,$timeoutProbe);
expect_true($failedStatusProjection['git_repository']===true&&$failedStatusProjection['git_dirty']===null&&$failedStatusProjection['git_worktree_state']==='unknown','timed-out status probe must remain unknown, not appear clean');
expect_true($failedStatusProjection['git_claim_branch_format_valid']===true&&$failedStatusProjection['git_upstream_configured']===null&&$failedStatusProjection['git_upstream_state']==='unknown','failed upstream probe must not mark a canonical branch invalid or claim that upstream is absent');
$failedBranchProjection=directadmin_git_readiness_projection(true,$successRepositoryProbe,$timeoutProbe,$successHeadProbe,['status'=>'success','output'=>'','reason'=>null],$timeoutProbe);
expect_true($failedBranchProjection['git_repository']===true&&$failedBranchProjection['git_branch']===null&&$failedBranchProjection['git_branch_state']==='unknown'&&$failedBranchProjection['git_claim_branch_format_valid']===null,'failed branch probe must be unknown, not detached or noncanonical');
$failedRepositoryProjection=directadmin_git_readiness_projection(true,$timeoutProbe,null,null,null,null);
expect_true($failedRepositoryProjection['git_repository']===null&&$failedRepositoryProjection['git_repository_state']==='unknown'&&$failedRepositoryProjection['git_claim_branch_format_valid']===null,'failed repository probe must not be reported as a non-repository or invalid claim');

expect_true(run_security_git_fixture(['-C',$workflowRepo,'switch','--quiet','--create','agent/issue-01048'],$home),'noncanonical padded issue branch fixture must be created');
$paddedContext=directadmin_git_repository_context($workflowRepo);
expect_true(is_array($paddedContext),'padded branch repository context must remain HOME-bounded');
$missingUpstreamProbe=directadmin_git_probe($paddedContext,['rev-list','--left-right','--count','HEAD...@{u}']);
expect_true(($missingUpstreamProbe['status']??null)==='unknown'&&($missingUpstreamProbe['reason']??null)==='git_inspection_disabled','padded branch Git probe must remain unavailable while repository inspection is disabled');
$paddedReadiness=codex_readiness($workflowRepo,[],['git'=>'/usr/bin/git']);
expect_true($paddedReadiness['git_claim_branch_format_valid']===false&&$paddedReadiness['git_claim_issue_number']===null,'padded issue numbers must not be shown as canonical claim branches');
expect_true($paddedReadiness['git_upstream_configured']===null&&$paddedReadiness['git_upstream_state']==='unknown'&&$paddedReadiness['git_ahead']===null&&$paddedReadiness['git_behind']===null,'failed/missing upstream probe must produce unknown state and unknown divergence counts');
$notRepo=$home.'/not-a-repository';
expect_true(mkdir($notRepo,0700,true),'non-repository fixture must be created');
$notRepoReadiness=codex_readiness($notRepo,[],['git'=>'/usr/bin/git']);
expect_true($notRepoReadiness['git_repository']===false&&$notRepoReadiness['git_repository_state']==='unavailable'&&$notRepoReadiness['git_claim_branch_format_valid']===null&&$notRepoReadiness['git_upstream_configured']===null,'unavailable repository context must not mark claim/upstream data as invalid');

$textconvHelper=$home.'/synthetic-textconv-helper';
$textconvMarker=$home.'/synthetic-textconv-marker';
$textconvScript="#!/bin/sh\nprintf invoked >> ".escapeshellarg($textconvMarker)."\ncat \"$1\"\n";
expect_true(file_put_contents($textconvHelper,$textconvScript)!==false,'synthetic textconv helper must be created');
expect_true(chmod($textconvHelper,0700),'synthetic textconv helper must be executable');
expect_true(file_put_contents($gitRepo.'/.gitattributes',"*.synthetic diff=synthetic\n")!==false,'synthetic textconv attribute must be created');
expect_true(file_put_contents($gitRepo.'/textconv.synthetic',"\0before\n")!==false,'binary textconv fixture must be created');
expect_true(run_security_git_fixture(['-C',$gitRepo,'add','--','.gitattributes','textconv.synthetic'],$home),'binary textconv fixture must be staged');
expect_true(run_security_git_fixture(['-C',$gitRepo,'-c','user.name=Developer Portal Security Test','-c','user.email=dev-portal-security-test@example.invalid','commit','--quiet','--message','textconv helper fixture'],$home),'binary textconv fixture must be committed');
expect_true(run_security_git_fixture(['-C',$gitRepo,'config','diff.synthetic.textconv',$textconvHelper],$home),'repo-local textconv fixture must be configured');
expect_true(file_put_contents($gitRepo.'/textconv.synthetic',"\0after\n")!==false,'binary textconv fixture must be changed');
[$unboundedDiffExit,, $unboundedDiffError]=run_security_git_capture(['-C',$gitRepo,'diff'],$home);
expect_true($unboundedDiffExit===0&&$unboundedDiffError===''&&is_file($textconvMarker),'unbounded Git diff must prove the synthetic repository textconv helper can execute');
expect_true(unlink($textconvMarker),'synthetic textconv marker must be reset before bounded-command controls');
foreach(['diff --stat','diff --name-only'] as $allowedDiffCommand){
 [$rawAllowedDiffExit,$rawAllowedDiffOutput,$rawAllowedDiffError]=run_security_git_capture(array_merge(['-C',$gitRepo],preg_split('/\\s+/',$allowedDiffCommand)),$home);
 expect_true($rawAllowedDiffExit===0&&$rawAllowedDiffError===''&&$rawAllowedDiffOutput!=='','plain '.$allowedDiffCommand.' fixture control must work');
 expect_true(!is_file($textconvMarker),'plain '.$allowedDiffCommand.' must not execute textconv on the supported Git runner');
}
[$rawDiffClass,, $rawDiffAllowed]=command_policy('git diff');
expect_true($rawDiffAllowed===false&&$rawDiffClass==='UNKNOWN','unbounded Git diff remains outside the user-facing command allowlist');
$pagerEnvironment=directadmin_git_environment();
foreach(['diff','show'] as $gitSubcommand){
 $hardenedArguments=directadmin_git_command_args($gitContext,[$gitSubcommand,'HEAD']);
 expect_true(in_array('--no-textconv',$hardenedArguments,true),$gitSubcommand.' must explicitly disable repository textconv helpers');
 expect_true(in_array('--no-ext-diff',$hardenedArguments,true),$gitSubcommand.' must explicitly disable external diff helpers');
 expect_true(in_array('--no-pager',$hardenedArguments,true),$gitSubcommand.' must explicitly disable configured pagers');
}
expect_true(($pagerEnvironment['GIT_PAGER']??null)==='cat'&&($pagerEnvironment['PAGER']??null)==='cat','Git process environment must override configured pagers');
expect_true(($pagerEnvironment['GIT_NO_LAZY_FETCH']??null)==='1','Git process environment must disable promisor lazy fetches');
$filterMarker=$home.'/synthetic-filter-process-marker';
$filterHelper=$home.'/synthetic-filter-process-helper';
$filterScript="#!/bin/sh\nprintf invoked >> ".escapeshellarg($filterMarker)."\nexit 0\n";
expect_true(file_put_contents($filterHelper,$filterScript)!==false,'synthetic process-filter helper must be created');
expect_true(chmod($filterHelper,0700),'synthetic process-filter helper must be executable');
expect_true(file_put_contents($gitRepo.'/.gitattributes',"*.synthetic filter=synthetic-process\n",FILE_APPEND)!==false,'synthetic process-filter attribute must be created');
expect_true(file_put_contents($gitRepo.'/process.synthetic',"before\n")!==false,'synthetic process-filter fixture must be created');
expect_true(run_security_git_fixture(['-C',$gitRepo,'add','--','.gitattributes','process.synthetic'],$home),'synthetic process-filter fixture must be staged');
expect_true(run_security_git_fixture(['-C',$gitRepo,'-c','user.name=Developer Portal Security Test','-c','user.email=dev-portal-security-test@example.invalid','commit','--quiet','--message','process filter fixture'],$home),'synthetic process-filter fixture must be committed');
expect_true(run_security_git_fixture(['-C',$gitRepo,'config','filter.synthetic-process.process',$filterHelper],$home),'repo-local process-filter helper must be configured');
expect_true(file_put_contents($gitRepo.'/process.synthetic',"after\n")!==false,'synthetic process-filter fixture must be changed');
[$unboundedFilterExit,,]=run_security_git_capture(['-C',$gitRepo,'diff','--stat'],$home);
expect_true(is_file($filterMarker),'unbounded Git diff must prove the synthetic repository process filter can execute');
if(is_file($filterMarker)) expect_true(unlink($filterMarker),'synthetic process-filter marker must be reset before bounded-command controls');
$filterSafeArguments=directadmin_git_command_args($gitContext,['diff']);
expect_true(is_array($filterSafeArguments),'bounded Git arguments must remain available with a repository process filter configured');
[$safeFilterExit,$safeFilterOutput,$safeFilterError]=run_security_git_capture(array_slice($filterSafeArguments??[],1),$home);
expect_true($safeFilterExit===0&&$safeFilterError===''&&$safeFilterOutput!=='','bounded Git diff must remain readable with a hostile repository process filter configured');
expect_true(!is_file($filterMarker),'bounded Git diff must not execute the repository-configured process filter');
$filterReadiness=codex_readiness($gitRepo,[],['git'=>'/usr/bin/git']);
expect_true($filterReadiness['git_repository_state']==='unknown'&&$filterReadiness['git_dirty']===null&&$filterReadiness['git_worktree_state']==='unknown','automatic readiness must remain unknown while repository Git inspection is disabled');
$cleanRepo=$home.'/git-clean-filter';
expect_true(mkdir($cleanRepo,0700,true),'synthetic clean-filter repository must be created');
expect_true(run_security_git_fixture(['init','--quiet',$cleanRepo],$home),'synthetic clean-filter repository must initialize');
$cleanMarker=$home.'/synthetic-filter-clean-marker';
$cleanHelper=$home.'/synthetic-filter-clean-helper';
$cleanScript="#!/bin/sh\nprintf invoked >> ".escapeshellarg($cleanMarker)."\ncat\n";
expect_true(file_put_contents($cleanHelper,$cleanScript)!==false,'synthetic clean-filter helper must be created');
expect_true(chmod($cleanHelper,0700),'synthetic clean-filter helper must be executable');
expect_true(file_put_contents($cleanRepo.'/.gitattributes',"*.clean filter=synthetic-clean\n")!==false,'synthetic clean-filter attribute must be created');
expect_true(file_put_contents($cleanRepo.'/clean.clean',"before\n")!==false,'synthetic clean-filter fixture must be created');
expect_true(run_security_git_fixture(['-C',$cleanRepo,'add','--','.gitattributes','clean.clean'],$home),'synthetic clean-filter fixture must be staged');
expect_true(run_security_git_fixture(['-C',$cleanRepo,'-c','user.name=Developer Portal Security Test','-c','user.email=dev-portal-security-test@example.invalid','commit','--quiet','--message','clean filter fixture'],$home),'synthetic clean-filter fixture must be committed');
expect_true(run_security_git_fixture(['-C',$cleanRepo,'config','filter.synthetic-clean.clean',$cleanHelper],$home),'repo-local clean-filter helper must be configured');
expect_true(file_put_contents($cleanRepo.'/clean.clean',"after\n")!==false,'synthetic clean-filter fixture must be changed');
$cleanContext=directadmin_git_repository_context($cleanRepo);
expect_true(is_array($cleanContext),'synthetic clean-filter repository context must remain available');
[$unboundedCleanExit,,]=run_security_git_capture(['-C',$cleanRepo,'diff','--stat'],$home);
expect_true(is_file($cleanMarker),'unbounded Git diff must prove the synthetic repository clean filter can execute');
if(is_file($cleanMarker)) expect_true(unlink($cleanMarker),'synthetic clean-filter marker must be reset before bounded-command controls');
$cleanSafeArguments=directadmin_git_command_args($cleanContext,['diff']);
expect_true(is_array($cleanSafeArguments)&&in_array('filter.synthetic-clean.clean=',$cleanSafeArguments,true),'bounded Git arguments must override repository clean filters');
[$safeCleanExit,$safeCleanOutput,$safeCleanError]=run_security_git_capture(array_slice($cleanSafeArguments,1),$home);
expect_true($safeCleanExit===0&&$safeCleanError===''&&$safeCleanOutput!=='','bounded Git diff must remain readable with a hostile repository clean filter configured');
expect_true(!is_file($cleanMarker),'bounded Git diff must not execute the repository-configured clean filter');
$gitConfigPath=$gitRepo.'/.git/config';
$gitConfigBefore=file_get_contents($gitConfigPath);
expect_true(is_string($gitConfigBefore),'synthetic Git config must remain readable before include-config regression');
$alternateFilterConfig=$gitConfigBefore."\n[filter \"commented-process\"] # valid Git header comment\n process = /synthetic/commented-helper\n[filter.dotted-process] # deprecated dotted subsection form\n process = /synthetic/dotted-helper\nfilter.same-line.process = /synthetic/same-line-helper\n";
expect_true(file_put_contents($gitConfigPath,$alternateFilterConfig)!==false,'alternate Git filter header forms must be written');
$alternateFilterArguments=directadmin_git_command_args($gitContext,['status']);
expect_true(is_array($alternateFilterArguments)&&in_array('filter.commented-process.process=',$alternateFilterArguments,true)&&in_array('filter.dotted-process.process=',$alternateFilterArguments,true)&&in_array('filter.same-line.process=',$alternateFilterArguments,true),'commented, dotted and same-line filter syntax must be recognized before any Git execution');
expect_true(($alternateProbe=directadmin_git_probe($gitContext,['status','--porcelain']))['reason']==='git_inspection_disabled','alternate filter syntax must not re-enable repository Git execution');
expect_true(file_put_contents($gitConfigPath,$gitConfigBefore)!==false,'alternate Git filter header fixture must be restored');
$includedFilterConfig=$gitRepo.'/.git/included-filter.config';
expect_true(file_put_contents($includedFilterConfig,"[filter \"included-process\"]\n process = ".$filterHelper."\n")!==false,'synthetic included filter config must be written');
expect_true(file_put_contents($gitConfigPath,$gitConfigBefore."\n[include]\n path = included-filter.config\n")!==false,'synthetic include config must be enabled');
$includedProbe=directadmin_git_probe($gitContext,['status','--porcelain']);
expect_true(($includedProbe['status']??null)==='unknown'&&($includedProbe['reason']??null)==='git_inspection_disabled','included Git filter configuration must remain unavailable before Git starts');
$includedReadiness=codex_readiness($gitRepo,[],['git'=>'/usr/bin/git']);
expect_true($includedReadiness['git_repository_state']==='unknown'&&$includedReadiness['git_dirty']===null,'readiness must remain unknown when an included Git config could introduce a process filter');
expect_true(file_put_contents($gitConfigPath,$gitConfigBefore)!==false&&unlink($includedFilterConfig),'included filter config regression must restore the synthetic repository');
$worktreeConfig=$gitRepo.'/.git/config.worktree';
expect_true(file_put_contents($worktreeConfig,"[filter \"worktree-process\"]\n process = ".$filterHelper."\n")!==false,'synthetic worktree filter config must be written');
$worktreeFilterArguments=directadmin_git_command_args($gitContext,['status']);
expect_true(is_array($worktreeFilterArguments)&&in_array('filter.worktree-process.process=',$worktreeFilterArguments,true),'worktree config filters must be overridden before Git starts');
expect_true(unlink($worktreeConfig),'synthetic worktree filter config must be removed');
$enumeratedBeforeReplacement=directadmin_git_command_args($gitContext,['status']);
expect_true(is_array($enumeratedBeforeReplacement),'pre-replacement Git command shape must be generated');
expect_true(file_put_contents($gitConfigPath,$gitConfigBefore."\n[filter \"replacement-process\"]\n process = /synthetic/replacement-helper\n")!==false,'replacement filter config fixture must be written after command enumeration');
$replacementProbe=directadmin_git_probe($gitContext,['status','--porcelain']);
expect_true(($replacementProbe['reason']??null)==='git_inspection_disabled','config replacement after enumeration must remain unavailable and must not execute a newly introduced filter');
expect_true(file_put_contents($gitConfigPath,$gitConfigBefore)!==false,'replacement filter config fixture must be restored');
$safeDiffArguments=directadmin_git_command_args($gitContext,['diff']);
[$safeDiffExit,$safeDiffOutput,$safeDiffError]=run_security_git_capture(array_slice($safeDiffArguments,1),$home);
expect_true($safeDiffExit===0&&$safeDiffError===''&&$safeDiffOutput!=='','bounded Git diff must continue to return read-only output');
expect_true(!is_file($textconvMarker),'bounded Git diff must not execute repository-configured textconv');
$safeShowArguments=directadmin_git_command_args($gitContext,['show','HEAD']);
[$safeShowExit,$safeShowOutput,$safeShowError]=run_security_git_capture(array_slice($safeShowArguments,1),$home);
expect_true($safeShowExit===0&&$safeShowError===''&&$safeShowOutput!=='','bounded Git show must continue to return read-only output');
expect_true(!is_file($textconvMarker),'bounded Git show must not execute repository-configured textconv');
[$diffStatOutput,$diffStatExit,$diffStatClass]=run_cmd('git diff --stat',$gitRepo);
expect_true($diffStatExit===126&&$diffStatClass==='READ'&&strpos($diffStatOutput,'Git inspection is unavailable')!==false,'repository Git diff statistics must fail closed while configuration isolation is pending');
[$diffNamesOutput,$diffNamesExit,$diffNamesClass]=run_cmd('git diff --name-only',$gitRepo);
expect_true($diffNamesExit===126&&$diffNamesClass==='READ'&&strpos($diffNamesOutput,'Git inspection is unavailable')!==false,'repository Git file names must fail closed while configuration isolation is pending');
[$showClass,, $showAllowed]=command_policy('git show --stat');
expect_true($showAllowed===false&&$showClass==='UNKNOWN','Git show remains outside the user-facing read-only command allowlist');

$externalMarker=$home.'/synthetic-external-diff-marker';
$externalHelper=$home.'/synthetic-external-diff-helper';
$externalScript="#!/bin/sh\nprintf invoked >> ".escapeshellarg($externalMarker)."\nexit 0\n";
expect_true(file_put_contents($externalHelper,$externalScript)!==false,'synthetic external diff helper must be created');
expect_true(chmod($externalHelper,0700),'synthetic external diff helper must be executable');
expect_true(run_security_git_fixture(['-C',$gitRepo,'config','diff.external',$externalHelper],$home),'repo-local external diff helper must be configured');
foreach(['diff --stat','diff --name-only'] as $allowedDiffCommand){
 $textconvMarkerPresent=is_file($textconvMarker);
 if($textconvMarkerPresent) expect_true(unlink($textconvMarker),'textconv marker must be cleared before '.$allowedDiffCommand);
 $allowedDiffArguments=directadmin_git_command_args($gitContext,preg_split('/\\s+/',$allowedDiffCommand));
 expect_true(is_array($allowedDiffArguments),'bounded '.$allowedDiffCommand.' arguments must be available');
 [$allowedDiffExit,$allowedDiffOutput,$allowedDiffError]=run_security_git_capture(array_slice($allowedDiffArguments,1),$home);
 expect_true($allowedDiffExit===0&&$allowedDiffError===''&&$allowedDiffOutput!=='','repo-configured external helper must not break '.$allowedDiffCommand);
 expect_true(!is_file($externalMarker)&&!is_file($textconvMarker),$allowedDiffCommand.' must not execute repository-configured external or textconv helpers');
 [$allowedDiffClass,, $allowedDiffPolicy]=command_policy('git '.$allowedDiffCommand);
 expect_true($allowedDiffPolicy===true&&$allowedDiffClass==='READ',$allowedDiffCommand.' must remain a read-only allowlisted command');
}
[$safeExternalDiffExit,$safeExternalDiffOutput,$safeExternalDiffError]=run_security_git_capture(array_slice($safeDiffArguments,1),$home);
expect_true($safeExternalDiffExit===0&&$safeExternalDiffError===''&&$safeExternalDiffOutput!=='','hardened Git diff must remain readable with a hostile repo-local external diff configured');
expect_true(!is_file($externalMarker),'bounded Git diff must not execute repository-configured external diff');
$linkedWorktree=$home.'/linked-contained';
expect_true(run_security_git_fixture(['-C',$gitRepo,'-c','user.name=Developer Portal Security Test','-c','user.email=dev-portal-security-test@example.invalid','commit','--allow-empty','--quiet','--message','linked worktree fixture'],$home),'synthetic repository must have a commit for linked-worktree coverage');
expect_true(run_security_git_fixture(['-C',$gitRepo,'-c','filter.synthetic-process.process=','-c','filter.synthetic-process.required=false','worktree','add','--detach','--quiet',$linkedWorktree,'HEAD'],$home),'HOME-contained linked worktree must be created for the positive regression');
expect_true(is_file($linkedWorktree.'/.git'),'linked worktree must use DirectAdmin Git pointer-file layout');
$linkedGitDir=directadmin_git_read_pointer($linkedWorktree.'/.git','gitdir',$linkedWorktree,$home,true);
expect_true($linkedGitDir!==null,'linked worktree gitdir pointer must resolve within HOME');
$commonPointerFile=$linkedGitDir.'/commondir';
$commonPointerReadable=is_file($commonPointerFile);
$commonPointerRaw=$commonPointerReadable?trim((string)file_get_contents($commonPointerFile)):'';
$commonPointerCandidate=$commonPointerRaw!==''?realpath($linkedGitDir.'/'.$commonPointerRaw):false;
expect_true($commonPointerReadable,'linked worktree common directory pointer file must exist');
expect_true($commonPointerCandidate!==false&&path_within($commonPointerCandidate,$home),'linked worktree common pointer target must resolve within HOME');
$linkedCommonDir=directadmin_git_read_pointer($commonPointerFile,'commondir',$linkedGitDir,$home,true);
expect_true($linkedCommonDir!==null,'linked worktree common directory pointer parser must accept its safe pointer');
$linkedBackPointer=directadmin_git_read_pointer($linkedGitDir.'/gitdir','worktree-gitdir',$linkedGitDir,$home,false);
expect_true($linkedBackPointer!==null&&$linkedBackPointer===realpath($linkedWorktree.'/.git'),'linked worktree reverse pointer must identify its .git file');
expect_true(directadmin_git_metadata_tree_safe($linkedGitDir,$home),'linked worktree private metadata must be safe');
expect_true(directadmin_git_metadata_tree_safe($linkedCommonDir,$home),'linked worktree common metadata must be safe');
$linkedContext=directadmin_git_repository_context($linkedWorktree);
expect_true(is_array($linkedContext)&&$linkedContext['root']===$linkedWorktree,'HOME-contained linked worktree must not be falsely rejected');
expect_true(path_within($linkedContext['git_dir'],$home)&&path_within($linkedContext['common_dir'],$home),'linked worktree and common metadata must both remain inside HOME');
[$linkedLog,$linkedLogExit,$linkedLogClass]=run_cmd('git log --oneline -5',$linkedWorktree);
expect_true($linkedLogExit===0&&$linkedLogClass==='READ'&&$linkedLog!=='','read-only Git inspection must work in a validated contained linked worktree');
expect_true(run_security_git_fixture(['-C',$gitRepo,'worktree','remove','--force',$linkedWorktree],$home),'contained linked-worktree fixture must clean up through Git');

$outsideRepo=$root.'/outside-git';
expect_true(mkdir($outsideRepo,0700,true),'external Git fixture must be created');
$outsideInit=@proc_open(['git','-c','init.defaultBranch=main','init','--quiet',$outsideRepo],$gitDescriptors,$outsidePipes,$root,[
 'PATH'=>getenv('PATH')?:'/usr/local/bin:/usr/bin:/bin',
 'HOME'=>$root,
 'GIT_CONFIG_NOSYSTEM'=>'1',
 'GIT_CONFIG_GLOBAL'=>'/dev/null'
],['bypass_shell'=>true]);
expect_true(is_resource($outsideInit),'external synthetic Git repository must initialize');
fclose($outsidePipes[0]);
$outsideInitOut=(string)stream_get_contents($outsidePipes[1]);
$outsideInitErr=(string)stream_get_contents($outsidePipes[2]);
fclose($outsidePipes[1]); fclose($outsidePipes[2]);
expect_true(proc_close($outsideInit)===0&&$outsideInitOut===''&&$outsideInitErr==='','external synthetic Git fixture must initialize without errors');

$nestedPack=$gitRepo.'/.git/objects/pack';
if(!is_dir($nestedPack)) expect_true(mkdir($nestedPack,0700,true),'nested Git pack directory must be created for symlink regression');
$nestedPackEntries=array_values(array_diff(scandir($nestedPack)?:[],['.','..']));
expect_true($nestedPackEntries===[],'synthetic Git pack directory must be empty before symlink regression');
expect_true(rmdir($nestedPack),'empty synthetic Git pack directory must be removed before link setup');
$outsidePack=$outsideRepo.'/.git/objects/pack';
if(!is_dir($outsidePack)) expect_true(mkdir($outsidePack,0700,true),'outside Git pack directory must be created for symlink regression');
expect_true(symlink($outsidePack,$nestedPack),'nested Git object pack symlink must be created');
expect_true(directadmin_git_repository_context($gitRepo)===null,'nested Git object symlink outside HOME must be rejected before Git runs');
expect_true(unlink($nestedPack),'nested Git object symlink must be removed after regression');
expect_true(mkdir($nestedPack,0700),'empty Git object pack directory must be restored after regression');
expect_true(directadmin_git_repository_context($gitRepo)!==null,'contained Git repository must recover after nested symlink removal');

$linkedEscape=$home.'/linked-gitdir-escape';
expect_true(mkdir($linkedEscape,0700,true),'linked Git escape fixture must be created');
expect_true(file_put_contents($linkedEscape.'/.git',"gitdir: ".$outsideRepo.'/.git'."\n")!==false,'synthetic linked-worktree pointer must be written');
expect_true(directadmin_git_repository_context($linkedEscape)===null,'linked-worktree gitdir outside selected HOME must be rejected before Git runs');
$escapedReadiness=codex_readiness($linkedEscape,[],['git'=>'/usr/bin/git']);
expect_true($escapedReadiness['git_repository']===false&&$escapedReadiness['git_branch']===null,'Codex readiness must not follow an external gitdir');

$commondirEscape=$home.'/linked-commondir-escape';
expect_true(mkdir($commondirEscape.'/.git',0700,true),'commondir escape fixture must be created');
expect_true(file_put_contents($commondirEscape.'/.git/commondir',$outsideRepo.'/.git'."\n")!==false,'synthetic commondir pointer must be written');
expect_true(directadmin_git_repository_context($commondirEscape)===null,'commondir outside selected HOME must be rejected');

$alternatesFile=$gitRepo.'/.git/objects/info/alternates';
if(!is_dir(dirname($alternatesFile))) expect_true(mkdir(dirname($alternatesFile),0700,true),'Git object metadata fixture path must be created');
expect_true(file_put_contents($alternatesFile,$outsideRepo.'/.git/objects'."\n")!==false,'synthetic external object alternate must be written');
expect_true(directadmin_git_repository_context($gitRepo)===null,'external Git object alternates must be rejected');
expect_true(unlink($alternatesFile),'synthetic external object alternate must be removed');
expect_true(directadmin_git_repository_context($gitRepo)!==null,'contained Git repository must recover after removing the external alternate');

$readOnlyGitCommands=[
 'git status',
 'git status --short',
 'git diff --stat',
 'git diff --name-only',
 'git log --oneline -5',
 'git branch --show-current',
 'git rev-parse --short HEAD',
 'git ls-files',
 'git describe --always --dirty'
];
foreach($readOnlyGitCommands as $command){
 [$class,, $allowed]=command_policy($command);
 expect_true($allowed===true&&$class==='READ',$command.' must be explicitly allowlisted as read-only Git inspection');
}
$remoteConfigBefore=hash_file('sha256',$gitRepo.'/.git/config');
$blockedGitCommands=[
 'git remote add origin https://synthetic-user:synthetic-token@example.invalid/repo.git',
 'git remote remove origin',
 'git remote rename origin backup',
 'git remote set-url origin https://synthetic-user:synthetic-token@example.invalid/new.git',
 'git remote update',
 'git remote -v',
 'git status --git-dir=/tmp/external/.git',
 'git -C /tmp/external status'
];
foreach($blockedGitCommands as $command){
 [$output,$exitCode]=run_cmd($command,$gitRepo);
 expect_true($exitCode===126,$command.' must fail closed without running');
 expect_true(strpos($output,'synthetic-user')===false&&strpos($output,'synthetic-token')===false,$command.' must not disclose URL userinfo');
}
expect_true(hash_file('sha256',$gitRepo.'/.git/config')===$remoteConfigBefore,'blocked remote add/remove/rename/set-url/update commands must not mutate local Git config');
[$class,, $allowed]=command_policy('git show --stat');
expect_true($allowed===false&&$class==='UNKNOWN','unlisted Git read commands must fail closed');




$healthyStatus=normalize_server_node_status(json_encode([
 'schema'=>'titan.server-node.health.v1',
 'status'=>'healthy',
 'ready'=>true,
 'checked_at'=>'2026-10-02T05:00:00Z',
 'checks'=>[
  ['id'=>'web','critical'=>true,'status'=>'healthy','http_status'=>200],
  ['id'=>'workforce','critical'=>true,'status'=>'healthy','http_status'=>204],
 ],
]));
expect_true($healthyStatus['state']==='CONNECTED','healthy Server Node must project CONNECTED');
expect_true(count($healthyStatus['checks'])===2,'Server Node checks must be preserved within bounds');
expect_true($healthyStatus['checks'][0]['id']==='web','Server Node check ID must be sanitized');

$badStatus=normalize_server_node_status('{"schema":"wrong","ready":true}');
expect_true($badStatus['state']==='UNAVAILABLE','unexpected Server Node schema must fail closed');

$oversizedStatus=normalize_server_node_status(str_repeat('x',65537));
expect_true($oversizedStatus['state']==='UNAVAILABLE','oversized Server Node status must fail closed');




expect_true(directadmin_role_can_mutate('admin')===true,'admin route must retain operator actions');
expect_true(directadmin_role_can_mutate('reseller')===false,'reseller route must be read-only');
expect_true(directadmin_role_can_mutate('user')===false,'user route must be read-only');
expect_true(directadmin_role_can_mutate('unknown')===false,'unknown roles must fail closed');


echo "Developer Portal security regression tests passed".PHP_EOL;
