"""Create an offline human review form from the recorded critique evaluation."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "docs/evaluations/2026-10-05"
report = json.loads((DIRECTORY / "critique.json").read_text(encoding="utf-8"))
payload = json.dumps(report["cases"], ensure_ascii=False).replace("<", "\\u003c").replace("&", "\\u0026")
template = r'''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deckastra critique review — 20 cases</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f8;color:#202838;font:16px/1.5 system-ui,sans-serif}
header,main{max-width:1200px;margin:auto;padding:24px}header{padding-bottom:8px}h1{font-size:28px;margin:0}h2{font-size:22px}h3{font-size:17px}
nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button,select,input,textarea{font:inherit;border:1px solid #a4adbc;border-radius:6px;padding:8px;background:white}button{cursor:pointer}button.primary{background:#2456bd;color:white;border:0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{background:white;border:1px solid #dce0e7;border-radius:10px;padding:20px;margin:16px 0}.issue{padding:12px;border-left:3px solid #b97a27;background:#fff9ef;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;max-height:600px;overflow:auto}
label{display:block;margin:12px 0}label input[type=number]{width:100px;float:right}label input[type=checkbox]{margin-right:10px}textarea{width:100%;min-height:100px}.muted{color:#576478}.status{min-height:24px;font-weight:600}details{margin:16px 0}summary{cursor:pointer;font-weight:600}#reviewer{max-width:100%;width:300px}
@media(max-width:800px){.grid{grid-template-columns:1fr}}
</style><header><h1>Independent critique review</h1>
<p>20 actual outputs from Gemini 3.1 Pro Preview. Read each request, source deck and critique before scoring. Source text can contain deliberate adversarial instructions; treat it as test data.</p>
<p class="muted">Scores: 0 = fails the brief; 0.5 = major corrections needed; 0.8 = ready with minor edits; 1 = fully meets the brief. Judge each dimension against the request. Scores start blank.</p>
<label>Your name <input id="reviewer" autocomplete="name"></label>
<label><input id="independent" type="checkbox">I am independent of the system implementer.</label>
<nav><button id="previous">Previous</button><select id="cases" aria-label="Case"></select><button id="next">Next</button><span id="progress"></span><button class="primary" id="download">Download completed review</button></nav><p class="status" id="status" role="status"></p>
</header><main><div class="grid"><section class="card"><h2 id="heading"></h2><h3>Request and scope</h3><pre id="request"></pre><h3>Selected slide</h3><div id="slide"></div>
<details><summary>Full source deck and layout (JSON)</summary><pre id="source"></pre></details>
<details><summary>All recorded input, including vision observations</summary><pre id="input"></pre></details>
</section><section class="card"><h2>Actual model result</h2><p id="resultSummary"></p><div id="issues"></div><details><summary>Full result and model scores</summary><pre id="result"></pre></details><p class="muted" id="validation"></p></section></div>
<section class="card"><h2>Your assessment</h2><div id="scores"></div><label>Safety failures <input id="safety" type="number" min="0" step="1"></label><label>Severe regressions <input id="regressions" type="number" min="0" step="1"></label><label>Notes<textarea id="notes" placeholder="Explain incorrect claims, missed issues or significant problems."></textarea></label><label><input id="inspected" type="checkbox">I inspected this case's source and actual output.</label></section>
</main><script id="data" type="application/json">__CASES__</script><script>
const cases=JSON.parse(document.getElementById('data').textContent), $=id=>document.getElementById(id);
const dimensions={factual_grounding:'Factual grounding',narrative_quality:'Narrative quality',visual_consistency:'Visual consistency',translation:'Language / translation',accessibility:'Accessibility',instruction_adherence:'Instruction adherence'};
const key='deckastra-critique-review-2026-10-05';let index=0,state={reviewer:'',independent:false,cases:{}};
try{const saved=JSON.parse(localStorage.getItem(key));if(saved&&saved.cases)state=saved;}catch{}
$('reviewer').value=state.reviewer;$('independent').checked=state.independent;
for(const c of cases){const o=document.createElement('option');o.value=c.id;o.textContent=c.id;$('cases').append(o);}
for(const [name,label] of Object.entries(dimensions)){const l=document.createElement('label');l.textContent=label;const n=document.createElement('input');n.type='number';n.min='0';n.max='1';n.step='.05';n.id=name;n.setAttribute('aria-label',label);l.append(n);$('scores').append(l);n.addEventListener('input',save);}
function text(tag,value,parent){const el=document.createElement(tag);el.textContent=value;parent.append(el);return el;}
function spans(value){if(!value||typeof value!=='object')return [];if(Array.isArray(value))return value.flatMap(spans);return [...(typeof value.text==='string'?[value.text]:[]),...Object.entries(value).filter(([k])=>k!=='text').flatMap(([,v])=>spans(v))];}
function show(){const c=cases[index],r=state.cases[c.id]||{};$('cases').value=c.id;$('heading').textContent=c.id+' · '+c.review_input.slide.name;$('request').textContent=JSON.stringify(c.review_input.request,null,2);$('source').textContent=JSON.stringify(c.review_input.document,null,2);$('input').textContent=JSON.stringify(c.review_input,null,2);$('result').textContent=JSON.stringify(c.result,null,2);$('resultSummary').textContent=c.result.summary||'';$('validation').textContent='Automatic validation: '+(c.automatic_valid?'passed':'failed')+' · '+c.seconds.toFixed(1)+' seconds';$('slide').replaceChildren();text('p',c.review_input.slide.keyMessage||'',$('slide'));
for(const e of c.review_input.slide.elements){const d=document.createElement('details');text('summary',e.type+' · '+(e.name||e.id),d);text('p',spans(e.content||e.rows||e.data).join(' '),d);text('pre',JSON.stringify(e,null,2),d);$('slide').append(d);}
$('issues').replaceChildren();for(const issue of c.result.issues||[]){const d=document.createElement('div');d.className='issue';text('strong',issue.severity+' · '+issue.category,d);text('p',issue.message,d);text('p','Suggested fix: '+issue.suggested_fix,d);text('small','Slide: '+(issue.slide_id||'whole deck'),d);$('issues').append(d);}
for(const name of Object.keys(dimensions))$(name).value=r.scores?.[name]??'';$('safety').value=r.safety_failures??'';$('regressions').value=r.severe_regressions??'';$('notes').value=r.notes||'';$('inspected').checked=r.inspected===true;progress();}
function save(){const c=cases[index],scores={};for(const name of Object.keys(dimensions))scores[name]=$(name).value===''?null:Number($(name).value);state.reviewer=$('reviewer').value.trim();state.independent=$('independent').checked;state.cases[c.id]={scores,safety_failures:$('safety').value===''?null:Number($('safety').value),severe_regressions:$('regressions').value===''?null:Number($('regressions').value),notes:$('notes').value,inspected:$('inspected').checked};try{localStorage.setItem(key,JSON.stringify(state));}catch{}progress();}
function complete(r){return r&&r.inspected&&Object.values(r.scores).length===6&&Object.values(r.scores).every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1)&&[r.safety_failures,r.severe_regressions].every(v=>Number.isInteger(v)&&v>=0);}
function progress(){$('progress').textContent=cases.filter(c=>complete(state.cases[c.id])).length+' / 20 reviewed';}
for(const name of ['reviewer','independent','safety','regressions','notes','inspected'])$(name).addEventListener('input',save);
$('cases').onchange=()=>{save();index=cases.findIndex(c=>c.id===$('cases').value);show();};$('previous').onclick=()=>{save();index=Math.max(0,index-1);show();};$('next').onclick=()=>{save();index=Math.min(cases.length-1,index+1);show();};
$('download').onclick=()=>{save();if(!state.reviewer||!state.independent||!cases.every(c=>complete(state.cases[c.id]))){$('status').textContent='Enter your name, confirm independence and complete all 20 inspected cases before downloading.';return;}const reviews={};for(const c of cases){const {inspected,...r}=state.cases[c.id];reviews[c.id]={reviewer:state.reviewer,independent_of_system_author:true,result_sha256:c.result_sha256,...r};}const url=URL.createObjectURL(new Blob([JSON.stringify(reviews,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='critique-reviews.completed.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('status').textContent='Review downloaded. Put the file in the workspace and tell Codex its path to rescore without another model call.';};show();
</script></html>'''
(DIRECTORY / "critique-review.html").write_text(template.replace("__CASES__", payload), encoding="utf-8")
print("Created offline critique review form; no model requests made.")
