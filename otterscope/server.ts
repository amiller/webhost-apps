// otterscope — Otter via OAuth3. Reads your Otter through a scoped token from the oauth3-sdk
// connect() handshake (extension provider-preferred; web approve in the signed-in pod room
// otherwise — RFC 0008), never a cookie. Token persists in localStorage until you log out;
// conversations load a page at a time.

const BUILD = "b8";

const HTML = `<!doctype html><html lang=en><head>
<meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Otter via OAuth3</title>
<style>
 /* pod design system · constructivist overprint · grape-acid inking */
 :root{
   --ink1:#6f57a8; --ink2:#b5d33d; --paper:#f8f7f3; --deep:#2e2745; --overprint:#31491f;
   --bg:var(--paper); --text:var(--deep);
   --faint:color-mix(in srgb,var(--deep) 55%,var(--paper));
   --rule:color-mix(in srgb,var(--deep) 16%,var(--paper));
   --card:#fff; --block:var(--deep); --block-text:#f8f7f3;
   --wash1:color-mix(in srgb,var(--ink1) 15%,var(--paper));
   --wash2:color-mix(in srgb,var(--ink2) 17%,var(--paper));
   --i1-text:#5a4590; --i2-text:#6d8317;
   --warn:#a8780c; --warn-wash:color-mix(in srgb,#e0a41a 22%,var(--paper));
   --sans:"Helvetica Neue",Arial,sans-serif;
   --cond:"Arial Narrow","Helvetica Neue",sans-serif;
   --mono:ui-monospace,SFMono-Regular,Menlo,monospace; --off:1px;
 }
 @media (prefers-color-scheme: dark){ :root{
   --ink1:#9b82d6; --ink2:#cbe85c; --paper:#181524; --deep:#100d1a;
   --bg:#181524; --text:#e8e3f0;
   --faint:color-mix(in srgb,#e8e3f0 55%,#181524);
   --rule:color-mix(in srgb,#e8e3f0 14%,#181524);
   --card:#221d33; --block:#100d1a; --block-text:#e8e3f0;
   --wash1:color-mix(in srgb,#9b82d6 20%,#181524);
   --wash2:color-mix(in srgb,#cbe85c 20%,#181524);
   --i1-text:#b9a4e2; --i2-text:#d6f07a;
   --warn:#e0b34a; --warn-wash:color-mix(in srgb,#e0b34a 18%,#181524);
 }}
 :root[data-theme="dark"]{
   --ink1:#9b82d6; --ink2:#cbe85c; --paper:#181524; --deep:#100d1a;
   --bg:#181524; --text:#e8e3f0;
   --faint:color-mix(in srgb,#e8e3f0 55%,#181524);
   --rule:color-mix(in srgb,#e8e3f0 14%,#181524);
   --card:#221d33; --block:#100d1a; --block-text:#e8e3f0;
   --wash1:color-mix(in srgb,#9b82d6 20%,#181524);
   --wash2:color-mix(in srgb,#cbe85c 20%,#181524);
   --i1-text:#b9a4e2; --i2-text:#d6f07a;
   --warn:#e0b34a; --warn-wash:color-mix(in srgb,#e0b34a 18%,#181524);
 }
 :root[data-theme="light"]{
   --ink1:#6f57a8; --ink2:#b5d33d; --paper:#f8f7f3; --deep:#2e2745;
   --bg:#f8f7f3; --text:#2e2745;
   --faint:color-mix(in srgb,#2e2745 55%,#f8f7f3);
   --rule:color-mix(in srgb,#2e2745 16%,#f8f7f3);
   --card:#fff; --block:#2e2745; --block-text:#f8f7f3;
   --wash1:color-mix(in srgb,#6f57a8 15%,#f8f7f3);
   --wash2:color-mix(in srgb,#b5d33d 17%,#f8f7f3);
   --i1-text:#5a4590; --i2-text:#6d8317;
   --warn:#a8780c; --warn-wash:color-mix(in srgb,#e0a41a 22%,#f8f7f3);
 }
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 var(--sans)}
 a{color:var(--i1-text)}:focus-visible{outline:2px solid var(--ink2);outline-offset:2px}
 .wrap{max-width:760px;margin:0 auto;padding:48px 22px}
 h1{font:800 clamp(30px,5.5vw,48px)/0.94 var(--cond);text-transform:uppercase;margin:0;color:var(--ink1);text-shadow:var(--off) var(--off) 0 var(--ink2);text-wrap:balance}
 .sub{color:var(--faint);font:15px var(--sans);margin:8px 0 0;max-width:60ch}
 .accent{font:500 11px/1 var(--mono);letter-spacing:.16em;text-transform:lowercase;color:var(--i1-text)}
 button{display:inline-flex;align-items:center;gap:8px;font:800 14px var(--cond);text-transform:uppercase;letter-spacing:.12em;border:0;padding:12px 22px;cursor:pointer;background:var(--ink1);color:#fff;box-shadow:3px 3px 0 var(--ink2)}
 button:disabled{opacity:.5;cursor:default}
 .ghost{background:transparent;color:var(--i1-text);border:3px solid var(--ink1);box-shadow:none;padding:9px 18px;font:800 13px var(--cond);text-transform:uppercase;letter-spacing:.12em}
 .bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px}
 .who{font:500 12px var(--mono);color:var(--i1-text)}
 .diag{font:12px/1.7 var(--mono);color:var(--faint);margin:10px 0}
 .diag b.ok{color:var(--i1-text);font-weight:700} .diag b.bad{color:var(--i2-text);font-weight:700}
 #status{font:13px var(--mono);margin:14px 0;min-height:1.2em;color:var(--i2-text)}
 .approve{margin:2px 0 12px;padding:12px 16px;border:2px solid var(--ink1);background:var(--wash1);font:13px/1.6 var(--mono)}
 .approve a{font-weight:700} .approve .hint{display:block;color:var(--faint);margin-top:2px}
 .row{padding:12px 4px;border-bottom:1px solid var(--rule);display:flex;justify-content:space-between;align-items:baseline;gap:14px;cursor:pointer}
 .row:hover{color:var(--ink1)} .row .d{font:12px var(--mono);color:var(--faint);white-space:nowrap}
 pre{background:var(--block);color:var(--block-text);border-left:12px solid var(--ink2);padding:16px 20px;white-space:pre-wrap;font:13px/1.7 var(--mono);max-height:60vh;overflow:auto}
 #more{margin-top:12px}
</style></head><body><div class=wrap>
 <p class=accent>oauth3 · live demo · build ${BUILD}</p>
 <h1>Otter via OAuth3</h1>
 <p class=sub>Reads your Otter.ai conversations through a <b>scoped, revocable token</b> from your OAuth3 wallet — this app never sees your cookie.</p>
 <div class=diag id=diag>checking…</div>
 <div class=bar>
   <button id=connect>Connect Otter</button>
   <button id=load class=ghost style=display:none>Load conversations</button>
   <span class=who id=who style=display:none></span>
   <button id=logout class=ghost style=display:none>Log out</button>
 </div>
 <div id=status></div>
 <div id=approve class=approve style=display:none></div>
 <div id=list></div>
 <div><button id=more class=ghost style=display:none></button></div>
 <div id=convo></div>
<script>
 const NODE="/oauth3/api", O3=location.origin+"/oauth3", TK="o3_otter_token", PAGE=15, BUILD=${JSON.stringify(BUILD)};
 const $=id=>document.getElementById(id);
 const status=t=>{$("status").textContent=t};
 let token=localStorage.getItem(TK)||null, items=[], shown=0;
 function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}
 async function api(path){
   const t0=Date.now(); let r;
   try{ r=await fetch(NODE+path,{headers:{Authorization:"Bearer "+token}}); }
   catch(e){ throw new Error("network error reaching "+NODE+path+" after "+((Date.now()-t0)/1000).toFixed(1)+"s ("+(e&&e.message||e)+")"); }
   if(r.status===401){ logout(); throw new Error("token rejected — please connect again"); }
   if(r.status===409) throw new Error("your Otter isn't synced to this instance yet — add it from a device with the OAuth3 extension (log into otter.ai there), then reconnect");
   if(!r.ok) throw new Error("GET "+path+" → "+r.status+" "+(await r.text().catch(()=>"")).slice(0,140));
   return (await r.json()).data;
 }
 function setConnected(c){
   $("connect").style.display=c?"none":""; $("load").style.display=c?"":"none";
   $("logout").style.display=c?"":"none"; $("who").style.display=c?"":"none";
   $("who").textContent=c?"✓ connected (saved)":"";
 }
 function renderList(){
   $("list").innerHTML=items.slice(0,shown).map(it=>"<div class=row data-id='"+esc(it.id)+"'><span>"+
     (esc(it.title)||"(untitled)")+"</span><span class=d>"+(it.date?esc(it.date.slice(0,10)):"")+"</span></div>").join("");
   document.querySelectorAll(".row").forEach(r=>r.onclick=()=>openConvo(r.dataset.id));
   const left=items.length-shown;
   $("more").style.display=left>0?"":"none"; $("more").textContent="show "+Math.min(PAGE,left)+" more ("+left+" left)";
 }
 async function loadConvos(){
   $("load").disabled=true; status("loading your conversation list from otter.ai…");
   try{ items=await api("/otter/items"); shown=Math.min(PAGE,items.length); renderList();
     status(items.length+" conversations — showing "+shown);
   }catch(e){ status(String(e.message||e)) }
   $("load").disabled=false;
 }
 async function openConvo(otid){
   status("loading transcript…");
   try{ const d=await api("/otter/items/"+encodeURIComponent(otid)); status("");
     $("convo").innerHTML="<p class=accent style='margin-top:24px'>transcript</p><pre>"+esc(d.transcript||"(empty)")+"</pre>"+
       "<p><button class=ghost onclick=\\"$('convo').innerHTML=''\\">close</button></p>";
     $("convo").scrollIntoView({behavior:"smooth"});
   }catch(e){ status(String(e.message||e)) }
 }
 // oauth3-sdk connect() — ported verbatim from feedling-web/sdk/index.ts (this page is one
 // self-contained file: no build, no imports; feedling-web/oauth3-client.ts hand-drives the
 // same handshake for the same reason). Provider-preferred: if the OAuth3 wallet (extension)
 // is present, it carries the whole flow — copy the jar if needed, approve, hand back a token.
 // Web fallback (no extension — phone, same-pod): POST /api/connect, surface the approveUrl
 // for the user's signed-in pod room, poll until the token comes back. RFC 0008.
 async function oauth3Connect(opts){
   const prov=globalThis.oauth3 ?? globalThis.window?.oauth3;
   if(prov && typeof prov.connect==="function"){
     const t=await prov.connect({node:opts.node,plugin:opts.plugin,subject:opts.subject,app:opts.app});
     return t;
   }
   const cr=await fetch(opts.node+"/api/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({plugin:opts.plugin,subject:opts.subject,app:opts.app})});
   const cb=await cr.json().catch(()=>({}));
   if(!cr.ok) throw new Error(cb.error||("connect "+cr.status));
   await opts.onApproveUrl?.(cb.approveUrl);
   const interval=opts.intervalMs??2000, deadline=Date.now()+(opts.timeoutMs??300000);
   while(Date.now()<deadline){
     await new Promise(r=>setTimeout(r,interval));
     const s=await (await fetch(opts.node+"/api/connect/"+cb.requestId)).json().catch(()=>({}));
     if(s.status==="approved") return s.token;
     if(s.status==="denied") throw new Error("connect denied by user");
   }
   throw new Error("connect timed out");
 }
 function approveLink(u){
   $("approve").style.display="";
   $("approve").innerHTML="<a href='"+esc(u)+"' target=_blank rel=noopener>Open your pod room to approve Otter access →</a>"+
     "<span class=hint>no extension needed — approve there; this page continues on its own.</span>";
 }
 function clearApprove(){ $("approve").style.display="none"; $("approve").innerHTML=""; }
 async function connect(){
   $("connect").disabled=true; clearApprove();
   try{
     status("connecting through the oauth3-sdk handshake…");
     token=await oauth3Connect({node:O3,plugin:"otter",app:"otterscope",onApproveUrl:u=>{
       approveLink(u);
       status("waiting for approval — open the pod-room link and approve; this page continues automatically…");
     }});
     if(!token) throw new Error("connect returned no token (approval denied/cancelled)");
     localStorage.setItem(TK,token); setConnected(true); clearApprove();
     status("connected — click ‘Load conversations’ when you’re ready");
   }catch(e){ console.error(e); status(String(e&&e.message||e)) }
   $("connect").disabled=false;
 }
 function logout(){ localStorage.removeItem(TK); token=null; items=[]; shown=0; clearApprove();
   $("list").innerHTML=""; $("convo").innerHTML=""; $("more").style.display="none"; setConnected(false); status("logged out"); }
 async function diag(){
   let inst="…", ext=(globalThis.oauth3??globalThis.window?.oauth3)?"<b class=ok>present (provider-preferred)</b>":"<b class=ok>not loaded — web approve via your pod room (mobile/same-pod OK)</b>";
   try{ const h=await (await fetch(NODE+"/health")).json(); inst="<b class=ok>reachable</b> ("+(h.plugins||[]).join(", ")+")"; }
   catch(e){ inst="<b class=bad>unreachable: "+esc(e.message||e)+"</b>"; }
   $("diag").innerHTML="build "+BUILD+" · instance: "+inst+" · extension: "+ext;
 }
 $("connect").onclick=connect; $("load").onclick=loadConvos; $("logout").onclick=logout;
 $("more").onclick=()=>{ shown=Math.min(shown+PAGE,items.length); renderList(); status("showing "+shown+" of "+items.length); };
 setConnected(!!token);
 if(token) status("signed in (saved) — click ‘Load conversations’");
 diag();
</script></div></body></html>`;

export default async function handler(_req: Request, _ctx?: unknown): Promise<Response> {
  return new Response(HTML, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
  });
}
