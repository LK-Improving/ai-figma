// Product workflow simulator. No model, CLI, screenshots API or MCP calls are made.
const workflow = {
  runId:'run_demo_04', attempt:1, baseRevision:12, stage:'idle',
  maxParallel:5, scenario:'success', repairRound:0, repairLimit:2,
  selectedAgent:'Coordinator', selectedRound:0, stepIndex:-1,
  tasks:[], events:[], rounds:[], snapshots:[], steps:[],
  activeCount:0, maxActiveObserved:0, automatic:false, patchApplied:0,
  counter:4, accepted:false, quality:'not_checked', startDone:0
};
let workflowTimer=null;
const phaseNames={idle:'尚未运行',queued:'排队',preparing:'准备上下文',planning:'规划与委派',designing:'区域并行生成',assembling:'合并与结构校验',capturing:'捕获截图',reviewing:'视觉自我审查',repairing:'局部修复',applying:'应用 Patch',completed:'完成',needs_review:'转人工处理',cancelled:'已取消',conflict:'检测到人工修改'};
const taskNames={pending:'排队',running:'执行中',completed:'已完成',cancelled:'已取消',repairing:'修复中'};
const nodeKeys=['hero','features','story','reviews','footer'];
function emitWorkflow(role,tool,input,output,summary){
  workflow.events.push({seq:workflow.events.length+1,runId:workflow.runId,attemptId:workflow.attempt,role,tool,stage:workflow.stage,round:workflow.repairRound,revision:state.revision,input,output,summary});
}
function makeWorkflowSteps(resumeDone=0){
  const steps=[{stage:'queued'},{stage:'preparing'},{stage:'planning'}];
  const pending=agents.map((_,i)=>i).filter(i=>i>=resumeDone);
  for(let n=0;n<pending.length;n+=workflow.maxParallel){
    const batch=pending.slice(n,n+workflow.maxParallel);
    steps.push({stage:'designing',op:'launch',batch});
    for(const i of batch)steps.push({stage:'designing',op:'finish',batch:[i]});
  }
  steps.push({stage:'assembling'},{stage:'capturing',round:0},{stage:'reviewing',round:0});
  for(let r=1;r<=2;r++)steps.push({stage:'repairing',round:r},{stage:'applying',round:r},{stage:'capturing',round:r},{stage:'reviewing',round:r});
  return steps;
}
function resetWorkflow(resumeDone=0){
  clearInterval(workflowTimer);workflowTimer=null;clearInterval(timer);clearTimeout(timer);
  workflow.counter++;workflow.runId='run_demo_'+String(workflow.counter).padStart(2,'0');
  workflow.attempt=1;workflow.baseRevision=state.revision;workflow.stage='idle';
  workflow.repairRound=0;workflow.selectedRound=0;workflow.stepIndex=-1;
  workflow.tasks=agents.map((name,i)=>({name,id:'region_'+(i+1),node:nodeKeys[i],namespace:'R'+(i+1),status:i<resumeDone?'completed':'pending',inputRevision:state.revision,outputRevision:null}));
  workflow.events=[];workflow.rounds=[];workflow.snapshots=[];workflow.activeCount=0;
  workflow.maxActiveObserved=0;workflow.patchApplied=0;workflow.accepted=false;
  workflow.quality='not_checked';workflow.startDone=resumeDone;
  workflow.steps=makeWorkflowSteps(resumeDone);
  state.running=true;state.cancelled=false;state.fixed=false;state.done=resumeDone;state.phase='queued';state.left='agent';
}
function scheduleWorkflow(){
  clearInterval(workflowTimer);workflow.automatic=true;
  workflowTimer=setInterval(()=>{if(!state.running){clearInterval(workflowTimer);workflowTimer=null;return}advanceWorkflow()},850);
}
function finishWorkflow(status){
  clearInterval(workflowTimer);workflowTimer=null;workflow.automatic=false;
  workflow.stage=status;state.phase=status;state.running=false;state.cancelled=status==='cancelled';
  state.fixed=status==='completed'&&workflow.quality==='passed';
  emitWorkflow('Coordinator','run.finish',{status},{quality:workflow.quality,repairRounds:workflow.repairRound,unresolved:workflow.rounds.at(-1)?.issues.length||0},phaseNames[status]);
}
function workflowIssues(round){
  const initial=[
    {id:'VI-01',nodeId:'hero.subtitle',node:'hero',owner:'Newton',severity:'warning',category:'色彩对比',title:'首屏正文颜色偏淡',evidence:'当前正文变量在浅绿背景上偏淡；示例诊断，未进行真实测量。',change:'color.text.secondary: #A3B9A5 → #536D58'},
    {id:'VI-02',nodeId:'story.title',node:'story',owner:'Maxwell',severity:'blocker',category:'边界溢出',title:'精选内容标题被裁切',evidence:'文本盒高度不足，第二行标题被裁切；需要修复后再次截图。',change:'height: 28 → auto; lineHeight: 1.35 → 1.55'},
    {id:'VI-03',nodeId:'features.cards',node:'features',owner:'Tesla',severity:'warning',category:'布局对齐',title:'卡片组间距未使用共享变量',evidence:'区域使用独立 gap，未引用 spacing.3；不修改业务文字。',change:'gap: 11 → {variable: spacing.3, value: 12}'}
  ];
  if(round===0)return initial;
  if(round===1)return [initial[2]];
  if(workflow.scenario==='blocked')return [initial[1]];
  return workflow.scenario==='exhausted'?[initial[2]]:[];
}
function captureWorkflow(round){
  const snapshot={id:`shot_${workflow.runId}_${round}`,round,revision:state.revision,ready:true,scale:1,assets:'ready',fonts:'ready',sample:true};
  workflow.snapshots.push(snapshot);
  emitWorkflow('Visual Harness','capture_screenshot',{nodeIds:['root'],revision:state.revision,waitFor:['fonts','assets']},snapshot,'截图与文档 revision 对齐（示例）');
}
function reviewWorkflow(round){
  const issues=workflowIssues(round),snapshot=workflow.snapshots.at(-1);
  workflow.rounds.push({round,revision:state.revision,screenshotId:snapshot.id,issues,decision:issues.length?'repair':'pass',dimensions:7});
  workflow.selectedRound=round;
  workflow.quality=issues.length?'issues_found':'passed';
  emitWorkflow('Visual Harness','visual_check',{screenshotId:snapshot.id,revision:state.revision,dimensions:7},{issues:issues.map(x=>({issueId:x.id,nodeId:x.nodeId,severity:x.severity,owner:x.owner})),decision:issues.length?'repair':'pass'},issues.length?`发现 ${issues.length} 项问题，返回协调者`:'七维复审通过');
  if(!issues.length){finishWorkflow('completed');return}
  if(round>=workflow.repairLimit){workflow.rounds.at(-1).decision='needs_review';workflow.quality=issues.some(x=>x.severity==='blocker')?'blocked':'warnings';finishWorkflow('needs_review');}
}
function advanceWorkflow(){
  if(!state.running)return;
  const step=workflow.steps[++workflow.stepIndex];if(!step){finishWorkflow('needs_review');render();return}
  workflow.stage=step.stage;state.phase=step.stage;
  if(step.round!==undefined)workflow.repairRound=step.round;
  switch(step.stage){
    case 'queued':emitWorkflow('Coordinator','run.queued',{prompt:state.prompt},{runId:workflow.runId,maxParallel:workflow.maxParallel},'创建 Run 与独立区域命名空间');break;
    case 'preparing':
      emitWorkflow('Coordinator','read_variables',{documentId:'qinghe',revision:state.revision},{tokens:['color.primary','spacing.3','typography.body']},'读取设计上下文与历史');
      emitWorkflow('Coordinator','set_variables',{freezeTokenVersion:1},{shared:true,collaboratorWrite:false},'冻结共享设计变量');break;
    case 'planning':emitWorkflow('Coordinator','planned_visual',{prompt:state.prompt,width:state.width},{regions:workflow.tasks.map(t=>({regionId:t.id,owner:t.name,namespace:t.namespace})),assemblyOwner:'Coordinator'},'委派 5 个独立区域，限定写入范围');break;
    case 'designing':
      if(step.op==='launch')for(const i of step.batch){workflow.tasks[i].status='running';workflow.activeCount++;emitWorkflow('Coordinator','delegate_region',{owner:agents[i],regionId:workflow.tasks[i].id,namespace:workflow.tasks[i].namespace,baseRevision:state.revision},{state:'running'},`委派 ${regions[i]}`)}
      else for(const i of step.batch){workflow.tasks[i].status='completed';workflow.activeCount--;state.done=workflow.tasks.filter(t=>t.status==='completed').length;emitWorkflow(agents[i],'region_result',{regionId:workflow.tasks[i].id},{subtree:nodeKeys[i],schema:'passed',isolatedCandidate:true},'返回候选子树，不直接写正式文档')}
      workflow.maxActiveObserved=Math.max(workflow.maxActiveObserved,workflow.activeCount);break;
    case 'assembling':
      state.revision++;workflow.baseRevision=state.revision;workflow.tasks.forEach(t=>t.outputRevision=state.revision);
      emitWorkflow('Coordinator','assemble_document',{regions:5,expectedRevision:state.revision-1},{committedRevision:state.revision,schema:'passed',tokenReferences:'passed'},'单写者合并，提交生成版本');break;
    case 'capturing':captureWorkflow(step.round);break;
    case 'reviewing':reviewWorkflow(step.round);break;
    case 'repairing':{
      const issues=workflow.rounds.at(-1).issues.filter(i=>step.round!==1||i.id!=='VI-03');
      for(const i of issues)workflow.tasks.find(t=>t.name===i.owner).status='repairing';
      emitWorkflow('Coordinator','repair',{issueIds:issues.map(i=>i.id),round:step.round,allowedNodeIds:issues.map(i=>i.nodeId)},{delegated:issues.map(i=>({owner:i.owner,nodeId:i.nodeId})),expectedRevision:state.revision},`第 ${step.round} 轮：仅重派问题节点`);
      for(const i of issues)emitWorkflow(i.owner,'propose_patch',{issueId:i.id,nodeId:i.nodeId},{patch:i.change,scope:'target only'},'返回最小修复候选');break;
    }
    case 'applying':
      if(state.revision!==workflow.baseRevision){workflow.quality='conflict';emitWorkflow('Coordinator','patch_conflict',{expected:workflow.baseRevision,actual:state.revision},{applied:false,preserveHumanEdit:true},'人工修改后 revision 改变，停止自动覆盖');finishWorkflow('needs_review');break}
      state.revision++;workflow.baseRevision=state.revision;workflow.patchApplied=step.round;
      workflow.tasks.forEach(t=>{if(t.status==='repairing')t.status='completed'});
      emitWorkflow('Coordinator','apply_patch',{baseRevision:state.revision-1,round:step.round},{revision:state.revision,nonTargetNodes:'unchanged',undoGroup:`repair_${step.round}`},'校验写入范围并提交修复事务');break;
  }
  render();
}
function startWorkflow(mode='auto',resumeDone=0,route='orchestration'){
  resetWorkflow(resumeDone);state.page=route;location.hash=route;advanceWorkflow();
  if(mode==='auto')scheduleWorkflow();
}
function seedWorkflow(target){
  resetWorkflow();workflow.automatic=false;
  let guard=0;
  while(state.running&&guard++<40){advanceWorkflow();
    if(target==='collaboration'&&workflow.stage==='designing'&&workflow.activeCount>0)break;
    if(target==='review'&&workflow.stage==='reviewing'&&workflow.repairRound===0)break;
    if(target==='repair'&&workflow.stage==='repairing'&&workflow.repairRound===1)break;
    if(target==='done'&&!state.running)break;
  }
  state.page=target==='collaboration'?'orchestration':'validation';location.hash=state.page;render();
}
function eventDetails(events,compact=false){return `<div class="event-list ${compact?'agent-feed':''}">${events.slice().reverse().map(e=>`<details class="event-detail"><summary><span>#${String(e.seq).padStart(2,'0')} · ${esc(e.role)}</span><b>${esc(e.tool)}</b><span class="tag">${e.round?`修复 ${e.round}`:'初检'}</span></summary><p>${esc(e.summary)} · rev ${e.revision}</p><pre>${esc(JSON.stringify({input:e.input,output:e.output},null,2))}</pre></details>`).join('')||'<p class="muted" style="font-size:11px">尚无工具事件；开始运行或加载阶段示例。</p>'}</div>`}
function runControls(){return `<div class="row workflow-toolbar"><label for="workflow-parallel">并发</label><select id="workflow-parallel" ${state.running?'disabled':''}><option value="1" ${workflow.maxParallel===1?'selected':''}>1 个区域执行者</option><option value="3" ${workflow.maxParallel===3?'selected':''}>3 个区域执行者</option><option value="5" ${workflow.maxParallel===5?'selected':''}>5 个区域执行者</option></select><label for="workflow-scenario">场景</label><select id="workflow-scenario" ${state.running?'disabled':''}><option value="success" ${workflow.scenario==='success'?'selected':''}>两轮修复后通过</option><option value="exhausted" ${workflow.scenario==='exhausted'?'selected':''}>两轮耗尽 / 留警告</option><option value="blocked" ${workflow.scenario==='blocked'?'selected':''}>两轮耗尽 / 留阻断</option></select><button class="primary" id="workflow-auto" ${state.running?'disabled':''}>运行完整 Loop</button><button id="workflow-manual" ${state.running?'disabled':''}>逐步演示</button><button id="workflow-next" ${!state.running||workflow.automatic?'disabled':''}>下一步 →</button><button id="workflow-cancel" ${!state.running?'disabled':''}>取消</button>${workflow.stage==='cancelled'?'<button id="workflow-resume">从检查点继续</button>':''}</div>`}
function loopRibbon(){const current={assembling:0,capturing:1,reviewing:2,repairing:3,applying:4,completed:5,needs_review:5}[workflow.stage];return `<div class="loop-ribbon">${['组装与校验','截图捕获','视觉自审','定点修复','提交 Patch','复审决策'].map((n,i)=>`<div class="loop-cell ${i===current?'active':current!==undefined&&i<current?'done':''}"><span class="num">0${i+1}</span><b>${n}</b></div>`).join('')}</div><div class="loop-return">↶ 未通过且 repairRound &lt; 2：修复 → 新截图 → 再审查</div>`}
function collaborationPage(){
  const selected=workflow.tasks.find(t=>t.name===workflow.selectedAgent);
  return `<div class="workflow-page">${pageTitle('看见每个 Agent 如何协作。','协调者统一规划，执行者并行产出；视觉审查驱动下一轮定点修复。','<span class="tag blue">P10 / Agent 协作控制台</span>')}<div class="panel run-banner"><div class="row between"><div><b class="mono">${workflow.runId}</b><span class="tag ${workflow.stage==='completed'?'green':workflow.stage==='needs_review'?'orange':''}" style="margin-left:12px">${phaseNames[workflow.stage]}</span><p class="workflow-live-note">1 Coordinator + 5 Collaborators · ${workflow.activeCount} 个区域执行中 / 上限 ${workflow.maxParallel} · 修复 ${workflow.repairRound} / 2</p></div><button class="small" data-go="editor">查看画布与 Agent 光标 ↗</button></div></div>${runControls()}<div class="coordinator" style="margin-top:20px"><div class="row between"><div class="row"><span class="mark">⌘</span><div><b>miaoma / Coordinator</b><p class="muted" style="font-size:11px">读取上下文 → 冻结 Token → 规划区域 → 委派 → 合并 → Loop 决策</p></div></div><button class="small ${workflow.selectedAgent==='Coordinator'?'active':''}" data-agent="Coordinator">查看总控日志</button></div></div><div class="flow-connector">共享 Token 与规划上下文　↓　隔离候选产物　↑　统一提交 revision</div><div class="agent-grid">${workflow.tasks.map((t,i)=>`<button class="agent-card ${workflow.selectedAgent===t.name?'selected':''}" data-agent="${t.name}"><div class="row"><span class="agent-dot" style="background:${agentColors[i]}"></span><h3>${t.name}</h3></div><p>${regions[i]}</p><span class="tag ${t.status==='completed'?'green':t.status==='running'||t.status==='repairing'?'blue':''}">${taskNames[t.status]}</span><span class="mono">${t.namespace} / ${t.node}</span></button>`).join('')||agents.map((a,i)=>`<button class="agent-card" data-agent="${a}"><h3>${a}</h3><p>${regions[i]}</p><span class="tag">待委派</span></button>`).join('')}</div><div class="workflow-lower"><section class="panel workflow-panel"><div class="row between"><h3>Loop 运行链路</h3><span class="tag">修复上限 2 轮</span></div>${loopRibbon()}<div class="quality-metrics"><div><b>${workflow.tasks.length?state.done:0}/5</b>区域完成</div><div><b>${workflow.repairRound}/2</b>已用修复轮次</div><div><b>${workflow.rounds.at(-1)?.issues.length??'—'}</b>未解决问题</div><div><b>${workflow.snapshots.length}</b>截图记录</div></div><div class="handoff-row"><span class="tag">Memory</span><p>需求、Token、已成功区域与历史证据</p></div><div class="handoff-row"><span class="tag">Planning</span><p>共享计划、任务边界与依赖关系</p></div><div class="handoff-row"><span class="tag">Execution</span><p>限定 namespace / 单写者提交</p></div><div class="handoff-row"><span class="tag">Verification</span><p>截图 → 诊断 → Patch → 复审</p></div><div class="row" style="margin-top:17px"><button class="small" data-go="validation">视觉审查与修复证据 ↗</button><button class="small" data-demo="collaboration">加载协作阶段示例</button></div></section><section class="panel workflow-panel"><div class="row between"><h3>${esc(workflow.selectedAgent)} / 工具事件</h3><span class="tag">可展开输入 / 输出</span></div>${selected?`<div class="agent-inspect"><b>任务 ${selected.id}</b> · ${regions[agents.indexOf(selected.name)]}<br>读：共享 Token / 区域上下文<br>写：${selected.namespace} 内的候选节点<br>禁止：直接修改其他区域或正式文件</div>`:'<p class="muted" style="font-size:11px;margin-bottom:13px">协调者拥有规划、委派、组装和终止决策；视觉审核结果返回后只重新委派问题节点。</p>'}${eventDetails(workflow.selectedAgent==='Coordinator'?workflow.events:workflow.events.filter(e=>e.role===workflow.selectedAgent||e.input.owner===workflow.selectedAgent))}</section></div><p class="footer-note">模拟调度与固定问题集；没有实际启动 Agent 或调用视觉模型。阶段示例保留完整事件顺序。</p></div>`;
}
function workflowAgentPanel(){
  const active=state.running,round=workflow.repairRound;
  const events=workflow.selectedAgent==='Coordinator'?workflow.events:workflow.events.filter(e=>e.role===workflow.selectedAgent||e.input.owner===workflow.selectedAgent);
  return `<div class="row between"><b style="font-size:12px">多 Agent 设计助手</b><span class="tag ${active?'blue':workflow.stage==='needs_review'?'orange':''}">${phaseNames[workflow.stage]}</span></div><div class="coordinator-mini"><b>miaoma / Coordinator</b><p class="muted" style="font-size:10px">规划 · 委派 · 组装 · Loop 决策</p></div><div class="agent-mini-meta"><span>区域执行中 ${workflow.activeCount} / ${workflow.maxParallel}</span><span>总角色 1 + 5</span></div><div class="agent-selector"><button class="${workflow.selectedAgent==='Coordinator'?'active':''}" data-agent="Coordinator">总控</button>${agents.map((a,i)=>`<button class="${workflow.selectedAgent===a?'active':''}" data-agent="${a}"><i class="dot" style="color:${agentColors[i]}"></i> ${a}</button>`).join('')}</div><div class="mini-loop"><b>Loop · 修复 ${round} / 2</b><br>截图 → 视觉自审 → 定点修复 → 复审<br><span class="muted">${workflow.rounds.length?`已审查 ${workflow.rounds.length} 次 · 剩余 ${workflow.rounds.at(-1).issues.length} 项问题`:'开始运行后自动执行闭环'}</span></div><button class="small" data-go="orchestration" style="width:100%;margin-bottom:9px">打开协作控制台 ↗</button><div class="row between" style="margin:13px 0"><b style="font-size:11px">${esc(workflow.selectedAgent)} 事件</b><span class="muted" style="font-size:9px">Input / Output</span></div><div class="agent-feed">${eventDetails(events.slice(-7),true)}</div>${!events.length?'<div class="agent-message">本次修订增加了六个角色的委派关系、分区光标和逐轮工具日志。点击“模拟生成”可运行完整闭环。</div>':''}<button class="small" data-go="validation" style="width:100%;margin-top:10px">查看自审与修复证据 ↗</button>`;
}
function evidenceScene(after=false,blocked=false){return `<div class="evidence-scene ${after?'after':'before'} ${blocked?'blocked':''}"><span class="pill">青禾生活 / 品牌首屏</span><h3>把自然的松弛感，<br>带回每一天</h3><p class="node-outline ${after?'fixed':''}">从一抹新绿开始，让家与心都轻盈呼吸。</p><div class="box">把一小片自然，留在你的窗边。</div></div>`}
function reviewPage(){
  const report=workflow.rounds.find(r=>r.round===workflow.selectedRound)||workflow.rounds.at(-1);
  const round=report?.round??0,issues=report?.issues||[];
  const allPass=workflow.quality==='passed',needs=workflow.stage==='needs_review';
  const accepted=workflow.quality==='accepted_warnings';
  const active=state.running;
  return `<div class="workflow-page">${pageTitle('让视觉自审，形成真正的闭环。','每轮都记录截图、节点问题、修复 Patch 与复审结果；通过之后才完成。','<span class="tag blue">P11 / Visual Harness Loop</span>')}<div class="panel run-banner"><div class="row between"><div><b>${phaseNames[workflow.stage]}</b><span class="tag ${allPass?'green':needs?'orange':''}" style="margin-left:12px">${allPass?'复审通过':accepted?'人工接受警告':needs?'需要人工处理':report?'问题已定位':'等待自审'}</span><p class="workflow-live-note">${workflow.runId} · 修复 ${workflow.repairRound} / 2 · 当前文档 rev ${state.revision} · 选择的证据 rev ${report?.revision??'—'}</p></div><button class="small" data-go="orchestration">查看 Agent 委派 ↗</button></div></div>${runControls()}<div class="panel workflow-panel" style="margin-top:18px">${loopRibbon()}<div class="loop-status"><b>本次运行：${workflow.rounds.length} 次视觉审查 / ${workflow.repairRound} 轮修复</b><span class="muted">初检为 Round 0，修复轮次最多 2</span></div><div class="loop-history">${workflow.rounds.map(r=>`<button class="${workflow.selectedRound===r.round?'active':''}" data-round="${r.round}">${r.round===0?'初检':`第 ${r.round} 轮复审`} · ${r.issues.length} 问题 ${r.issues.length?'':'✓'}</button>`).join('')||'<button data-demo="review">加载首轮自审示例</button>'}</div><div class="snapshot-strip">${workflow.snapshots.map(s=>`<span>${s.id.split('_').slice(-2).join('_')} / rev ${s.revision} / 字体与资产 ready</span>`).join('')}</div></div><div class="workflow-lower"><section class="panel workflow-panel"><div class="row between"><h3>截图证据与问题定位</h3><span class="tag">${report?`Round ${round}`:'尚未截图'} · 示意画面</span></div><div class="evidence-grid"><div class="evidence-card"><header><b>修复前 / 初检</b><span class="mono">rev ${workflow.rounds[0]?.revision??'—'}</span></header>${evidenceScene(false)}<footer>shot · Round 0 / hero.subtitle + story.title</footer></div><div class="evidence-card"><header><b>${round?'当前轮修复后':'修复目标预览'}</b><span class="mono">rev ${report?.revision??'—'}</span></header>${evidenceScene(round>0,issues.some(i=>i.id==='VI-02'))}<footer>${round?'新截图复审证据（模拟）':'初检问题尚未应用修复'}</footer></div></div><div class="review-issues">${report?issues.length?issues.map(i=>`<article class="review-issue"><div class="row between"><b style="font-size:12px">${i.id} · ${i.title}</b><span class="tag ${i.severity==='blocker'?'orange':''}">${i.severity}</span></div><p class="mono">${i.nodeId} → ${i.owner} / ${i.category}</p><p>${i.evidence}</p><div class="review-actions"><button class="small" data-locate="${i.node}">定位画布节点 ↗</button><button class="small" data-owner="${i.owner}">查看执行者</button></div></article>`).join(''):'<div class="callout">✓ 本轮 7 个视觉维度及结构检查全部通过。保留前轮证据，不覆盖历史报告。</div>':'<div class="callout">先运行 Loop 或加载初检示例。这里将出现模型诊断对应的 nodeId、执行者和证据。</div>'}</div><div class="score-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:0">${['结构校验','布局对齐','层级关系','文本可读','色彩对比','组件完整','变量一致','边界溢出'].map(n=>`<div class="score-item"><span class="muted" style="font-size:10px">${n}</span><b style="font-size:12px;color:${report&&issues.some(i=>i.category===n)?'#b17a37':'#348366'}">${report?issues.some(i=>i.category===n)?'待修复':'✓ 通过':'未检查'}</b></div>`).join('')}</div></section><aside class="stack"><section class="panel workflow-panel"><div class="row between"><h3>节点修复 Patch</h3><span class="tag">最小改动</span></div><p class="muted" style="font-size:11px">第 1 轮 → Newton / Maxwell；第 2 轮 → Tesla。正式产品使用 revision + 目标 hash 防止覆盖人工修改。</p><div class="patch-box"><span class="minus">− hero.subtitle.color: #A3B9A5</span>
<span class="plus">+ hero.subtitle.color: #536D58</span>
<span class="minus">− story.title.height: 28</span>
<span class="plus">+ story.title.height: auto</span>
<span class="plus">+ story.title.lineHeight: 1.55</span>

第 2 轮：
<span class="plus">+ features.cards.gap: spacing.3 (12)</span></div><ul class="proof-list"><li>✓ 只修改诊断指向的节点与属性</li><li>✓ 其余区域保持不变</li><li>✓ 每轮重新截图并再次审查</li><li>✓ blocker 未解决时禁止交付</li></ul><div class="round-summary"><span class="tag">${workflow.snapshots.length} 截图</span><span class="tag">${workflow.events.filter(e=>e.tool==='propose_patch').length} Patch 候选</span><span class="tag">${workflow.patchApplied} 已应用轮次</span></div></section><section class="panel workflow-panel"><h3>循环控制与停止条件</h3><p class="muted" style="font-size:11px">通过 → completed<br>仍有问题且轮次 &lt; 2 → 重派修复<br>两次耗尽 → needs_review<br>人工修改冲突 → 保留当前，等待确认<br>取消 → 停止派发与晚到提交</p>${needs?`<div class="workflow-gate">${workflow.quality==='conflict'?'检测到人工修改，候选未覆盖当前文档。':workflow.quality==='blocked'?'阻断问题未解决；不能通过人工接受直接交付。':'修复两轮后仍有警告；可以人工处理或记录接受理由。'}</div>`:''}<div class="review-actions" style="margin-top:15px"><button class="small" data-demo="review">首轮审查示例</button><button class="small" data-demo="repair">修复委派示例</button><button class="small" data-demo="done">查看两轮完成示例</button></div>${needs&&workflow.quality==='warnings'?'<button class="small" id="workflow-accept" style="margin-top:12px">接受剩余警告并记录理由</button>':''}${allPass||accepted?'<button class="primary small" data-go="code" style="margin-top:12px">继续设计交付 →</button>':''}</section><section class="panel workflow-panel"><h3>审查 / 修复工具日志</h3>${eventDetails(workflow.events.filter(e=>['capture_screenshot','visual_check','repair','apply_patch','patch_conflict'].includes(e.tool)).slice(-5))}</section></aside></div><p class="footer-note">证据为本地固定模板模拟；真实截图服务与多模态模型未接入。所有阶段、轮次、问题与 Patch 来自同一个模拟 Run。</p></div>`;
}

const originalNav=nav,originalEditor=editor,originalBind=bind,originalRender=render;
titles.orchestration='多 Agent 协作';titles.validation='视觉自审与 Loop 修复';
nav=function(){return originalNav().replace('</nav></div><div class="sidebar-foot">',`<button data-go="orchestration" class="${state.page==='orchestration'?'active':''}"><span class="ico">⌘</span>多 Agent 协作</button></nav></div><div class="sidebar-foot">`)};
editor=function(){return originalEditor().replace('<button class="small" id="undo"','<button class="small" data-go="orchestration">⌘ 协作与 Loop</button><button class="small" id="undo"')};
agentPanel=workflowAgentPanel;
validation=reviewPage;
startRun=function(done=0){startWorkflow('auto',done,'editor')};
stopRun=function(){
  if(!state.running)return;clearInterval(workflowTimer);workflowTimer=null;
  workflow.cancelledTaskStatuses=workflow.tasks.map(t=>t.status);
  workflow.tasks.forEach(t=>{if(t.status==='running'||t.status==='repairing')t.status='cancelled'});workflow.activeCount=0;
  emitWorkflow('Coordinator','cancel_run',{attemptId:workflow.attempt},{fence:'closed',keepCommittedRegions:true,checkpoint:workflow.stepIndex},'停止派发并保留检查点');finishWorkflow('cancelled');render();toast('已取消 Loop，未完成候选不会继续提交');
};
function applyWorkflowDecorations(){
  const art=$('.canvas-stage .artboard');if(art){art.classList.toggle('agent-canvas-fix',workflow.patchApplied>0);art.classList.toggle('agent-canvas-draft',workflow.rounds.length>0&&workflow.patchApplied===0);
    if(state.running)workflow.tasks.filter(t=>t.status==='running'||t.status==='repairing').forEach(t=>{const i=agents.indexOf(t.name);const target=art.querySelector(`[data-node="${t.node}"]`)||art.querySelectorAll('.empty-region')[Math.min(i,art.querySelectorAll('.empty-region').length-1)];if(target){target.style.position='relative';const tag=document.createElement('span');tag.className='agent-region-marker';tag.style.setProperty('--agent',agentColors[i]);tag.textContent=t.name+(t.status==='repairing'?' · 修复中':' · 生成中');target.appendChild(tag)}});
  }
  if($('#run-button'))$('#run-button').textContent=state.running?'■ 取消':'↑ 模拟生成与 Loop';
}
bind=function(){
  originalBind();
  document.querySelectorAll('[data-agent]').forEach(e=>e.onclick=()=>{workflow.selectedAgent=e.dataset.agent;render()});
  document.querySelectorAll('[data-owner]').forEach(e=>e.onclick=()=>{workflow.selectedAgent=e.dataset.owner;go('orchestration')});
  document.querySelectorAll('[data-round]').forEach(e=>e.onclick=()=>{workflow.selectedRound=Number(e.dataset.round);render()});
  document.querySelectorAll('[data-demo]').forEach(e=>e.onclick=()=>seedWorkflow(e.dataset.demo));
  if($('#workflow-parallel'))$('#workflow-parallel').onchange=e=>{workflow.maxParallel=Number(e.target.value)};
  if($('#workflow-scenario'))$('#workflow-scenario').onchange=e=>{workflow.scenario=e.target.value};
  if($('#workflow-auto'))$('#workflow-auto').onclick=()=>startWorkflow('auto',0,state.page);
  if($('#workflow-manual'))$('#workflow-manual').onclick=()=>startWorkflow('manual',0,state.page);
  if($('#workflow-next'))$('#workflow-next').onclick=advanceWorkflow;
  if($('#workflow-cancel'))$('#workflow-cancel').onclick=stopRun;
  if($('#workflow-resume'))$('#workflow-resume').onclick=()=>{
    workflow.attempt++;workflow.tasks.forEach((t,i)=>{if(t.status==='cancelled')t.status=workflow.cancelledTaskStatuses?.[i]||'pending'});
    workflow.activeCount=workflow.tasks.filter(t=>t.status==='running').length;state.running=true;state.cancelled=false;
    workflow.stage=workflow.steps[workflow.stepIndex]?.stage||'queued';state.phase=workflow.stage;
    emitWorkflow('Coordinator','resume_checkpoint',{checkpoint:workflow.stepIndex,attemptId:workflow.attempt},{resumeAt:workflow.stepIndex+1,latePreviousResultsRejected:true},'按检查点继续（原型模拟）');render();
  };
  if($('#workflow-accept'))$('#workflow-accept').onclick=()=>{
    modal('人工接受剩余警告','<label for="accept-reason">请填写接受理由（原型仅在内存记录）</label><textarea id="accept-reason" style="width:100%;margin-top:10px;height:70px" placeholder="说明为什么不影响本次交付"></textarea>',()=>{const reason=$('#accept-reason').value.trim();if(!reason){toast('未填写理由，未接受警告');return}workflow.accepted=true;workflow.quality='accepted_warnings';finishWorkflow('completed');emitWorkflow('Human','accept_warnings',{reason},{accepted:true,notModelPass:true},'人工接受，保留警告报告');render()},'记录接受理由');
  };
  if($('#resume-run'))$('#resume-run').onclick=()=>startWorkflow('manual',3,'orchestration');
};
render=function(){if(state.page==='orchestration'){$('#app').innerHTML=shell(collaborationPage());bind()}else originalRender();applyWorkflowDecorations()};
render();
