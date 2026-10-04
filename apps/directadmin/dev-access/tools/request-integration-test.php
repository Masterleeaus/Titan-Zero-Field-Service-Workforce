<?php
declare(strict_types=1);

function integration_expect(bool $condition,string $message):void{
 if(!$condition){fwrite(STDERR,'FAIL: '.$message.PHP_EOL);exit(1);}
}
function integration_remove_tree(string $path):void{
 if(is_link($path)||is_file($path)){@unlink($path);return;}
 if(!is_dir($path)) return;
 foreach(scandir($path)?:[] as $entry){
  if($entry==='.'||$entry==='..') continue;
  integration_remove_tree($path.'/'.$entry);
 }
 @rmdir($path);
}
function integration_tree_snapshot(string $root):array{
 $realRoot=realpath($root);
 integration_expect($realRoot!==false,'snapshot root must resolve');
 $snapshot=[];$visit=null;
 $visit=static function(string $path,string $relative)use(&$visit,&$snapshot):void{
  $stat=@lstat($path);
  integration_expect(is_array($stat),'snapshot path must remain readable');
  $mode=$stat['mode']&07777;
  if(is_link($path)){$snapshot[$relative]=['link',$mode,readlink($path)];return;}
  if(is_dir($path)){
   $snapshot[$relative]=['dir',$mode];
   foreach(scandir($path)?:[] as $entry){
    if($entry==='.'||$entry==='..') continue;
    $child=$relative==='.'?$entry:$relative.'/'.$entry;
    $visit($path.'/'.$entry,$child);
   }
   return;
  }
  if(is_file($path)){$snapshot[$relative]=['file',$mode,hash_file('sha256',$path)];return;}
  $snapshot[$relative]=['special',$mode];
 };
 $visit($realRoot,'.');
 ksort($snapshot);
 return $snapshot;
}
function integration_seed_csrf(string $home):string{
 $directory=$home.'/.titan-dev-access';
 integration_expect(mkdir($directory,0700,true),'read-only test CSRF fixture must be created');
 chmod($directory,0700);
 $secret=bin2hex(random_bytes(32));
 integration_expect(file_put_contents($directory.'/csrf.key',$secret,LOCK_EX)!==false,'read-only test CSRF fixture must be written');
 chmod($directory.'/csrf.key',0600);
 return hash_hmac('sha256','titan_dev_access_form_v2',$secret);
}
function integration_start_web_server(string $pluginRoot,string $fixture,string $username,string $emptyHome,string $existingHome,array $baseEnvironment):array{
 $router=$fixture.'/directadmin-web-router.php';
 $routerSource=<<<'PHP'
<?php
$role=$_SERVER['HTTP_X_TDA_TEST_ROLE']??'';
$homeId=$_SERVER['HTTP_X_TDA_TEST_HOME']??'';
$homes=['empty'=>getenv('TDA_TEST_HOME_EMPTY'),'existing'=>getenv('TDA_TEST_HOME_EXISTING')];
if(!in_array($role,['admin','reseller','user'],true)||!isset($homes[$homeId])||!is_string($homes[$homeId])){http_response_code(400);echo 'Invalid test route';return;}
putenv('HOME='.$homes[$homeId]);
$root=getenv('TDA_TEST_PLUGIN_ROOT');
$entry=$root.'/'.$role.'/index.html';
if(!is_file($entry)){http_response_code(404);echo 'Missing test entrypoint';return;}
echo '<!-- test-sapi='.PHP_SAPI.' -->';
ob_start();
require $entry;
echo ob_get_clean();
PHP;
 integration_expect(file_put_contents($router,$routerSource)!==false,'web test router must be written inside its fixture');
 $socket=@stream_socket_server('tcp://127.0.0.1:0',$errno,$error);
 integration_expect(is_resource($socket),'loopback socket must allocate a test port');
 $address=stream_socket_get_name($socket,false);
 fclose($socket);
 integration_expect(is_string($address)&&preg_match('/:(\d+)$/',$address,$matches)===1,'loopback test port must resolve');
 $port=(int)$matches[1];
 $environment=array_replace($baseEnvironment,[
  'HOME'=>$emptyHome,'USERNAME'=>$username,'USER'=>$username,
  'TDA_TEST_PLUGIN_ROOT'=>$pluginRoot,'TDA_TEST_HOME_EMPTY'=>$emptyHome,'TDA_TEST_HOME_EXISTING'=>$existingHome
 ]);
 $descriptors=[0=>['pipe','r'],1=>['file','/dev/null','a'],2=>['file','/dev/null','a']];
 $process=@proc_open([PHP_BINARY,'-S','127.0.0.1:'.$port,$router],$descriptors,$pipes,$fixture,$environment,['bypass_shell'=>true]);
 integration_expect(is_resource($process),'PHP CLI server must start for non-CLI role coverage');
 fclose($pipes[0]);
 for($attempt=0;$attempt<50;$attempt++){
  $probe=@fsockopen('127.0.0.1',$port,$connectErrno,$connectError,0.1);
  if(is_resource($probe)){fclose($probe);return ['process'=>$process,'port'=>$port];}
  usleep(100000);
 }
 @proc_terminate($process);
 @proc_close($process);
 integration_expect(false,'PHP CLI server must accept loopback requests within five seconds');
 return [];
}
function integration_stop_web_server(?array &$server):void{
 if(is_array($server)&&isset($server['process'])&&is_resource($server['process'])){
  @proc_terminate($server['process']);
  @proc_close($server['process']);
 }
 $server=null;
}
function integration_web_request(string $baseUrl,string $role,string $homeId,string $method,string $body=''):string{
 $headers=['X-TDA-Test-Role: '.$role,'X-TDA-Test-Home: '.$homeId];
 if($method==='POST'){$headers[]='Content-Type: application/x-www-form-urlencoded';}
 $context=stream_context_create(['http'=>[
  'method'=>$method,'header'=>implode("\r\n",$headers),'content'=>$body,'ignore_errors'=>true,'timeout'=>3
 ]]);
 $response=@file_get_contents($baseUrl,false,$context);
 integration_expect(is_string($response),'non-CLI role endpoint must return a response');
 return $response;
}
function integration_run_role(string $root,string $role,array $environment,?string $stdinBody=null):array{
 $entry=$root.'/'.$role.'/index.html';
 integration_expect(is_file($entry)&&is_executable($entry),'packaged role entrypoint must exist and be executable');
 $descriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
 $command=is_executable('/usr/local/bin/php')?[$entry]:[PHP_BINARY,$entry];
 $process=@proc_open($command,$descriptors,$pipes,$root,$environment,['bypass_shell'=>true]);
 integration_expect(is_resource($process),'PHP CLI must start the actual role entrypoint');
 if($stdinBody!==null){
  $offset=0; $length=strlen($stdinBody);
  while($offset<$length){
   $written=fwrite($pipes[0],substr($stdinBody,$offset));
   integration_expect($written!==false&&$written>0,'request body must reach role stdin');
   $offset+=$written;
  }
 }
 fclose($pipes[0]);
 $stdout=(string)stream_get_contents($pipes[1]);
 $stderr=(string)stream_get_contents($pipes[2]);
 fclose($pipes[1]); fclose($pipes[2]);
 $exit=proc_close($process);
 integration_expect($exit===0,'role entrypoint must exit cleanly');
 integration_expect($stderr==='','role entrypoint must not emit PHP errors');
 return [$stdout,$stderr];
}
function integration_token(string $html):string{
 integration_expect(strpos($html,'name="tda_token"')===false,'legacy CSRF field name must not be rendered');
 integration_expect(preg_match('/<input type="hidden" name="csrf" value="([a-f0-9]{64})">/',$html,$matches)===1,'role page must render a canonical CSRF field');
 return $matches[1];
}
function integration_expect_successful_pwd(string $html,string $home):void{
 integration_expect(strpos($html,'Request rejected:')===false,'valid POST transport must not be rejected');
 integration_expect(strpos($html,'Exit code: 0')!==false,'read-only pwd must finish successfully');
 integration_expect(preg_match('~<div class="term">([^<]*)</div>~',$html,$matches)===1,'successful command output must render in the terminal');
 integration_expect(trim(htmlspecialchars_decode($matches[1],ENT_QUOTES))===$home,'pwd output must be limited to the selected account HOME');
}
function integration_expect_terminal_blocked(string $html,string $case,string $canary):void{
 integration_expect(strpos($html,'Exit code: 126')!==false,$case.' must be rejected before command execution');
 integration_expect(strpos($html,'Blocked by Developer Portal policy')!==false,$case.' must report the fixed terminal policy denial');
 integration_expect(strpos($html,$canary)===false,$case.' must never render the synthetic secret canary');
}
function integration_init_git_repo(string $path,string $home):void{
 integration_expect(mkdir($path,0700,true),'isolated Git repository directory must be created');
 $descriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
 $environment=[
  'PATH'=>getenv('PATH')?:'/usr/local/bin:/usr/bin:/bin',
  'HOME'=>$home,
  'GIT_CONFIG_NOSYSTEM'=>'1',
  'GIT_CONFIG_GLOBAL'=>'/dev/null'
 ];
 $process=@proc_open(['git','-c','init.defaultBranch=main','init','--quiet',$path],$descriptors,$pipes,$home,$environment,['bypass_shell'=>true]);
 integration_expect(is_resource($process),'synthetic Git repository must initialize');
 fclose($pipes[0]);
 $stdout=(string)stream_get_contents($pipes[1]);
 $stderr=(string)stream_get_contents($pipes[2]);
 fclose($pipes[1]); fclose($pipes[2]);
 integration_expect(proc_close($process)===0&&$stdout===''&&$stderr==='','synthetic Git setup must be quiet and successful');
}

function integration_git_command(string $cwd,array $arguments,array $environment):string{
 $descriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
 $process=@proc_open(array_merge(['git','-C',$cwd],$arguments),$descriptors,$pipes,$cwd,$environment,['bypass_shell'=>true]);
 integration_expect(is_resource($process),'synthetic Git setup command must start');
 fclose($pipes[0]);
 $stdout=(string)stream_get_contents($pipes[1]);
 $stderr=(string)stream_get_contents($pipes[2]);
 fclose($pipes[1]); fclose($pipes[2]);
 $exit=proc_close($process);
 integration_expect($exit===0,'synthetic Git setup command must succeed: '.implode(' ',$arguments).' '.trim($stderr));
 return trim($stdout);
}
function integration_git_capture(string $cwd,array $arguments,array $environment):array{
 $descriptors=[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']];
 $process=@proc_open(array_merge(['git','-C',$cwd],$arguments),$descriptors,$pipes,$cwd,$environment,['bypass_shell'=>true]);
 integration_expect(is_resource($process),'synthetic Git capture command must start');
 fclose($pipes[0]);
 $stdout=(string)stream_get_contents($pipes[1]);
 $stderr=(string)stream_get_contents($pipes[2]);
 fclose($pipes[1]); fclose($pipes[2]);
 return [proc_close($process),$stdout,$stderr];
}

function integration_ssh_wire_string(string $value):string{
 return pack('N',strlen($value)).$value;
}
function integration_synthetic_public_key(string $algorithm):string{
 if($algorithm==='ssh-ed25519'){
  $public=hex2bin('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  $blob=integration_ssh_wire_string('ssh-ed25519').integration_ssh_wire_string($public);
 }elseif($algorithm==='ssh-rsa'){
  $exponent="\x01\x00\x01";
  $modulus="\x7f".str_repeat("\xfb",254);
  $blob=integration_ssh_wire_string('ssh-rsa').integration_ssh_wire_string($exponent).integration_ssh_wire_string($modulus);
 }else{
  throw new RuntimeException('Unsupported integration fixture algorithm.');
 }
 return $algorithm.' '.base64_encode($blob).' synthetic+fixture&marker=literal%25';
}

function integration_expect_successful_key(string $html,string $expectedKey,string $home):void{
 integration_expect(strpos($html,'Request rejected:')===false,'valid SSH public-key form must not be rejected');
 integration_expect(strpos($html,'Public key installed.')!==false,'valid synthetic SSH public key must be accepted');
 $directory=$home.'/.ssh';
 $path=$directory.'/authorized_keys';
 integration_expect(is_file($path),'accepted public key must be written only into the selected test HOME');
 $contents=file_get_contents($path);
 integration_expect(is_string($contents)&&$contents===$expectedKey."\n",'accepted key must be stored as exactly one normalized public-key line');
 integration_expect((fileperms($directory)&0777)===0700,'SSH key directory must retain mode 0700');
 integration_expect((fileperms($path)&0777)===0600,'authorized_keys must retain mode 0600');
}

function integration_expect_transport_rejected(string $html,string $case='invalid transport',?string $expectedDiagnostic=null):void{
 integration_expect(strpos($html,'Request rejected: malformed or ambiguous form data.')!==false,$case.' must fail closed');
 integration_expect(strpos($html,'Exit code:')===false,$case.' must not execute a command');
 if($expectedDiagnostic!==null) integration_expect(strpos($html,$expectedDiagnostic)!==false,$case.' must expose the expected allowlisted diagnostic without form contents');
}
function integration_expect_safe_diagnostic(string $html,string $expected,string $case):void{
 integration_expect(preg_match('/Diagnostic: ([^<]+)/',$html,$matches)===1,$case.' must include a bounded diagnostic');
 integration_expect($matches[1]===$expected,$case.' diagnostic must contain only the expected fixed code, transport, lengths and terminal class');
}

integration_expect(count($argv)>=2,'pass the extracted final archive directory');
$root=realpath($argv[1]);
integration_expect($root!==false,'final archive must be extracted');
integration_expect(function_exists('posix_geteuid')&&function_exists('posix_getpwuid')&&function_exists('posix_getpwnam'),'POSIX account functions are required for DirectAdmin CLI verification');
$account=posix_getpwuid(posix_geteuid());
integration_expect(is_array($account)&&isset($account['name'],$account['dir']),'effective UNIX user must resolve');
$accountHome=realpath($account['dir']);
integration_expect($accountHome!==false,'effective UNIX HOME must resolve');
$fixture=$accountHome.'/.titan-dev-request-'.bin2hex(random_bytes(6));
$homeA=$fixture.'/account-a';
$homeB=$fixture.'/account-b';
integration_expect(mkdir($homeA,0700,true),'isolated account-A HOME must be created');
integration_expect(mkdir($homeB,0700,true),'isolated account-B HOME must be created');
$webServer=null;
register_shutdown_function(static function()use($fixture,&$webServer):void{
 integration_stop_web_server($webServer);
 integration_remove_tree($fixture);
});

$routes=[
 'admin'=>'/CMD_PLUGINS_ADMIN/titan_dev_access',
 'reseller'=>'/CMD_PLUGINS_RESELLER/titan_dev_access',
 'user'=>'/CMD_PLUGINS/titan_dev_access'
];
$common=[
 'PATH'=>getenv('PATH')?:'/usr/local/bin:/usr/bin:/bin',
 'USERNAME'=>$account['name'],
 'USER'=>$account['name'],
 'HOME'=>$homeA,
 'SERVER_NAME'=>'panel.example.test',
 'CONTENT_TYPE'=>'application/x-www-form-urlencoded'
];
foreach(['LD_LIBRARY_PATH','PHP_INI_SCAN_DIR','TMPDIR','LD_PRELOAD','NSS_WRAPPER_PASSWD','NSS_WRAPPER_GROUP'] as $name){$value=getenv($name);if($value!==false)$common[$name]=$value;}

$adminGet=$common+['REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$routes['admin'],'QUERY_STRING'=>''];
[$adminHtml]=integration_run_role($root,'admin',$adminGet);
$token=integration_token($adminHtml);
integration_expect(strpos($adminHtml,'operator actions enabled')!==false,'admin route must expose operator mode');
integration_expect(substr_count($adminHtml,'action="?pipe_post=yes"')===2,'rendered admin run/add-key forms must request DirectAdmin stdin POST transport');
integration_expect(strpos($adminHtml,'Connect Codex to this server')!==false,'admin route must render the guided workstation connection section');
integration_expect(strpos($adminHtml,'name="add_key"')!==false&&strpos($adminHtml,'Install public key')!==false,'admin route must retain explicit public-key management');
integration_expect(strpos($adminHtml,'private key')!==false&&strpos($adminHtml,'icacls')!==false,'admin route must explain local Windows key access without requesting private-key contents');

$connectionEnvironment=$common+[
 'REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$routes['admin'],'QUERY_STRING'=>'',
 'SERVER_NAME'=>'panel.example.test',
 'TITAN_DEV_ACCESS_SSH_HOST'=>'ssh.example.test',
 'TITAN_DEV_ACCESS_SSH_PORT'=>'2222'
];
[$connectionHtml]=integration_run_role($root,'admin',$connectionEnvironment);
$expectedConnection='ssh -p 2222 '.$account['name'].'@ssh.example.test';
integration_expect(strpos($connectionHtml,$expectedConnection)!==false,'actual admin CLI role entrypoint must render the configured SSH endpoint and effective DirectAdmin username');
integration_expect(strpos($connectionHtml,'Host source</b><br>configured')!==false&&strpos($connectionHtml,'Port source</b><br>configured')!==false,'configured SSH endpoint sources must be identified in the role UI');
integration_expect(strpos($connectionHtml,'value="ssh.example.test"')!==false&&strpos($connectionHtml,'value="2222"')!==false,'the client-side endpoint fields must reflect validated server settings');
integration_expect(strpos($connectionHtml,'Permission denied (publickey)')!==false&&strpos($connectionHtml,'Load key: Permission denied')!==false,'the role UI must distinguish local key loading from server public-key rejection');
integration_expect(strpos($connectionHtml,'id="tda-ssh-alias"')!==false&&strpos($connectionHtml,'IdentityFile')!==false,'the role UI must support a saved workstation alias that selects its configured key');
integration_expect(strpos($connectionHtml,'name="tda-ssh-host"')===false&&strpos($connectionHtml,'name="tda-ssh-port"')===false,'client-only SSH endpoint fields must not submit or persist host overrides');
integration_expect(strpos($connectionHtml,'name="tda-ssh-alias"')===false,'client-only saved alias field must not submit or persist a workstation setting');

$invalidConnectionEnvironment=$common+[
 'REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$routes['admin'],'QUERY_STRING'=>'',
 'SERVER_NAME'=>'panel.example.test',
 'TITAN_DEV_ACCESS_SSH_HOST'=>'ssh.example.test;touch /tmp/unsafe',
 'TITAN_DEV_ACCESS_SSH_PORT'=>'2222'
];
[$invalidConnectionHtml]=integration_run_role($root,'admin',$invalidConnectionEnvironment);
integration_expect(strpos($invalidConnectionHtml,'touch /tmp/unsafe')===false,'invalid configured SSH host must not be reflected into the page or command');
integration_expect(strpos($invalidConnectionHtml,'ssh -p 2222 '.$account['name'].'@ssh.example.test')===false,'invalid configured SSH host must not create a shell-like connection command');
integration_expect(strpos($invalidConnectionHtml,'Enter a valid SSH alias, or a valid SSH host and port, to build the command.')!==false,'invalid configured SSH host must leave the command unavailable');

foreach(['reseller','user'] as $role){
 $environment=$common+['REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$routes[$role],'QUERY_STRING'=>''];
 [$html]=integration_run_role($root,$role,$environment);
 integration_expect(strpos($html,'name="csrf"')===false,$role.' read-only page must not render mutation CSRF field');
 integration_expect(strpos($html,'read-only')!==false,$role.' page must advertise read-only policy');
 integration_expect(strpos($html,'name="run"')===false,$role.' page must not render terminal action');
 integration_expect(strpos($html,'name="add_key"')===false,$role.' page must not render SSH mutation action');
 integration_expect(strpos($html,'Connect Codex to this server')!==false,$role.' read-only route must render the connection guide');
 integration_expect(strpos($html,'Admin role required to inspect fingerprints')!==false,$role.' route must not inspect or expose another role public-key fingerprints');
 integration_expect(strpos($html,'ssh -p 22 '.$account['name'].'@')!==false,$role.' route may show only this process account and default SSH port');
}

$fields=['csrf'=>$token,'cwd'=>$homeA,'command'=>'pwd','run'=>'1'];
$environment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$routes['admin'],'QUERY_STRING'=>'',
 'CONTENT_LENGTH'=>(string)strlen(http_build_query($fields))
];
foreach($fields as $name=>$value)$environment[$name]=$value;
[$result]=integration_run_role($root,'admin',$environment);
integration_expect_transport_rejected($result,'exploded environment-only POST');

$compensatedFields=$fields;
$compensatedFields['cwd']=$homeA.str_repeat('*',38);
$browserFields=$compensatedFields+['csrf[]'=>$token];
$browserBody=str_replace('%2A','*',http_build_query($browserFields,'','&',PHP_QUERY_RFC1738));
$visibleEnvironmentLength=strlen(http_build_query($compensatedFields,'','&',PHP_QUERY_RFC1738));
integration_expect(strlen($browserBody)===$visibleEnvironmentLength,'browser-serialized 38-asterisk compensation fixture must reproduce the lossy environment length ambiguity');
$environment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$routes['admin'],'QUERY_STRING'=>'',
 'CONTENT_LENGTH'=>(string)strlen($browserBody),
 'csrf'=>$compensatedFields['csrf'],'cwd'=>$compensatedFields['cwd'],
 'command'=>$compensatedFields['command'],'run'=>$compensatedFields['run']
];
[$result]=integration_run_role($root,'admin',$environment);
integration_expect_transport_rejected($result,'valid scalar CSRF plus dropped array field with compensated browser encoding');


foreach(['reseller','user'] as $role){
 $actions=[
  'run'=>['csrf'=>$token,'cwd'=>$homeA,'command'=>'pwd','run'=>'1'],
  'add_key'=>['csrf'=>$token,'public_key'=>'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixTUREKeyForRolePolicyRegression00000000000000000000000000000000 test','add_key'=>'1'],
  'remove_key'=>['csrf'=>$token,'remove_key'=>'0']
 ];
 foreach($actions as $action=>$fields){
  $environment=$common+[
   'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$routes[$role],'QUERY_STRING'=>'',
   'CONTENT_LENGTH'=>(string)strlen(http_build_query($fields))
  ];
  foreach($fields as $name=>$value)$environment[$name]=$value;
  [$html]=integration_run_role($root,$role,$environment);
  integration_expect(strpos($html,'this DirectAdmin role is read-only')!==false,$role.' CLI '.$action.' POST must fail closed by role policy');
  integration_expect(strpos($html,'Exit code:')===false,$role.' CLI '.$action.' POST must not execute a command');
 }
}

$route=$routes['admin'];
$valid=['csrf'=>$token,'cwd'=>$homeA,'command'=>'pwd','run'=>'1'];
$body=http_build_query($valid);
$stdinEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($body)
];
[$html]=integration_run_role($root,'admin',$stdinEnvironment,$body);
integration_expect_successful_pwd($html,$homeA);

$inspectionHome=$homeA.'/repo-inspection';
integration_expect(mkdir($inspectionHome,0700,true),'ordinary repository inspection HOME must be created');
$canary='SYNTHETIC_PORTAL_SECRET_CANARY_'.bin2hex(random_bytes(8));
integration_expect(file_put_contents($inspectionHome.'/README.md',"repo-safe-marker\nordinary repository fixture\n")!==false,'ordinary repository inspection fixture must be written');
integration_expect(mkdir($inspectionHome.'/.ssh',0700),'synthetic private-key directory must be created');
integration_expect(file_put_contents($inspectionHome.'/.ssh/id_rsa',"-----BEGIN RSA PRIVATE KEY-----\n".$canary."\n-----END RSA PRIVATE KEY-----\n")!==false,'synthetic private-key canary fixture must be written');
integration_expect(link($inspectionHome.'/.ssh/id_rsa',$inspectionHome.'/hardlinked-key'),'synthetic private-key hardlink fixture must be created');
integration_expect(mkdir($inspectionHome.'/.git',0700),'synthetic Git metadata directory must be created');
integration_expect(file_put_contents($inspectionHome.'/.git/config',"[remote \\\"origin\\\"]\n url = https://fixture.invalid/$canary\n")!==false,'synthetic Git config canary fixture must be written');
integration_expect(file_put_contents($inspectionHome.'/.env',"FIXTURE_SECRET=$canary\n")!==false,'synthetic environment config canary fixture must be written');
integration_expect(file_put_contents($inspectionHome.'/.npmrc',"//registry.fixture.invalid/:_authToken=$canary\n")!==false,'synthetic package config canary fixture must be written');
$outsideCanaryPath=$fixture.'/outside-home-secret';
integration_expect(file_put_contents($outsideCanaryPath,"OUTSIDE_HOME_$canary\n")!==false,'outside-HOME synthetic canary fixture must be written');
integration_expect(symlink($inspectionHome.'/.ssh/id_rsa',$inspectionHome.'/in-home-key-link'),'in-HOME key symlink fixture must be created');
integration_expect(symlink($outsideCanaryPath,$inspectionHome.'/outside-key-link'),'outside-HOME key symlink fixture must be created');
$terminalPost=static function(string $command,?string $cwdOverride=null,array $environmentOverrides=[])use($common,$route,$token,$inspectionHome,$root):string{
 $fields=['csrf'=>$token,'cwd'=>$cwdOverride??$inspectionHome,'command'=>$command,'run'=>'1'];
 $postBody=http_build_query($fields);
 $environment=array_replace($common,[
  'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'',
  'POST'=>$postBody,'CONTENT_LENGTH'=>(string)strlen($postBody)
 ],$environmentOverrides);
 [$result]=integration_run_role($root,'admin',$environment);
 return $result;
};
foreach([
 'cat on an ordinary repository file'=>'cat README.md',
 'grep on an ordinary repository file'=>'grep -F repo-safe-marker README.md',
 'head on an ordinary repository file'=>'head -n 1 README.md',
 'tail on an ordinary repository file'=>'tail -n 2 README.md'
] as $case=>$command){
 integration_expect_terminal_blocked($terminalPost($command),$case.' must not reopen a checked pathname in a child process',$canary);
}
$inspectionLink=$inspectionHome.'/repo-link';
integration_expect(symlink($inspectionHome,$inspectionLink),'in-HOME cwd symlink fixture must be created');
$linkedCwd=$terminalPost('pwd',$inspectionLink);
integration_expect_terminal_blocked($linkedCwd,'in-HOME symlink working-directory path',$canary);
$untrustedToolDirectory=$fixture.'/untrusted-bin';
integration_expect(mkdir($untrustedToolDirectory,0700),'untrusted PATH fixture directory must be created');
integration_expect(file_put_contents($untrustedToolDirectory.'/timeout',"#!/bin/sh\nshift\nexec \"\$@\"\n")!==false,'synthetic timeout PATH canary must be written');
integration_expect(file_put_contents($untrustedToolDirectory.'/cat',"#!/bin/sh\nprintf '%s\\n' 'UNTRUSTED_PATH_CANARY'\n")!==false,'synthetic cat PATH canary must be written');
chmod($untrustedToolDirectory.'/timeout',0700);chmod($untrustedToolDirectory.'/cat',0700);
$untrustedPathResult=$terminalPost('pwd',$inspectionHome,['PATH'=>$untrustedToolDirectory]);
integration_expect(strpos($untrustedPathResult,'Exit code: 0')!==false&&strpos($untrustedPathResult,$inspectionHome)!==false,'terminal execution must use a fixed trusted PATH despite DirectAdmin process environment');
integration_expect(strpos($untrustedPathResult,'UNTRUSTED_PATH_CANARY')===false,'untrusted PATH executable output must never reach the terminal');
$secretReadAttempts=[
 'cat relative SSH key path'=>'cat .ssh/id_rsa',
 'grep filtering a private-key PEM marker'=>'grep -v BEGIN .ssh/id_rsa',
 'head on a private-key file'=>'head -n 2 .ssh/id_rsa',
 'tail skipping a private-key marker'=>'tail -n +2 .ssh/id_rsa',
 'grep pattern-file option on a private-key file'=>'grep -f .ssh/id_rsa README.md',
 'dot-prefixed private-key path'=>'cat ./.ssh/id_rsa',
 'parent-segment path trick'=>'cat nested/../.ssh/id_rsa',
 'Git config path'=>'cat .git/config',
 'environment config path'=>'grep -n SYNTHETIC .env',
 'package-manager auth config path'=>'head -n 1 .npmrc',
 'in-HOME symlink to private-key fixture'=>'grep -v BEGIN in-home-key-link',
 'outside-HOME symlink to canary fixture'=>'cat outside-key-link',
 'in-HOME hardlink to a synthetic private-key fixture'=>'cat hardlinked-key',
 'private-key file passed to PHP lint'=>'php -l .ssh/id_rsa',
 'date file-input option targeting a private-key file'=>'date -f .ssh/id_rsa',
 'disk diagnostic with a private-key path operand'=>'df -h .ssh/id_rsa',
 'working-directory command with a private-key path operand'=>'pwd .ssh/id_rsa',
 'recursive listing of a private-key directory'=>'ls -la .ssh',
 'package test script execution'=>'npm test',
 'Node test script execution'=>'node --test',
 'Composer script execution'=>'composer test'
];
foreach($secretReadAttempts as $case=>$command){
 integration_expect_terminal_blocked($terminalPost($command),$case,$canary);
}

$stdinSecretBody=http_build_query([
 'csrf'=>$token,
 'cwd'=>$inspectionHome,
 'command'=>'grep -v BEGIN .ssh/id_rsa',
 'run'=>'1'
]);
$stdinSecretEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($stdinSecretBody)
];
[$stdinSecretHtml]=integration_run_role($root,'admin',$stdinSecretEnvironment,$stdinSecretBody);
integration_expect_terminal_blocked($stdinSecretHtml,'stdin-transport private-key read attempt',$canary);

$nulTerminatedBody=$body."\0";
$nulWithoutLengthEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true'
];
[$html]=integration_run_role($root,'admin',$nulWithoutLengthEnvironment,$nulTerminatedBody);
integration_expect_successful_pwd($html,$homeA);

$nulWithPrefixLengthEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($body)
];
[$html]=integration_run_role($root,'admin',$nulWithPrefixLengthEnvironment,$nulTerminatedBody);
integration_expect_successful_pwd($html,$homeA);

$nulIncludedLengthEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($nulTerminatedBody)
];
[$html]=integration_run_role($root,'admin',$nulIncludedLengthEnvironment,$nulTerminatedBody);
$nulIncludedLengthDiagnostic='code=field_value_invalid transport=stdin declared_bytes='.strlen($nulTerminatedBody).' body_bytes_read='.strlen($nulTerminatedBody).' terminal_class=nul';
integration_expect_transport_rejected($html,'terminal NUL included in CONTENT_LENGTH',$nulIncludedLengthDiagnostic);
integration_expect_safe_diagnostic($html,$nulIncludedLengthDiagnostic,'terminal NUL inside declared content');

$repeatedNulBody=$body."\0\0";
$repeatedNulEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($body)
];
[$html]=integration_run_role($root,'admin',$repeatedNulEnvironment,$repeatedNulBody);
$repeatedNulDiagnostic='code=body_length_mismatch transport=stdin declared_bytes='.strlen($body).' body_bytes_read='.strlen($repeatedNulBody).' terminal_class=nul';
integration_expect_transport_rejected($html,'repeated terminal raw NUL',$repeatedNulDiagnostic);
integration_expect_safe_diagnostic($html,$repeatedNulDiagnostic,'repeated terminal raw NUL');

$interiorNulBody=str_replace('command=pwd','command=pu'."\0".'d',$body);
$interiorNulEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($interiorNulBody)
];
[$html]=integration_run_role($root,'admin',$interiorNulEnvironment,$interiorNulBody);
$interiorNulDiagnostic='code=field_value_invalid transport=stdin declared_bytes='.strlen($interiorNulBody).' body_bytes_read='.strlen($interiorNulBody).' terminal_class=printable';
integration_expect_transport_rejected($html,'interior raw NUL',$interiorNulDiagnostic);
integration_expect_safe_diagnostic($html,$interiorNulDiagnostic,'interior raw NUL');

$encodedNulBody=str_replace('command=pwd','command=pwd%00',$body);
$encodedNulEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($encodedNulBody)
];
[$html]=integration_run_role($root,'admin',$encodedNulEnvironment,$encodedNulBody);
$encodedNulDiagnostic='code=field_value_invalid transport=stdin declared_bytes='.strlen($encodedNulBody).' body_bytes_read='.strlen($encodedNulBody).' terminal_class=printable';
integration_expect_transport_rejected($html,'percent-encoded NUL',$encodedNulDiagnostic);
integration_expect_safe_diagnostic($html,$encodedNulDiagnostic,'percent-encoded NUL');

$invalidUtf8Body=str_replace('command=pwd','command=%FF',$body);
$invalidUtf8Environment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($invalidUtf8Body)
];
[$html]=integration_run_role($root,'admin',$invalidUtf8Environment,$invalidUtf8Body);
$invalidUtf8Diagnostic='code=field_value_invalid transport=stdin declared_bytes='.strlen($invalidUtf8Body).' body_bytes_read='.strlen($invalidUtf8Body).' terminal_class=printable';
integration_expect_transport_rejected($html,'invalid UTF-8 form value',$invalidUtf8Diagnostic);
integration_expect_safe_diagnostic($html,$invalidUtf8Diagnostic,'invalid UTF-8 form value');

$rawPostEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'',
 'POST'=>$body,'CONTENT_LENGTH'=>(string)strlen($body)
];
[$html]=integration_run_role($root,'admin',$rawPostEnvironment);
integration_expect_successful_pwd($html,$homeA);

// POSIX process environment values cannot contain raw NUL; keep raw framing coverage on stdin and reject encoded NUL here.
$rawEnvironmentEncodedNulBody=str_replace('command=pwd','command=pwd%00',$body);
$rawEnvironmentEncodedNulPost=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'',
 'POST'=>$rawEnvironmentEncodedNulBody,'CONTENT_LENGTH'=>(string)strlen($rawEnvironmentEncodedNulBody)
];
[$html]=integration_run_role($root,'admin',$rawEnvironmentEncodedNulPost);
$rawEnvironmentEncodedNulDiagnostic='code=field_value_invalid transport=environment declared_bytes='.strlen($rawEnvironmentEncodedNulBody).' body_bytes_read='.strlen($rawEnvironmentEncodedNulBody).' terminal_class=printable';
integration_expect_transport_rejected($html,'environment POST percent-encoded NUL',$rawEnvironmentEncodedNulDiagnostic);
integration_expect_safe_diagnostic($html,$rawEnvironmentEncodedNulDiagnostic,'environment POST percent-encoded NUL');

foreach(["\n","\r\n"] as $terminator){
 $terminatedBody=$body.$terminator;
 $terminatedStdinEnvironment=$common+[
  'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
  'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($body)
 ];
 [$html]=integration_run_role($root,'admin',$terminatedStdinEnvironment,$terminatedBody);
 integration_expect_successful_pwd($html,$homeA);

 $terminatedRawEnvironment=$common+[
  'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
  'POST'=>$terminatedBody,'CONTENT_LENGTH'=>(string)strlen($body)
 ];
 [$html]=integration_run_role($root,'admin',$terminatedRawEnvironment);
 integration_expect_successful_pwd($html,$homeA);
}

$doubleLfBody=$body."\n\n";
$doubleLfEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($body)
];
[$html]=integration_run_role($root,'admin',$doubleLfEnvironment,$doubleLfBody);
$doubleLfDiagnostic='code=body_length_mismatch transport=stdin declared_bytes='.strlen($body).' body_bytes_read='.strlen($doubleLfBody);
integration_expect_transport_rejected($html,'two trailing LF bytes outside CONTENT_LENGTH',$doubleLfDiagnostic);

$missingPostEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'',
 'CONTENT_LENGTH'=>(string)strlen($body)
];
[$html]=integration_run_role($root,'admin',$missingPostEnvironment);
integration_expect_transport_rejected($html,'missing DirectAdmin POST environment marker','code=raw_post_missing transport=unavailable');

$invalidMarkerEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=false','CONTENT_LENGTH'=>(string)strlen($body)
];
[$html]=integration_run_role($root,'admin',$invalidMarkerEnvironment);
integration_expect_transport_rejected($html,'invalid DirectAdmin POST marker','code=post_marker_invalid transport=marker');

$invalidLengthEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>'12bytes'
];
[$html]=integration_run_role($root,'admin',$invalidLengthEnvironment,$body);
integration_expect_transport_rejected($html,'malformed CONTENT_LENGTH','code=content_length_invalid transport=stdin declared_bytes=unknown');

$invalidTypeEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($body)
];
$invalidTypeEnvironment['CONTENT_TYPE']='application/json';
[$html]=integration_run_role($root,'admin',$invalidTypeEnvironment,$body);
integration_expect_transport_rejected($html,'unsupported DirectAdmin form content type','code=content_type_invalid transport=stdin');

$queryFieldEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'csrf='.rawurlencode($token),
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($body)
];
[$html]=integration_run_role($root,'admin',$queryFieldEnvironment,$body);
integration_expect_transport_rejected($html,'form fields supplied through query','code=query_form_fields transport=query');

$duplicateBody='csrf='.rawurlencode($token).'&csrf='.rawurlencode($token);
$duplicateEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($duplicateBody)
];
[$html]=integration_run_role($root,'admin',$duplicateEnvironment,$duplicateBody);
integration_expect_transport_rejected($html,'duplicate form fields','code=duplicate_field transport=stdin');

$ambiguousBody=http_build_query($valid+['add_key'=>'1','public_key'=>'synthetic-invalid-key']);
$ambiguousEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($ambiguousBody)
];
[$html]=integration_run_role($root,'admin',$ambiguousEnvironment,$ambiguousBody);
integration_expect_transport_rejected($html,'multiple form actions','code=action_ambiguous transport=stdin');

$gitRepo=$homeA.'/git-remote-policy';
integration_init_git_repo($gitRepo,$homeA);
$filterRepo=$homeA.'/git-process-filter';
integration_init_git_repo($filterRepo,$homeA);
$filterMarker=$fixture.'/actual-role-filter-process-marker';
$filterHelper=$fixture.'/actual-role-filter-process-helper';
integration_expect(file_put_contents($filterHelper,"#!/bin/sh\nprintf invoked >> ".escapeshellarg($filterMarker)."\nexit 0\n")!==false,'actual-role process-filter helper must be written');
integration_expect(chmod($filterHelper,0700),'actual-role process-filter helper must be executable');
$filterEnvironment=[
 'PATH'=>getenv('PATH')?:'/usr/local/bin:/usr/bin:/bin',
 'HOME'=>$homeA,
 'GIT_CONFIG_NOSYSTEM'=>'1',
 'GIT_CONFIG_GLOBAL'=>'/dev/null',
 'GIT_TERMINAL_PROMPT'=>'0'
];
integration_expect(file_put_contents($filterRepo.'/.gitattributes',"*.synthetic filter=synthetic-process\n*.comment-synthetic filter=synthetic-comment\n*.dotted-synthetic filter=synthetic-dotted\n")!==false,'actual-role process-filter attributes must be written');
integration_expect(file_put_contents($filterRepo.'/process.synthetic',"before\n")!==false,'actual-role process-filter fixture must be written');
integration_expect(file_put_contents($filterRepo.'/process.comment-synthetic',"before\n")!==false,'actual-role comment-header process-filter fixture must be written');
integration_expect(file_put_contents($filterRepo.'/process.dotted-synthetic',"before\n")!==false,'actual-role dotted-header process-filter fixture must be written');
integration_git_command($filterRepo,['add','--','.gitattributes','process.synthetic','process.comment-synthetic','process.dotted-synthetic'],$filterEnvironment);
integration_git_command($filterRepo,['-c','user.name=DirectAdmin Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','--message','process filter fixture'],$filterEnvironment);
integration_git_command($filterRepo,['config','filter.synthetic-process.process',$filterHelper],$filterEnvironment);
integration_expect(file_put_contents($filterRepo.'/.git/config',file_get_contents($filterRepo.'/.git/config')."\n[filter \"synthetic-comment\"] # valid commented filter header\n process = ".$filterHelper."\n[filter.synthetic-dotted] # deprecated dotted filter header\n process = ".$filterHelper."\n")!==false,'actual-role alternate filter headers must be configured');
integration_expect(file_put_contents($filterRepo.'/process.synthetic',"after\n")!==false,'actual-role process-filter fixture must be changed');
integration_expect(file_put_contents($filterRepo.'/process.comment-synthetic',"after\n")!==false,'actual-role comment-header process-filter fixture must be changed');
integration_expect(file_put_contents($filterRepo.'/process.dotted-synthetic',"after\n")!==false,'actual-role dotted-header process-filter fixture must be changed');
[$unboundedFilterExit,,]=integration_git_capture($filterRepo,['diff','--stat'],$filterEnvironment);
integration_expect(is_file($filterMarker),'unbounded fixture Git diff must execute the synthetic process filter');
if(is_file($filterMarker)) integration_expect(unlink($filterMarker),'actual-role process-filter marker must be reset before role execution');
$filterFields=['csrf'=>$token,'cwd'=>$filterRepo,'command'=>'git diff --stat','run'=>'1'];
$filterBody=http_build_query($filterFields,'','&',PHP_QUERY_RFC1738);
$filterRoleEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($filterBody)
];
[$filterRoleHtml]=integration_run_role($root,'admin',$filterRoleEnvironment,$filterBody);
integration_expect(strpos($filterRoleHtml,'Git inspection is unavailable')!==false,'actual admin role Git diff must fail closed while repository configuration isolation is pending');
integration_expect(!is_file($filterMarker),'actual admin role Git diff must not execute the repository-configured process filter');
$remoteUrl='https://synthetic-user:synthetic-token@example.invalid/repo.git';
$gitConfig=$gitRepo.'/.git/config';
$gitConfigBefore=hash_file('sha256',$gitConfig);
foreach([
 'remote-add'=>'git remote add origin '.$remoteUrl,
 'remote-set-url'=>'git remote set-url origin '.$remoteUrl,
 'remote-display'=>'git remote -v'
] as $caseName=>$command){
 $gitFields=['csrf'=>$token,'cwd'=>$gitRepo,'command'=>$command,'run'=>'1'];
 $gitBody=http_build_query($gitFields,'','&',PHP_QUERY_RFC1738);
 $gitEnvironment=$common+[
  'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
  'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($gitBody)
 ];
 [$gitHtml]=integration_run_role($root,'admin',$gitEnvironment,$gitBody);
 integration_expect(strpos($gitHtml,'Exit code: 126')!==false,$caseName.' must be blocked by the actual admin role executable');
 integration_expect(strpos($gitHtml,'synthetic-user')===false&&strpos($gitHtml,'synthetic-token')===false,$caseName.' must not disclose URL userinfo');
}
integration_expect(hash_file('sha256',$gitConfig)===$gitConfigBefore,'actual role endpoint must leave repository config unchanged after blocked remote commands');

$externalGit=$fixture.'/outside-git';
integration_init_git_repo($externalGit,$fixture);
$externalSubject='synthetic-outside-packed-git-subject-'.bin2hex(random_bytes(6));
integration_expect(file_put_contents($externalGit.'/fixture.txt',$externalSubject.PHP_EOL)!==false,'packed-object subject fixture must be written');
$gitSetupEnvironment=[
 'PATH'=>getenv('PATH')?:'/usr/local/bin:/usr/bin:/bin',
 'HOME'=>$fixture,
 'GIT_CONFIG_NOSYSTEM'=>'1',
 'GIT_CONFIG_GLOBAL'=>'/dev/null',
 'GIT_TERMINAL_PROMPT'=>'0'
];
integration_git_command($externalGit,['-c','user.name=DirectAdmin Fixture','-c','user.email=fixture@example.invalid','add','fixture.txt'],$gitSetupEnvironment);
integration_git_command($externalGit,['-c','user.name=DirectAdmin Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m',$externalSubject],$gitSetupEnvironment);
$externalCommit=integration_git_command($externalGit,['rev-parse','HEAD'],$gitSetupEnvironment);
integration_git_command($externalGit,['gc','--prune=now','--quiet'],$gitSetupEnvironment);
$externalPacks=glob($externalGit.'/.git/objects/pack/*.pack')?:[];
integration_expect(count($externalPacks)>0,'outside fixture must contain a packed commit object');

$nestedEscapeRepo=$homeA.'/nested-object-escape';
integration_init_git_repo($nestedEscapeRepo,$homeA);
$nestedHead=$nestedEscapeRepo.'/.git/refs/heads/main';
integration_expect(is_dir(dirname($nestedHead))||mkdir(dirname($nestedHead),0700,true),'nested-ref fixture directory must exist');
integration_expect(file_put_contents($nestedHead,$externalCommit."\n")!==false,'synthetic external commit ref must be written');
$nestedPack=$nestedEscapeRepo.'/.git/objects/pack';
if(!is_dir($nestedPack)) integration_expect(mkdir($nestedPack,0700,true),'nested object pack path must be created before linking');
$nestedPackEntries=array_values(array_diff(scandir($nestedPack)?:[],['.','..']));
integration_expect($nestedPackEntries===[],'synthetic nested pack directory must be empty before link setup');
integration_expect(rmdir($nestedPack),'empty nested pack path must be removed before external link setup');
integration_expect(symlink($externalGit.'/.git/objects/pack',$nestedPack),'nested Git objects/pack symlink must point to external packed objects');
$nestedFields=['csrf'=>$token,'cwd'=>$nestedEscapeRepo,'command'=>'git log --oneline -5','run'=>'1'];
$nestedBody=http_build_query($nestedFields,'','&',PHP_QUERY_RFC1738);
$nestedEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($nestedBody)
];
[$nestedHtml]=integration_run_role($root,'admin',$nestedEnvironment,$nestedBody);
integration_expect(strpos($nestedHtml,'Exit code: 126')!==false,'actual role executable must reject nested external Git object traversal before Git runs');
integration_expect(strpos($nestedHtml,$externalSubject)===false&&strpos($nestedHtml,$externalCommit)===false,'actual role output must not disclose a subject or object reachable only through nested external metadata');

$escapedWorktree=$homeA.'/linked-gitdir-escape';
integration_expect(mkdir($escapedWorktree,0700,true),'linked-worktree containment fixture must be created');
integration_expect(file_put_contents($escapedWorktree.'/.git',"gitdir: ".$externalGit.'/.git'."\n")!==false,'external linked-worktree pointer must be created');
$escapeFields=['csrf'=>$token,'cwd'=>$escapedWorktree,'command'=>'git status --short','run'=>'1'];
$escapeBody=http_build_query($escapeFields,'','&',PHP_QUERY_RFC1738);
$escapeEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($escapeBody)
];
[$escapeHtml]=integration_run_role($root,'admin',$escapeEnvironment,$escapeBody);
integration_expect(strpos($escapeHtml,'Exit code: 126')!==false,'actual role command path must reject a gitdir outside HOME before Git runs');
integration_expect(strpos($escapeHtml,$externalGit)===false,'external Git path must not appear in terminal output');

$keyTransportCases=[
 'raw-post-terminal-lf-rsa'=>[
  'key'=>integration_synthetic_public_key('ssh-rsa'),
  'line_ending'=>'',
  'body_ending'=>"\n",
  'pipe'=>false
 ],
 'stdin-crlf-ed25519'=>[
  'key'=>integration_synthetic_public_key('ssh-ed25519'),
  'line_ending'=>"\r\n",
  'body_ending'=>"\r\n",
  'pipe'=>true
 ]
];
foreach($keyTransportCases as $caseName=>$case){
 $keyHome=$fixture.'/key-'.preg_replace('/[^a-z0-9-]/','-',strtolower($caseName));
 integration_expect(mkdir($keyHome,0700,true),'isolated synthetic-key HOME must be created');
 $keyGet=array_replace($common,[
  'REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','HOME'=>$keyHome
 ]);
 [$keyPage]=integration_run_role($root,'admin',$keyGet);
 $keyToken=integration_token($keyPage);
 $postedKey=$case['key'].$case['line_ending'];
 $keyFields=['csrf'=>$keyToken,'public_key'=>$postedKey,'add_key'=>'1'];
 $keyBody=http_build_query($keyFields,'','&',PHP_QUERY_RFC1738);
 $wireBody=$keyBody.$case['body_ending'];
 $keyEnvironment=array_replace($common,[
  'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,
  'QUERY_STRING'=>$case['pipe']?'pipe_post=yes':'',
  'POST'=>$case['pipe']?'stdin=true':$wireBody,
  'CONTENT_LENGTH'=>(string)strlen($wireBody),
  'HOME'=>$keyHome
 ]);
 $stdinBody=$case['pipe']?$wireBody:null;
 [$keyResult]=integration_run_role($root,'admin',$keyEnvironment,$stdinBody);
 integration_expect_successful_key($keyResult,$case['key'],$keyHome);
}

$lifecycleHome=$fixture.'/key-lifecycle';
integration_expect(mkdir($lifecycleHome,0700,true),'isolated key-lifecycle HOME must be created');
$lifecycleSsh=$lifecycleHome.'/.ssh';
integration_expect(mkdir($lifecycleSsh,0700),'isolated key-lifecycle .ssh directory must be created');
$lifecycleAuthorized=$lifecycleSsh.'/authorized_keys';
$lifecycleEd=explode(' ',integration_synthetic_public_key('ssh-ed25519'),3);
$lifecycleRsa=explode(' ',integration_synthetic_public_key('ssh-rsa'),3);
$lifecycleEdMaterial=$lifecycleEd[0].' '.$lifecycleEd[1];
$lifecycleRsaMaterial=$lifecycleRsa[0].' '.$lifecycleRsa[1];
$lifecycleEdBlob=base64_decode($lifecycleEd[1],true);
integration_expect(is_string($lifecycleEdBlob),'synthetic lifecycle key blob must decode');
$lifecycleFingerprint='SHA256:'.rtrim(base64_encode(hash('sha256',$lifecycleEdBlob,true)),'=');
$lifecycleOriginal='command="echo hello world",no-pty '.$lifecycleEdMaterial.' ' ."Alice's \"laptop";
integration_expect(file_put_contents($lifecycleAuthorized,$lifecycleOriginal)!==false,'no-terminal-LF authorized_keys fixture must be seeded');
chmod($lifecycleAuthorized,0600);
$lifecycleGet=array_replace($common,['REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','HOME'=>$lifecycleHome]);
[$lifecyclePage]=integration_run_role($root,'admin',$lifecycleGet);
$lifecycleToken=integration_token($lifecyclePage);
integration_expect(strpos($lifecyclePage,'name="expected_fingerprint" value="'.$lifecycleFingerprint.'"')!==false,'rendered revoke form must bind the displayed row to its SHA-256 fingerprint');
$lifecyclePost=static function(array $fields)use($common,$route,$lifecycleHome,$root):string{
 $body=http_build_query($fields,'','&',PHP_QUERY_RFC1738);
 $environment=array_replace($common,['REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','POST'=>$body,'CONTENT_LENGTH'=>(string)strlen($body),'HOME'=>$lifecycleHome]);
 [$html]=integration_run_role($root,'admin',$environment);
 return $html;
};
$duplicateAdd=$lifecyclePost(['csrf'=>$lifecycleToken,'public_key'=>$lifecycleEdMaterial.' normal-comment','add_key'=>'1']);
integration_expect(strpos($duplicateAdd,'Key already installed.')!==false,'actual admin role must deduplicate restricted key material despite apostrophe and unmatched quote bytes in its comment');
integration_expect(file_get_contents($lifecycleAuthorized)===$lifecycleOriginal,'duplicate-key form must leave the no-final-LF existing line unchanged');
$distinctAdd=$lifecyclePost(['csrf'=>$lifecycleToken,'public_key'=>$lifecycleRsaMaterial.' rsa-comment','add_key'=>'1']);
integration_expect(strpos($distinctAdd,'Public key installed.')!==false,'actual admin role must report a successful checked atomic write');
integration_expect(file_get_contents($lifecycleAuthorized)===$lifecycleOriginal."\n".$lifecycleRsaMaterial." rsa-comment\n",'actual role append must separate an unterminated prior line with LF');
integration_expect((fileperms($lifecycleAuthorized)&0777)===0600&&fileowner($lifecycleAuthorized)===posix_geteuid(),'actual role key lifecycle must retain the account owner and mode 0600');
$commentedLifecycleEd='# '.$lifecycleEdMaterial.' commented-out-key';
$duplicateRecords=$commentedLifecycleEd."\n".$lifecycleRsaMaterial.' rsa-comment' ."\n".'command="echo hello world",no-pty '.$lifecycleEdMaterial.' ' ."Alice's \"laptop\n".$lifecycleEdMaterial.' trailing-backslash\\' ."\n";
integration_expect(file_put_contents($lifecycleAuthorized,$duplicateRecords)!==false,'actual role duplicate, comment-only and reordered-key fixture must be seeded');
chmod($lifecycleAuthorized,0600);
$staleRemove=$lifecyclePost(['csrf'=>$lifecycleToken,'remove_key'=>'0','expected_fingerprint'=>$lifecycleFingerprint]);
integration_expect(strpos($staleRemove,'Key list changed; reload before revoking.')!==false,'stale form from another client must be rejected when a different key moves into its old row');
integration_expect(file_get_contents($lifecycleAuthorized)===$duplicateRecords,'stale revoke from one client must leave the reordered account key list unchanged');
$reorderedGet=array_replace($common,['REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','HOME'=>$lifecycleHome]);
[$reorderedPage]=integration_run_role($root,'admin',$reorderedGet);
integration_expect(strpos($reorderedPage,'name="expected_fingerprint" value="'.$lifecycleFingerprint.'"><button name="remove_key" value="1">Revoke</button>')!==false,'refreshed form must pair the shifted Ed25519 row with its current displayed fingerprint');
$duplicateRemove=$lifecyclePost(['csrf'=>$lifecycleToken,'remove_key'=>'1','expected_fingerprint'=>$lifecycleFingerprint]);
integration_expect(strpos($duplicateRemove,'Key revoked.')!==false,'actual admin role must report successful fingerprint-bound revocation');
integration_expect(file_get_contents($lifecycleAuthorized)===$commentedLifecycleEd."\n".$lifecycleRsaMaterial." rsa-comment\n",'actual role revocation must remove every active duplicate despite odd comments and preserve commented-out and unrelated key lines');
$commentHome=$fixture.'/key-commented-out';
integration_expect(mkdir($commentHome,0700,true),'comment-only actual-role HOME must be created');
integration_expect(mkdir($commentHome.'/.ssh',0700),'comment-only actual-role .ssh directory must be created');
$commentAuthorized=$commentHome.'/.ssh/authorized_keys';
integration_expect(file_put_contents($commentAuthorized,$commentedLifecycleEd."\n")!==false,'actual-role commented-out key fixture must be written');
chmod($commentAuthorized,0600);
$commentGet=array_replace($common,['REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','HOME'=>$commentHome]);
[$commentPage]=integration_run_role($root,'admin',$commentGet);
$commentToken=integration_token($commentPage);
$commentPostBody=http_build_query(['csrf'=>$commentToken,'public_key'=>$lifecycleEdMaterial.' real-key','add_key'=>'1'],'','&',PHP_QUERY_RFC1738);
$commentPostEnvironment=array_replace($common,['REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','POST'=>$commentPostBody,'CONTENT_LENGTH'=>(string)strlen($commentPostBody),'HOME'=>$commentHome]);
[$commentPostResult]=integration_run_role($root,'admin',$commentPostEnvironment);
integration_expect(strpos($commentPostResult,'Public key installed.')!==false,'actual admin role must install matching key material when it appears only in a comment line');
integration_expect(file_get_contents($commentAuthorized)===$commentedLifecycleEd."\n".$lifecycleEdMaterial." real-key\n",'actual role key addition must preserve comment-only lines while adding the active key');
$outsideKeyFile=$fixture.'/outside-authorized-keys';
integration_expect(file_put_contents($outsideKeyFile,'sentinel-do-not-change')!==false,'actual role outside-key sentinel must be created');
integration_expect(unlink($lifecycleAuthorized)&&symlink($outsideKeyFile,$lifecycleAuthorized),'actual role unsafe authorized_keys symlink fixture must be created');
$unsafeWrite=$lifecyclePost(['csrf'=>$lifecycleToken,'public_key'=>$lifecycleEdMaterial.' rejected-symlink','add_key'=>'1']);
integration_expect(strpos($unsafeWrite,'Unable to update authorized_keys safely.')!==false,'actual admin role must report an unsafe-path write failure accurately');
integration_expect(strpos($unsafeWrite,'Public key installed.')===false,'unsafe authorized_keys path must never be reported as a successful install');
integration_expect(file_get_contents($outsideKeyFile)==='sentinel-do-not-change','actual role must not write through an authorized_keys symlink');
integration_expect(strpos($unsafeWrite,'Public-key management unavailable')!==false,'unsafe key storage must render a safe recovery message instead of a PHP error');
integration_expect(unlink($lifecycleAuthorized),'actual role symlink fixture must be removed from isolated HOME');

function integration_expect_invalid_key(string $html,string $home,string $case):void{
 integration_expect(strpos($html,'Invalid public key format.')!==false,$case.' must be rejected as an invalid key line');
 $path=$home.'/.ssh/authorized_keys';
 integration_expect(is_file($path),'isolated test HOME must retain its existing authorized_keys file');
 $contents=file_get_contents($path);
 integration_expect(is_string($contents)&&$contents==='',$case.' must not append a key or a second authorized_keys record');
}

$syntheticEd25519=integration_synthetic_public_key('ssh-ed25519');
$syntheticRsa=integration_synthetic_public_key('ssh-rsa');
$edParts=explode(' ',$syntheticEd25519,3);
$rsaParts=explode(' ',$syntheticRsa,3);
integration_expect(strpos($edParts[1],'+')!==false,'Ed25519 public blob fixture must include a plus character');
integration_expect(strpos($rsaParts[1],'+')!==false&&strpos($rsaParts[1],'/')!==false&&substr($rsaParts[1],-2)==='==','RSA public blob fixture must include plus, slash and base64 padding');
$invalidKeyCases=[
 'raw-plus-corrupts-public-blob'=>[
  'key'=>$syntheticEd25519,
  'transport'=>'raw-plus'
 ],
 'newline-after-key-algorithm'=>[
  'key'=>'ssh-ed25519'."\n".$edParts[1].' synthetic+fixture',
  'transport'=>'urlencoded'
 ],
 'multiline-options-second-authorized-record'=>[
  'key'=>$syntheticEd25519."\n".'command="synthetic-option-fixture" '.$syntheticEd25519,
  'transport'=>'urlencoded'
 ],
 'declared-type-does-not-match-blob'=>[
  'key'=>'ssh-ed25519 '.$rsaParts[1].' synthetic+fixture',
  'transport'=>'urlencoded'
 ],
 'invalid-base64-padding'=>[
  'key'=>'ssh-ed25519 '.$edParts[1].'A=== synthetic+fixture',
  'transport'=>'urlencoded'
 ]
];
foreach($invalidKeyCases as $caseName=>$case){
 $invalidHome=$fixture.'/invalid-key-'.preg_replace('/[^a-z0-9-]/','-',strtolower($caseName));
 integration_expect(mkdir($invalidHome,0700,true),'isolated invalid-key HOME must be created');
 $invalidGet=array_replace($common,[
  'REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','HOME'=>$invalidHome
 ]);
 [$invalidPage]=integration_run_role($root,'admin',$invalidGet);
 $invalidToken=integration_token($invalidPage);
 if($case['transport']==='raw-plus'){
  $encodedKey=str_replace('%2B','+',rawurlencode($case['key']));
  $negativeBody='csrf='.rawurlencode($invalidToken).'&public_key='.$encodedKey.'&add_key=1';
 }else{
  $negativeBody=http_build_query(['csrf'=>$invalidToken,'public_key'=>$case['key'],'add_key'=>'1'],'','&',PHP_QUERY_RFC1738);
 }
 $invalidEnvironment=array_replace($common,[
  'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'',
  'POST'=>$negativeBody,'CONTENT_LENGTH'=>(string)strlen($negativeBody),'HOME'=>$invalidHome
 ]);
 [$invalidResult]=integration_run_role($root,'admin',$invalidEnvironment);
 integration_expect_invalid_key($invalidResult,$invalidHome,$caseName);
}

$missingCsrfBody=http_build_query(['cwd'=>$homeA,'command'=>'pwd','run'=>'1']);
$missingCsrfEnvironment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($missingCsrfBody)
];
[$result]=integration_run_role($root,'admin',$missingCsrfEnvironment,$missingCsrfBody);
integration_expect(strpos($result,'Request rejected: invalid CSRF token.')!==false,'missing CSRF token must fail validation');
integration_expect(strpos($result,'Exit code:')===false,'missing CSRF token must not execute a command');

$negativeBodies=[
 'array-field'=>'csrf%5B%5D='.rawurlencode($token).'&cwd='.rawurlencode($homeA).'&command=pwd&run=1',
 'duplicate-field'=>'csrf='.rawurlencode($token).'&csrf='.rawurlencode($token).'&cwd='.rawurlencode($homeA).'&command=pwd&run=1',
 'duplicate-public-key'=>'csrf='.rawurlencode($token).'&public_key='.rawurlencode('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA+Synthetic/PublicKey== test').'&public_key='.rawurlencode('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA+Synthetic/PublicKey== test').'&add_key=1',
 'malformed-encoding'=>'csrf=%ZZ&cwd='.rawurlencode($homeA).'&command=pwd&run=1',
 'case-variant-field'=>http_build_query($valid).'&CSRF='.rawurlencode($token),
 'ambiguous-action'=>http_build_query(['csrf'=>$token,'cwd'=>$homeA,'command'=>'pwd','run'=>'1','add_key'=>'1'])
];
foreach($negativeBodies as $name=>$badBody){
 $environment=$common+[
  'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
  'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($badBody)
 ];
 [$result]=integration_run_role($root,'admin',$environment,$badBody);
 integration_expect_transport_rejected($result,$name);
}

$oversizedBody='csrf='.str_repeat('a',16385);
$environment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'pipe_post=yes',
 'POST'=>'stdin=true','CONTENT_LENGTH'=>(string)strlen($oversizedBody)
];
[$result]=integration_run_role($root,'admin',$environment,$oversizedBody);
integration_expect_transport_rejected($result,'oversized stdin body');

$environment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'',
 'CONTENT_LENGTH'=>'16385','csrf'=>$token,'cwd'=>$homeA,'command'=>'pwd','run'=>'1'
];
[$result]=integration_run_role($root,'admin',$environment);
integration_expect_transport_rejected($result,'oversized environment payload');


$environment=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'csrf='.rawurlencode($token),
 'CONTENT_LENGTH'=>'0','cwd'=>$homeA,'command'=>'pwd','run'=>'1'
];
[$result]=integration_run_role($root,'admin',$environment);
integration_expect_transport_rejected($result,'query-string CSRF field');

$homeBEnvironment=array_replace($common,[
 'REQUEST_METHOD'=>'GET','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','HOME'=>$homeB
]);
[$htmlB]=integration_run_role($root,'admin',$homeBEnvironment);
$tokenB=integration_token($htmlB);
integration_expect(!hash_equals($token,$tokenB),'separate HOME contexts must have separate CSRF tokens');
$crossHomeFields=['csrf'=>$token,'cwd'=>$homeB,'command'=>'pwd','run'=>'1'];
$crossHomeBody=http_build_query($crossHomeFields);
$crossHome=array_replace($common,[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'','HOME'=>$homeB,
 'POST'=>$crossHomeBody,'CONTENT_LENGTH'=>(string)strlen($crossHomeBody)
]);
[$result]=integration_run_role($root,'admin',$crossHome);
integration_expect(strpos($result,'Request rejected: invalid CSRF token.')!==false,'CSRF token from another account HOME must be rejected');
integration_expect(strpos($result,'Exit code:')===false,'cross-HOME token must not authorize a command');

$other=posix_getpwnam(posix_geteuid()===0?'nobody':'root');
if($other&&isset($other['uid'])&&(int)$other['uid']!==posix_geteuid()){
 $crossAccount=array_replace($common,[
  'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'',
  'USERNAME'=>$other['name'],'USER'=>$other['name'],'HOME'=>$other['dir'],
  'CONTENT_LENGTH'=>'0','csrf'=>$token,'cwd'=>$homeA,'command'=>'pwd','run'=>'1'
 ]);
 [$result]=integration_run_role($root,'admin',$crossAccount);
 integration_expect(strpos($result,'Request rejected: DirectAdmin execution identity is ambiguous.')!==false,'cross-account process identity must be rejected before page diagnostics');
 integration_expect(strpos($result,'Exit code:')===false,'cross-account identity must not authorize a command');
}

$disallowedFields=['csrf'=>$token,'cwd'=>$homeA,'command'=>'cat /etc/passwd','run'=>'1'];
$disallowedBody=http_build_query($disallowedFields);
$disallowed=$common+[
 'REQUEST_METHOD'=>'POST','SCRIPT_NAME'=>$route,'QUERY_STRING'=>'',
 'POST'=>$disallowedBody,'CONTENT_LENGTH'=>(string)strlen($disallowedBody)
];
[$result]=integration_run_role($root,'admin',$disallowed);
integration_expect(strpos($result,'Blocked by Developer Portal policy')!==false,'disallowed command must remain blocked');
integration_expect(strpos($result,'root:x:')===false,'disallowed command must not read system account data');

$homeReadOnly=$fixture.'/read-only-empty-home';
integration_expect(mkdir($homeReadOnly,0700,true),'read-only empty HOME fixture must be created');
$tokenReadOnly=integration_seed_csrf($homeReadOnly);
integration_expect(chmod($homeReadOnly.'/.titan-dev-access',0750),'read-only CSRF directory fixture mode must be set');
integration_expect(chmod($homeReadOnly.'/.titan-dev-access/csrf.key',0640),'read-only CSRF file fixture mode must be set');
$sshFixture=$homeB.'/.ssh/authorized_keys';
integration_expect(file_put_contents($sshFixture,"# read-only regression fixture\n",LOCK_EX)!==false,'existing HOME SSH fixture must be written');
integration_expect(chmod($sshFixture,0640),'existing HOME SSH file fixture mode must be relaxed for mutation detection');
integration_expect(chmod($homeB.'/.ssh',0751),'existing HOME SSH directory fixture mode must be relaxed for mutation detection');
$beforeEmpty=integration_tree_snapshot($homeReadOnly);
$beforeExisting=integration_tree_snapshot($homeB);
$testUsername='tda-test-'.$account['name'].'-'.bin2hex(random_bytes(6));
integration_expect(posix_getpwnam($testUsername)===false,'non-CLI test identity must not resolve to a real account');
$webServer=integration_start_web_server($root,$fixture,$testUsername,$homeReadOnly,$homeB,$common);
$baseUrl='http://127.0.0.1:'.$webServer['port'].'/';
foreach(['admin','reseller','user'] as $role){
 foreach(['empty'=>[$homeReadOnly,$tokenReadOnly,$beforeEmpty],'existing'=>[$homeB,$tokenB,$beforeExisting]] as $homeId=>[$selectedHome,$validToken,$baseline]){
  $get=integration_web_request($baseUrl,$role,$homeId,'GET');
  integration_expect(strpos($get,'<!-- test-sapi=cli-server -->')!==false,'role page must execute under the real non-CLI cli-server SAPI');
  integration_expect(strpos($get,'name="csrf"')===false,$role.' non-CLI GET must not render a mutation CSRF field');
  integration_expect(strpos($get,'read-only')!==false,$role.' non-CLI GET must advertise read-only policy');
  integration_expect(strpos($get,'name="run"')===false&&strpos($get,'name="add_key"')===false,$role.' non-CLI GET must omit mutation controls');
  integration_expect(strpos($get,'ssh_fingerprint=')===false&&strpos($get,'readiness_ssh_dir_mode=unknown')!==false,$role.' non-CLI GET must not disclose key fingerprints or SSH permission metadata');
  integration_expect(integration_tree_snapshot($selectedHome)===$baseline,$role.' non-CLI GET must leave HOME contents and modes unchanged');
  $actions=[
   'run'=>['csrf'=>$validToken,'cwd'=>$selectedHome,'command'=>'pwd','run'=>'1'],
   'add_key'=>['csrf'=>$validToken,'public_key'=>'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixTUREKeyForRolePolicyRegression00000000000000000000000000000000 test','add_key'=>'1'],
   'remove_key'=>['csrf'=>$validToken,'remove_key'=>'0']
  ];
  foreach($actions as $action=>$fields){
   $post=integration_web_request($baseUrl,$role,$homeId,'POST',http_build_query($fields));
   integration_expect(strpos($post,'<!-- test-sapi=cli-server -->')!==false,'POST must execute under non-CLI SAPI');
   integration_expect(strpos($post,'this DirectAdmin role is read-only')!==false,$role.' non-CLI '.$action.' POST must fail at action dispatch even with valid CSRF');
   integration_expect(strpos($post,'Exit code:')===false,$role.' non-CLI '.$action.' POST must not execute terminal commands');
   integration_expect(integration_tree_snapshot($selectedHome)===$baseline,$role.' non-CLI '.$action.' POST must leave HOME contents and modes unchanged');
  }
 }
}
integration_stop_web_server($webServer);

echo "DirectAdmin role request integration tests passed (actual admin CLI environment/POST/stdin transports including bounded raw-NUL framing; strict malformed/ambiguous/UTF-8/CSRF/role/HOME and command-policy cases; reseller/user read-only behavior and clean archive checks).".PHP_EOL;
