// otterscope — Otter via OAuth3. Reads your Otter through a scoped token from your
// extension (window.oauth3.connect), never a cookie. Token persists in localStorage
// until you log out; conversations load a page at a time.

const BUILD = "b7";

const HTML = `<!doctype html><html lang=en><head>
<meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Otter via OAuth3</title>
<style>
 :root{--ink:#16140f;--paper:#f4f0e7;--panel:#ece6d9;--faint:#6b6557;--rule:#d8d2c4;--accent:#b4441f;
   --green:#3f7a3f;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
 *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Georgia,serif;font-size:17px;line-height:1.5}
 .wrap{max-width:760px;margin:0 auto;padding:48px 22px}
 h1{font-size:40px;margin:0;letter-spacing:-.02em}
 .sub{color:var(--faint);font-size:15px;margin:8px 0 0}
 .accent{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
 button{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:11px 20px;cursor:pointer;font-size:15px}
 button:disabled{opacity:.5;cursor:default}
 .ghost{background:none;color:var(--accent);border:1px solid var(--rule);padding:8px 14px;font-size:14px;border-radius:9px}
 .bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px}
 .who{font-family:var(--mono);font-size:12px;color:var(--green)}
 .diag{font-family:var(--mono);font-size:12px;color:var(--faint);margin:10px 0;line-height:1.7}
 .diag b.ok{color:var(--green)} .diag b.bad{color:var(--accent)}
 #status{font-family:var(--mono);font-size:13px;margin:14px 0;min-height:1.2em;color:var(--accent)}
 .row{padding:12px 4px;border-bottom:1px solid var(--rule);display:flex;justify-content:space-between;align-items:baseline;gap:14px;cursor:pointer}
 .row:hover{color:var(--accent)} .row .d{font-family:var(--mono);font-size:12px;color:var(--faint);white-space:nowrap}
 pre{background:var(--ink);color:#ece6d9;border-radius:12px;padding:18px;white-space:pre-wrap;font-family:var(--mono);font-size:13px;line-height:1.55;max-height:60vh;overflow:auto}
 a{color:var(--accent)} #more{margin-top:12px}
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
 <div id=list></div>
 <div><button id=more class=ghost style=display:none></button></div>
 <div id=convo></div>
<script>
 const NODE="/oauth3/api", TK="o3_otter_token", PAGE=15, BUILD=${JSON.stringify(BUILD)};
 const $=id=>document.getElementById(id);
 const status=t=>{$("status").textContent=t};
 let token=localStorage.getItem(TK)||null, items=[], shown=0;
 function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}
 async function api(path){
   const t0=Date.now(); let r;
   try{ r=await fetch(NODE+path,{headers:{Authorization:"Bearer "+token}}); }
   catch(e){ throw new Error("network error reaching "+NODE+path+" after "+((Date.now()-t0)/1000).toFixed(1)+"s ("+(e&&e.message||e)+")"); }
   if(r.status===401){ logout(); throw new Error("token rejected — please connect again"); }
   if(r.status===409) throw new Error("your Otter isn't synced to this instance yet — log into otter.ai in this browser, then reconnect");
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
 async function connect(){
   if(!window.oauth3){ status("OAuth3 extension not found — load it at chrome://extensions, then reload."); return; }
   $("connect").disabled=true;
   const node=location.origin+"/oauth3";
   try{
     status("approve the request in your OAuth3 extension…");
     try{ token=await window.oauth3.connect({node,plugin:"otter",app:"otterscope"}); }
     catch(e){ console.error(e); throw new Error("connect step failed: "+(e&&e.message||e)+" — is the extension up to date? (reload it)"); }
     if(!token) throw new Error("connect returned no token (approval denied/cancelled)");
     localStorage.setItem(TK,token); setConnected(true);
     status("connected — click ‘Load conversations’ when you’re ready");
   }catch(e){ console.error(e); status(String(e&&e.message||e)) }
   $("connect").disabled=false;
 }
 function logout(){ localStorage.removeItem(TK); token=null; items=[]; shown=0;
   $("list").innerHTML=""; $("convo").innerHTML=""; $("more").style.display="none"; setConnected(false); status("logged out"); }
 async function diag(){
   let inst="…", ext=window.oauth3?"<b class=ok>present</b>":"<b class=bad>NOT FOUND — load/reload the extension</b>";
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
