/**
 * src/poker/page.ts — Standalone HTML page for Peggy's Poker House.
 *
 * Served by the peggys-poker Worker at /poker.
 * Ported from peggys-poker/page.html with one change: the WebSocket
 * now connects to /ws?game=poker (instead of location.pathname+"/ws")
 * so it works behind the Workers route at www.arcelectproapp.com/poker*.
 */

export const POKER_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peggy's Poker House</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0b1f17;color:#f3efe6}
header{padding:12px;text-align:center;background:#071510}
h1{margin:0;font-size:1.6rem;color:#ff9b57}
.wrap{padding:12px;max-width:820px;margin:auto}
button{min-height:44px;padding:0 14px;margin:4px;border-radius:22px;border:0;background:#ff7a3c;color:#111;font-weight:700}
input{min-height:44px;padding:0 12px;border-radius:22px;border:1px solid #3ea37a;background:#102a20;color:#fff;margin:4px;max-width:100%;box-sizing:border-box}
.panel{background:#102a20;border:1px solid #2f7a5c;border-radius:16px;padding:12px;margin:10px 0}
.seats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.seat{background:#071510;border-radius:12px;padding:8px;min-height:70px;font-size:.9rem}
.cards span{display:inline-block;background:#fff;color:#111;border-radius:6px;padding:4px 6px;margin:2px;font-weight:700}
.cards span.red{color:#c00}
.lb-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a3a2a}
.lb-row:last-child{border-bottom:0}
.lb-rank{color:#ff9b57;font-weight:700;width:24px}
.lb-name{flex:1;padding:0 8px}
.lb-score{font-weight:700}
@media (min-width:600px){.seats{grid-template-columns:repeat(3,1fr)}}
</style></head>
<body>
<header><h1>Peggy's Poker House</h1><div id="status">Connecting\u2026</div></header>
<div class="wrap" id="app"></div>
<script>
var app=document.getElementById("app"), statusEl=document.getElementById("status");
var state=null, myName=localStorage.getItem("pph_name")||"", selected=new Set(), lastHand=-1;
var maxDiscardNow=4;
var board=null;
var proto=location.protocol==="https:"?"wss":"ws";
var ws=new WebSocket(proto+"://"+location.host+"/ws?game=poker");
function send(o){ if(ws.readyState===1) ws.send(JSON.stringify(o)); }
ws.onopen=function(){ statusEl.textContent="Connected"; if(myName) send({type:"name",name:myName}); };
ws.onclose=function(){ statusEl.textContent="Disconnected. Refresh to reconnect."; };
ws.onmessage=function(e){
  var m=JSON.parse(e.data);
  if(m.type==="error"){ statusEl.textContent=m.msg; return; }
  state=m; render();
  if(m.results) fetchBoard();
};
function fetchBoard(){
  fetch("/api/scores").then(function(r){return r.json();}).then(function(d){
    board=d["peggys-poker"]||[]; render();
  }).catch(function(){});
}
fetchBoard();
setInterval(fetchBoard,30000);
function el(tag, attrs, ...kids){
  var n=document.createElement(tag); attrs=attrs||{};
  for(var k in attrs){ if(k==="onclick") n.onclick=attrs[k]; else n.setAttribute(k, attrs[k]); }
  for(var c of kids){ if(c===null||c===undefined||c==="") continue; n.append(c instanceof Node? c : document.createTextNode(String(c))); }
  return n;
}
function btn(label, fn){ return el("button", {onclick:fn}, label); }
var SUIT={S:"\u2660",H:"\u2665",D:"\u2666",C:"\u2663"}, RANK={11:"J",12:"Q",13:"K",14:"A"};
function cardLabel(c){ return (RANK[c.r]||c.r)+SUIT[c.s]; }
function cardEl(c,i,clickable){
  var red=c.s==="H"||c.s==="D";
  var sp=el("span",{class:red?"red":""},cardLabel(c));
  if(clickable){
    sp.style.cursor="pointer";
    if(selected.has(i)) sp.style.outline="3px solid #ff7a3c";
    sp.onclick=function(){
      if(selected.has(i)) selected.delete(i);
      else if(selected.size<maxDiscardNow) selected.add(i);
      render();
    };
  }
  return sp;
}
function render(){
  app.replaceChildren();
  if(!myName){
    var nameIn=el("input",{placeholder:"Your name",maxlength:16});
    var save=function(){
      var v=nameIn.value.trim().slice(0,16);
      if(!v) return;
      myName=v; localStorage.setItem("pph_name",v); send({type:"name",name:v}); render();
    };
    app.append(el("div",{class:"panel"}, el("p",{},"Enter a name to play."), nameIn, btn("Save",save)));
    return;
  }
  if(state) renderTable();
}
function renderTable(){
  var s=state;
  maxDiscardNow=s.maxDiscard||4;
  if(s.handNo!==lastHand){ selected=new Set(); lastHand=s.handNo; }
  var me=s.yourSeat>=0 ? s.seats[s.yourSeat] : null;
  var seatEls=s.seats.map(function(q,i){
    if(!q) return el("div",{class:"seat"},"Seat "+(i+1)+": empty");
    var marks=[];
    if(i===s.dealer) marks.push("DEALER");
    if(i===s.turn && s.phase==="bet") marks.push("TURN");
    if(q.folded) marks.push("folded");
    if(q.inHand && q.chips===0 && !q.folded) marks.push("all in");
    if(q.discarded) marks.push("discarded");
    return el("div",{class:"seat"},
      el("b",{}, q.name+(i===s.yourSeat?" (you)":"")),
      el("div",{}, q.chips+" chips \u00b7 in pot "+q.contrib),
      el("div",{}, marks.join(" \u00b7 ")),
      q.cards ? el("div",{class:"cards"}, ...q.cards.map(function(c,j){ return cardEl(c,j,false); }))
              : el("div",{}, q.inHand ? q.count+" face-down cards" : "sitting out"));
  });
  var myCards = me && me.cards && me.cards.length
    ? el("div",{class:"cards"}, ...me.cards.map(function(c,i){ return cardEl(c,i,s.phase==="discard" && !me.discarded && !me.folded); }))
    : el("div",{}, "No cards yet.");
  var ctl=[];
  if(!me){
    var full=!s.seats.includes(null);
    if(s.reservedPosition>0) ctl.push(el("p",{}, "You are in reserve position "+s.reservedPosition+". You will be seated when a seat opens."));
    else ctl.push(btn(full?"Table full: join reserve line":"Sit down (1000 chips)", function(){ send({type:"sit"}); }));
  } else {
    ctl.push(btn("Stand up", function(){ send({type:"stand"}); }));
  }
  if(s.phase==="ante" && s.dealer===s.yourSeat){
    var anteIn=el("input",{type:"number",min:5,max:1000,value:s.ante,id:"ante",style:"width:110px"});
    ctl.push(el("div",{}, el("p",{}, "You are dealing. Set the ante:"), anteIn,
      btn("Deal", function(){ send({type:"ante",ante:Number(anteIn.value)}); })));
  }
  if(s.phase==="bet" && s.turn===s.yourSeat && me){
    var need=s.toCall;
    var acts=[];
    acts.push(need===0
      ? btn("Check", function(){ send({type:"check"}); })
      : btn("Call "+need, function(){ send({type:"call"}); }));
    var raiseIn=el("input",{type:"number",min:s.minRaise,value:s.minRaise,style:"width:110px"});
    ctl.push(el("div",{},
      el("p",{}, "Your turn. "+(need>0?"To call: "+need+". ":"")+"Raise by at least "+s.minRaise+" (no upper limit)."),
      acts[0], raiseIn,
      btn("Raise", function(){ send({type:"raise",amount:Number(raiseIn.value)}); }),
      btn("All in", function(){ send({type:"raise",amount:me.chips}); }),
      btn("Fold", function(){ send({type:"fold"}); })));
  }
  if(s.phase==="discard" && me && !me.discarded && !me.folded){
    ctl.push(el("div",{},
      btn("Discard selected ("+selected.size+" of "+s.maxDiscard+") and draw", function(){ send({type:"discard",indexes:[...selected]}); selected=new Set(); }),
      btn("Keep all", function(){ send({type:"discard",indexes:[]}); })));
  }
  var res = s.results ? el("div",{class:"panel"}, el("b",{},"Last hand"),
    ...s.results.map(function(r){ return el("div",{}, r.name+": "+r.hand+(r.won?" (winner)":"")); })) : null;
  var lb = board && board.length ? el("div",{class:"panel"},
    el("h3",{},"\uD83C\uDFC6 Top Hands"),
    ...board.map(function(b,i){
      return el("div",{class:"lb-row"},
        el("span",{class:"lb-rank"}, String(i+1)),
        el("span",{class:"lb-name"}, b.name),
        el("span",{class:"lb-score"}, b.score+" chips"));
    })) : null;
  app.append(
    el("div",{class:"panel"},
      el("div",{}, "Hand "+s.handNo+" \u00b7 "+s.phase+(s.phase==="bet"||s.phase==="discard"?" \u00b7 round "+s.round:"")+" \u00b7 Ante "+s.ante+" \u00b7 Pot "+s.pot),
      el("p",{}, s.msg),
      el("div",{}, "Waiting in reserve: "+s.reserve)),
    el("div",{class:"seats"}, ...seatEls),
    el("div",{class:"panel"}, el("h3",{},"Your hand"), myCards, ...ctl),
    ...(res ? [res] : []),
    ...(lb ? [lb] : [])
  );
}
</script>
</body></html>`;
