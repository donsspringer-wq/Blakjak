/**
 * src/blackjack/page.ts — Standalone HTML page for multiplayer Blackjack.
 *
 * Served by the peggys-poker Worker at /blackjack.
 * Self-contained: inline CSS + vanilla JS, no build step required.
 * Connects to /ws?game=blackjack on the same origin.
 */

export const BLACKJACK_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blakjak — Peggy's Card House</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0b1f17;color:#f3efe6;min-height:100vh;padding:12px;max-width:820px;margin:0 auto}
h1{color:#ff9b57;font-size:1.6rem;text-align:center;margin:8px 0}
.status{background:#102a20;border:1px solid #2f7a5c;border-radius:12px;padding:10px 14px;margin:8px 0;text-align:center;color:#ff9b57;font-weight:600;font-size:14px}
.dealer,.seat,.controls{background:#071510;border:1px solid #2f7a5c;border-radius:16px;padding:14px;margin:8px 0}
.dealer{border-color:#2f7a5c}
.seat-current{border:2px solid #ff7a3c!important}
.seats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.card{display:inline-block;border-radius:6px;padding:4px 8px;margin:2px;font-weight:700;min-width:28px;text-align:center;font-size:14px}
.card-face{background:#fff}.card-red{color:#c00}.card-black{color:#111}
.card-back{background:#1a3a2a;color:#3ea37a;border:1px solid #2f7a5c}
.btn{min-height:44px;padding:0 16px;margin:4px;border-radius:22;border:0;font-weight:700;cursor:pointer;font-size:14px}
.btn:disabled{background:#444;color:#888;cursor:default}
.btn-primary{background:#ff7a3c;color:#111}.btn-secondary{background:#2f7a5c;color:#111}
input{min-height:44px;padding:0 12px;border-radius:22px;border:1px solid #3ea37a;background:#071510;color:#fff}
.name-input{width:calc(100% - 28px);margin-bottom:8px}
.bet-input{width:90px}
.label{font-size:13px;color:#9a977a}.turn{color:#ff7a3c;font-size:11px;font-weight:700}
.total{color:#ff9b57;font-weight:700;margin-left:6px}
a{color:#ff9b57}
</style></head><body>
<h1>🃏 BLAKJAK</h1>
<div id="app"><p style="text-align:center;color:#8dff6a">Connecting…</p></div>

<script>
const SUITS={hearts:"♥",diamonds:"♦",clubs:"♣",spades:"♠"};
const PHASES={waiting:"Waiting Room",betting:"Place Your Bets",playing:"Player Turns",dealer_turn:"Dealer's Turn",round_over:"Round Over"};
let ws,me=null,myId=null,state=null,connected=false,savedName=false;
let betAmt=50;

function cardStr(c){return c.rank+SUITS[c.suit]}
function isRed(c){return c.suit==="hearts"||c.suit==="diamonds"}
function handTotal(h){if(!h.length)return"";let t=0,a=0;for(const c of h){if(c.rank==="A"){a++;t+=11}else if(["K","Q","J","10"].includes(c.rank))t+=10;else t+=parseInt(c.rank)}while(t>21&&a>0){t-=10;a--}return String(t)}
function send(m){if(ws&&ws.readyState===1)ws.send(JSON.stringify(m))}
function $(id){return document.getElementById(id)}

function renderCard(c,hidden){
  if(!c||hidden)return '<span class="card card-back">🂠</span>';
  return '<span class="card card-face '+(isRed(c)?"card-red":"card-black")+'">'+cardStr(c)+'</span>';
}

function renderHand(cards,hideSecond){
  if(!cards.length)return '<span style="color:#6b8a7a">—</span>';
  return cards.map((c,i)=>renderCard(c,hideSecond&&i===1&&c===null)).join("")+
    (!hideSecond&&cards.length>0&&cards[0]&&cards[1]?'<span class="total">'+handTotal(cards.filter(c=>c))+'</span>':'');
}

function render(){
  if(!connected){$("app").innerHTML='<p style="text-align:center;color:#8dff6a">Connecting…</p>';return}
  if(!savedName){
    $("app").innerHTML='<div style="max-width:400px;margin:20px auto">'+
      '<input class="name-input" id="name" placeholder="Enter your name" maxlength="16" onkeydown="if(event.key===\\'Enter\\'&&this.value.trim()){localStorage.setItem(\\'bj_name\\',this.value.trim());savedName=true;send({type:\\'join\\',name:this.value.trim()})}">'+
      '<button class="btn btn-primary" onclick="var n=document.getElementById(\\'name\\').value.trim();if(n){localStorage.setItem(\\'bj_name\\',n);savedName=true;send({type:\\'join\\',name:n})}">Take a Seat</button></div>';
    var saved=localStorage.getItem("bj_name");if(saved)document.getElementById("name").value=saved;
    return;
  }
  if(!state)return;
  me=state.players.find(p=>p.id===myId);
  var isMyTurn=state.phase==="playing"&&state.currentPlayerId===myId;
  var reveal=state.phase==="dealer_turn"||state.phase==="round_over";
  var canBet=state.phase==="waiting"||state.phase==="betting"||state.phase==="round_over";
  var canAct=isMyTurn&&me&&me.status==="playing";
  var dealerTotal=reveal&&state.dealerHand.length>0&&state.dealerHand[0]&&state.dealerHand[1]?handTotal(state.dealerHand.filter(c=>c)):"";

  var html='<div class="status">Round '+state.round+' · '+PHASES[state.phase]+' — '+state.message+'</div>';

  html+='<div class="dealer"><div style="display:flex;justify-content:space-between"><strong style="color:#ff9b57">Dealer</strong>'+(dealerTotal?'<span class="total">'+dealerTotal+'</span>':'')+'</div><div style="margin-top:6px">'+renderHand(state.dealerHand,!reveal)+'</div></div>';

  html+='<div class="seats">';
  for(const p of state.players){
    var isMe=p.id===myId;
    var isCur=state.currentPlayerId===p.id;
    var st={spectating:"spectating",busted:"bust",blackjack:"Blackjack!",won:"won",lost:"lost",push:"push",stood:"stood"}[p.status]||"";
    html+='<div class="seat'+(isCur?" seat-current":"")+'">'+
      '<div style="display:flex;justify-content:space-between"><strong>'+p.name+(isMe?" (you)":"")+'</strong>'+(isCur?'<span class="turn">TURN</span>':'')+'</div>'+
      '<div class="label">'+p.chips+' chips'+(p.bet>0?' · bet '+p.bet+(p.doubled?" (doubled)":""):"")+'</div>'+
      (st?'<div class="label" style="color:#6b8a7a">'+st+'</div>':'')+
      (p.hand.length>0?'<div style="margin-top:4px">'+p.hand.map(c=>renderCard(c,false)).join('')+'<span class="total">'+handTotal(p.hand)+'</span></div>':'')+
      '</div>';
  }
  html+='</div>';

  html+='<div class="controls">';
  if(me&&me.status==="spectating"){html+='<p class="label">Table is full. You\\'re spectating.</p>'}
  else if(canBet){
    html+='<input class="bet-input" type="number" min="1" max="'+(me?me.chips:0)+'" value="'+betAmt+'" onchange="betAmt=+this.value">'+
      '<button class="btn btn-primary" onclick="send({type:\\'bet\\',amount:betAmt})"'+(!me||me.chips<=0?' disabled':'')+'>Bet '+betAmt+'</button>'+
      [25,50,100,250].map(v=>'<button class="btn btn-secondary" onclick="betAmt=Math.min(betAmt+'+v+','+(me?me.chips:0)+');this.previousSibling.previousSibling.value=betAmt;this.previousSibling.textContent=\\'Bet \\'+betAmt">+'+v+'</button>').join("");
  }
  else if(canAct){
    html+='<button class="btn btn-primary" onclick="send({type:\\'hit\\'})">Hit</button>'+
      '<button class="btn btn-secondary" onclick="send({type:\\'stand\\'})">Stand</button>'+
      '<button class="btn btn-secondary" onclick="send({type:\\'double\\'})"'+(me.hand.length!==2||me.chips<me.bet?' disabled':'')+'>Double</button>';
  }
  else if(state.phase==="round_over"){
    html+='<button class="btn btn-primary" onclick="send({type:\\'ready\\'})">Ready for Next Round</button>'+
      '<button class="btn btn-secondary" onclick="send({type:\\'bet\\',amount:betAmt})">Bet Again</button>';
  }
  else{html+='<p class="label">Waiting…</p>'}
  html+='</div>';

  $("app").innerHTML=html;
}

function connect(){
  var proto=location.protocol==="https:"?"wss":"ws";
  ws=new WebSocket(proto+"://"+location.host+"/ws?game=blackjack&room=main");
  ws.onopen=function(){connected=true;render()};
  ws.onclose=function(){connected=false;render();setTimeout(connect,2000)};
  ws.onerror=function(){connected=false};
  ws.onmessage=function(e){
    var m=JSON.parse(e.data);
    if(m.type==="joined"){myId=m.playerId;var saved=localStorage.getItem("bj_name");if(saved&&!savedName){savedName=true;send({type:"join",name:saved})}}
    else if(m.type==="state"){state=m.state;render()}
  };
}
connect();
render();
</script></body></html>`;
