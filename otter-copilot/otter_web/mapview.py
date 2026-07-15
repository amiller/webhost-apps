#!/usr/bin/env python3
"""Render a saved conversation graph (from replay.py --json) into a standalone HTML map.

  python3 otter_web/mapview.py graph.json -o map.html

Self-contained except the cytoscape CDN. Topic clusters = compound nodes, colored by
kind; click a node to read its text + speaker. Decisions listed in a side rail.
"""
import argparse, json
from pathlib import Path

TMPL = """<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>conversation map — __TITLE__</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-monospace,Menlo,monospace;background:#0b0c10;color:#d7dae0;height:100vh;display:flex;flex-direction:column}
header{padding:11px 18px;border-bottom:1px solid #1e2029;display:flex;gap:14px;align-items:baseline}
header b{color:#8ad;font-size:16px}header .m{color:#6b7080;font-size:12px}
.legend{margin-left:auto;font-size:11px;color:#7a8090;display:flex;gap:10px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:3px;vertical-align:0}
.main{flex:1;display:grid;grid-template-columns:1fr 340px;min-height:0}
#cy{min-height:0;border-right:1px solid #1e2029}
.side{display:flex;flex-direction:column;min-height:0}
.side h3{margin:0;padding:10px 16px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#c9a227;border-bottom:1px solid #16181f}
#sel{padding:12px 16px;border-bottom:1px solid #16181f;min-height:84px;color:#e6e9ef}
#sel .k{color:#6b7080;font-size:11px;margin-bottom:6px}
#dec{padding:8px 16px;overflow-y:auto;flex:1}
#dec .d{margin:0 0 8px;font-size:13px}#dec .d b{color:#c9a227;text-transform:uppercase;font-size:10px;margin-right:5px}
</style>
<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script></head>
<body>
<header><b>conversation map</b><span class="m">__TITLE__ · __NTOPICS__ topics · __NNODES__ moments · __NDEC__ decisions</span>
<span class="legend"><span><i style="background:#c9a227"></i>topic</span><span><i style="background:#4a90d9"></i>question</span>
<span><i style="background:#8a8f9c"></i>point</span><span><i style="background:#2bb673"></i>decision/action</span><span><i style="background:#c0524a"></i>divergence</span></span>
</header>
<div class="main"><div id="cy"></div>
<section class="side"><h3>selected</h3><div id="sel"><span class="k">click any moment in the map</span></div>
<h3>decisions &amp; actions</h3><div id="dec"></div></section></div>
<script>
const G=__GRAPH__;
const nodeMap={};for(const n of G.nodes)nodeMap[n.id]=n;
const els=[];
for(const t of G.topics)els.push({data:{id:t.id,label:t.label},classes:'topic'});
let prev=null;
for(const n of G.nodes){els.push({data:{id:n.id,parent:n.topic_id,kind:n.kind,label:n.speaker+': '+n.text},classes:n.kind});
  if(prev&&n.rel!=='new-topic')els.push({data:{id:'e_'+prev+'_'+n.id,source:prev,target:n.id}});prev=n.id;}
const cy=cytoscape({container:document.getElementById('cy'),elements:els,style:[
 {selector:'node',css:{'label':'data(label)','color':'#cdd2da','font-size':'9px','text-wrap':'wrap','text-max-width':'120px','background-color':'#8a8f9c','width':13,'height':13}},
 {selector:'node.topic',css:{'shape':'roundrectangle','background-color':'#c9a227','background-opacity':0.07,'border-width':1,'border-color':'#3a3f4d','color':'#c9a227','font-size':'11px','text-valign':'top','padding':'10px'}},
 {selector:'node.question',css:{'background-color':'#4a90d9'}},
 {selector:'node.decision',css:{'background-color':'#2bb673','width':16,'height':16}},
 {selector:'node.action_item',css:{'background-color':'#2bb673','shape':'diamond','width':16,'height':16}},
 {selector:'node.divergence',css:{'background-color':'#c0524a'}},
 {selector:'edge',css:{'width':1,'line-color':'#2a2e3b','target-arrow-color':'#2a2e3b','target-arrow-shape':'triangle','arrow-scale':0.6,'curve-style':'bezier'}},
],layout:{name:'cose',animate:false}});
const sel=document.getElementById('sel'),esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
cy.on('tap','node[kind]',e=>{const n=nodeMap[e.target.id()];if(!n)return;
  sel.innerHTML='<div class="k">'+n.kind+' · '+n.speaker+' · '+esc(n.topic||'')+'</div>'+esc(n.text);});
cy.on('tap','node.topic',e=>{sel.innerHTML='<div class="k">topic</div>'+esc(e.target.data('label'));});
const decs=new Set(G.decisions),dec=document.getElementById('dec');
dec.innerHTML=G.nodes.filter(n=>decs.has(n.id)).map(n=>'<p class="d"><b>'+n.kind+'</b>'+esc(n.speaker+': '+n.text)+'</p>').join('')||'<span class="k">none</span>';
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()
    g = json.loads(Path(args.json).read_text())
    html = (TMPL.replace("__GRAPH__", json.dumps(g))
            .replace("__TITLE__", str(g.get("title") or "untitled"))
            .replace("__NTOPICS__", str(len(g.get("topics", []))))
            .replace("__NNODES__", str(len(g.get("nodes", []))))
            .replace("__NDEC__", str(len(g.get("decisions", [])))))
    Path(args.out).write_text(html)
    print(f"wrote {args.out}  ({len(g.get('nodes', []))} nodes, {len(g.get('topics', []))} topics)")


if __name__ == "__main__":
    main()
