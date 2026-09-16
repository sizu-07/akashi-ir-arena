const $=(id)=>document.getElementById(id);let csrf='';let stream;let detector;let scanning=false;let last='';let lastAt=0;let lastFrameAt=0;const canvas=document.createElement('canvas');const context=canvas.getContext('2d',{willReadFrequently:true});
async function init(){const response=await fetch('/api/operator/session');if(!response.ok){$('loginRequired').hidden=false;return;}const session=await response.json();csrf=session.csrf;$('scanner').hidden=false;$('connection').textContent='サーバー接続済み';$('connection').className='badge';const hash=location.hash.slice(1);if(hash)await check(hash);}
async function check(value){if(value===last&&Date.now()-lastAt<4000)return;last=value;lastAt=Date.now();try{const response=await fetch('/api/operator/check-in',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({value})});const result=await response.json();if(!response.ok)throw Error(result.error||'確認できません');const labels={OK:'入場確認が完了しました',TOO_EARLY:'まだ呼出前',ALREADY_USED:'入場処理済み',CANCELED:'取消済み',NOT_FOUND:'無効な整理券'};const participants=result.ticket?.playerNicknames?.join('・')||result.ticket?.nickname;$('result').className=`scan-result ${result.code}`;$('result').hidden=false;$('result').textContent=`${labels[result.code]||result.code}${result.ticket?`\n${result.ticket.ticketNumber} ${participants}（${result.ticket.partySize}名）`:''}${result.round?`\n第${result.round.number}枠：${result.round.checkedInPeople}/${result.round.assignedPeople}名 入場済み`:''}`;$('result').style.whiteSpace='pre-line';if(navigator.vibrate)navigator.vibrate(result.code==='OK'?[100]:[200,100,200]);}catch(error){$('message').textContent=error.message;$('result').className='scan-result';$('result').hidden=false;$('result').textContent='確認できません';}}
async function start(){
  if(!navigator.mediaDevices?.getUserMedia)throw Error('このブラウザーではカメラを利用できません。HTTPSで開くか、手動入力を使用してください。');
  detector=null;
  if('BarcodeDetector'in window){try{detector=new BarcodeDetector({formats:['qr_code']});}catch{detector=null;}}
  if(!detector&&typeof window.jsQR!=='function')throw Error('QR読取機能を読み込めませんでした。ページを再読み込みしてください。');
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
  $('video').srcObject=stream;await $('video').play();scanning=true;$('message').textContent='';
  $('scanMode').textContent=detector?'QRコードを自動読取中です。背面カメラを整理券へ向けてください。':'互換QR読取モードで動作中です。背面カメラを整理券へ向けてください。';
  scan();
}
function detectWithFallback(video){
  if(!video.videoWidth||!video.videoHeight)return null;
  canvas.width=video.videoWidth;canvas.height=video.videoHeight;context.drawImage(video,0,0,canvas.width,canvas.height);
  const image=context.getImageData(0,0,canvas.width,canvas.height);
  return window.jsQR(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'})?.data||null;
}
async function scan(now=0){if(!scanning)return;try{let value=null;if(detector){const codes=await detector.detect($('video'));value=codes[0]?.rawValue||null;}else if(now-lastFrameAt>=100){lastFrameAt=now;value=detectWithFallback($('video'));}if(value)await check(value);}catch{}requestAnimationFrame(scan);}
function stop(){scanning=false;for(const track of stream?.getTracks()||[])track.stop();$('video').srcObject=null;}
$('start').onclick=async()=>{try{await start();}catch(error){$('message').textContent=error.message;}};$('stop').onclick=stop;$('manualForm').onsubmit=async(event)=>{event.preventDefault();await check(new FormData(event.currentTarget).get('token'));event.currentTarget.reset();};addEventListener('pagehide',stop);init();
