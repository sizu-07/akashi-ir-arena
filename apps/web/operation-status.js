const firmwareOk = (player) => ['0.8.0-4e42', '0.8.1-4e42', '0.8.2-4e42', '0.8.0-sim'].includes(player.firmwareVersion);

export function pauseExplanation(reason) {
  const known = {
    operator: ['運営が一時停止しました', '安全と端末の状態を確認してから「ゲームを再開」を押してください。'],
    '端末通信断': ['参加端末との通信が切れました', '端末の電源とWi-Fiを確認し、接続が戻ったら「ゲームを再開」を押してください。'],
    '端末再起動': ['参加端末が再起動しました', '端末の起動と接続を待ち、状態を確認してから再開してください。'],
    '電池低下': ['参加端末の電池残量が低下しました', '該当端末の電源を確認してから再開してください。'],
    '端末構成・机上モードを確認': ['参加端末の設定が試合条件を満たしません', '端末のゲーム用設定と机上モードを確認してから再開してください。'],
    '参加端末の開始準備未完了': ['参加端末の開始準備が完了しませんでした', '端末の接続・時刻同期・ゲーム用設定を確認してから再開してください。'],
    '投影画面切断': ['投影画面との接続が切れました', '投影画面を開き直して「表示を準備」を押し、接続を確認してから再開してください。'],
    server_restart: ['ゲームサーバーが再起動したため停止しました', '投影画面と4台の端末を確認してから「ゲームを再開」を押してください。'],
    server_shutdown: ['ゲームサーバーの停止により中断しました', 'サーバーを起動し、投影画面と端末を確認してから再開してください。'],
    '一時診断中': ['一時診断のためゲームを停止しました', '診断を終了し、端末と投影画面を確認してから「ゲームを再開」を押してください。'],
  };
  return known[reason] ?? [reason ? `ゲームが停止しました：${reason}` : 'ゲームが一時停止しています', '投影画面と参加端末を確認してから「ゲームを再開」を押してください。'];
}

export function operationStatus(state, {connected, isOwner, testRequested}) {
  if (!connected) return {tone:'danger', title:'運営画面とゲームサーバーの通信が切れています', detail:'現在の状態を確認できず、操作もできません。', next:'メインPCのゲームサーバーとネットワークを確認してください。接続が戻ると自動で再表示します。', checks:[]};
  if (!state) return {tone:'warning', title:'ゲームの状態を読み込んでいます', detail:'接続後の最初の更新を待っています。', next:'しばらく待っても変わらなければ、メインPCのゲームサーバーを確認してください。', checks:[]};
  if (!isOwner) return {tone:'warning', title:'この画面は閲覧専用です', detail:'ほかの端末が操作権を持っています。ボタン操作はできません。', next:'この端末で操作する場合は「操作権を取得」を押してください。', checks:[]};

  const players = state.players ?? [];
  const connectedPlayers = players.filter(player => player.connected).length;
  const testing = state.phase === 'LOBBY' ? testRequested : state.testMode;
  const participants = state.phase === 'LOBBY' ? testing ? players.filter(player => player.connected) : players : players.filter(player => state.participantIds?.includes(player.id));
  const required = testing ? 1 : 4;
  const deviceIssues = [];
  for (const player of participants) {
    if (!player.connected || state.serverMs - player.lastSeen > 2500) deviceIssues.push(`${player.name}：通信が切れています`);
    else if (player.syncRtt == null || player.syncRtt > 400) deviceIssues.push(`${player.name}：時刻同期が未完了です`);
    else if (!testing && !firmwareOk(player)) deviceIssues.push(`${player.name}：個人戦用v0.8への更新が必要です`);
    else if ((!player.hardwareReady && !(testing && player.firmwareVersion?.startsWith('legacy-motor-demo-') && player.bench)) || (!testing && player.bench)) deviceIssues.push(`${player.name}：ゲーム用設定・机上モードを確認してください`);
  }
  const devicesReady = testing ? connectedPlayers >= 1 && deviceIssues.length === 0 : connectedPlayers === 4 && deviceIssues.length === 0;
  const ticketRequired = state.ticketBridge?.enabled && !testing && state.phase === 'LOBBY';
  const checks = [
    {ok:!!state.displayReady, label:'投影画面', detail:state.displayReady ? '音声・映像の準備完了' : '投影画面を開き「表示を準備」を押す'},
    {ok:!ticketRequired || !!state.ticketBridge?.membersLoaded, label:'参加者名', detail:ticketRequired ? state.ticketBridge.membersLoaded ? '入場受付から名前を自動反映済み' : '4人全員の入場受付が完了すると名前を自動反映' : state.ticketBridge?.enabled ? '動作確認では整理券の反映は不要' : '手動設定の名前を確認'},
    {ok:devicesReady, label:'参加端末', detail:deviceIssues.length ? deviceIssues.join('／') : `${connectedPlayers}/4台接続${testing ? '（動作確認は1台以上）' : ''}${devicesReady ? state.phase === 'LOBBY' ? '・開始可能' : '・通信正常' : '・不足'}`},
  ];

  if(state.diagnostics?.enabled)return {tone:'warning',title:'一時診断中・戦績には加算されません',detail:state.diagnostics.intermissionHeld?'中間発表の自動進行を保留しています。':'接続した端末の射撃・受信・振動を確認しています。',next:'下の「参加者・端末」で各銃の反応と診断ログを確認し、終わったら「一時診断を終了」を押してください。',checks};

  if (state.phase === 'PAUSED') {
    const [title, next] = pauseExplanation(state.pauseReason);
    return {tone:'danger', title, detail:`第${state.round}ゲームは一時停止中です。残り時間は保持されています。`, next, checks};
  }
  if (state.phase === 'INTERMISSION' && state.intermissionBlockedReason) {
    return {tone:'danger', title:'次のゲームを自動開始できません', detail:`理由：${state.intermissionBlockedReason}`, next:'投影画面と参加端末を確認してください。条件がそろうと自動で開始します。', checks};
  }
  if (state.phase === 'LOBBY') {
    const missing = checks.find(check => !check.ok);
    if (missing) return {tone:'warning', title:`開始前の準備：${missing.label}を確認してください`, detail:missing.detail, next:missing.label === '投影画面' ? '右上の「投影画面を開く」を押し、投影画面で「表示を準備」を押してください。' : missing.label === '参加者名' ? '整理券運営で4人全員の入場を確認してください。反映されない場合は「整理券メンバーを反映」を押してください。' : '下の参加者・端末欄で対象を確認し、4台の接続と設定をそろえてください。', checks};
    if (state.simulation) return {tone:'info', title:'仮想端末でのデモ待機中', detail:'画面上の4台は仮想端末です。', next:'仮想端末で試す場合は「第1ゲームを開始」を押してください。実機を確認する場合は確認対象を「接続した実機」に切り替えます。', checks};
    return {tone:'ready', title:'第1ゲームを開始できます', detail:'投影・参加者・端末の準備がそろいました。', next:'参加者を所定位置へ案内し、「第1ゲームを開始」を押してください。', checks};
  }
  if (state.phase === 'COUNTDOWN') return {tone:'info', title:'開始カウントダウン中', detail:'参加者は射撃開始を待っています。', next:'異常があれば「一時停止」を押してください。', checks};
  if (state.phase === 'ACTIVE') return {tone:'ready', title:state.testMode ? '動作確認中' : `第${state.round}ゲーム進行中`, detail:'残り時間と得点を確認してください。', next:'異常があれば「一時停止」を押してください。中止が必要な場合は「試合全体を強制終了」を使います。', checks};
  if (state.phase === 'INTERMISSION') return {tone:'info', title:`第${state.round - 1}ゲーム終了・途中経過を表示中`, detail:state.demo ? 'デモでは次のゲームを手動で始めます。' : '15秒後に次のゲームを自動開始します。', next:state.demo ? `結果を確認し「第${state.round}ゲームを開始」を押してください。` : '参加者に次のゲームの準備を案内してください。', checks};
  return {tone:'info', title:'試合終了・結果を表示中', detail:'全ゲームの累計キル数で結果が確定しました。', next:'次の組を案内し、「次の試合を準備」を押してください。', checks};
}
