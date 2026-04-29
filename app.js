/* ══════════════════════════════════════════════════════════════
   SISTEMA CLÍNICA MÉDICA – HOSPITAL DOS PESCADORES
   Chaves no Firestore (prefixo cm_):
     cm_leitos                       → estado dos 34 leitos
     cm_ev_<leito>_<turno>_<data>    → evolução
     cm_admissao_log                 → log de admissões
     cm_alta_log                     → log de altas
   Coleção: 'uti' (compartilhada com UTI; isolamento via prefixo cm_)
   ══════════════════════════════════════════════════════════════ */

// ── FIREBASE ─────────────────────────────────────────────────────────────────
let app, db, auth;
let modoOffline = false;
try {
  app = firebase.initializeApp(FIREBASE_CONFIG);
  db  = firebase.firestore();
  auth = firebase.auth();
} catch(e) {
  console.error('Firebase falhou:', e);
  modoOffline = true;
}

// ── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let turno = '', leitoAtual = 0, usuarioEmail = '';
let leitoParaAlta = 0;
let modoEdicaoAdm = false;
let alaAtual = 'todos'; // 'terreo' | 'primeiro' | 'todos'

// Cache em memória da sessão
const memCache = {};
function memSet(k, v){ memCache[k] = v; }
function memGet(k){ return k in memCache ? memCache[k] : undefined; }
function memDel(k){ delete memCache[k]; }

// ── UTILITÁRIOS ──────────────────────────────────────────────────────────────
function pad(n){ return String(n).padStart(2,'0'); }
function hoje(){
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}
function fmtD(s){
  if (!s) return '';
  const [y,m,d] = s.split('-');
  return `${d}/${m}/${y}`;
}
function calcIdade(dn){
  if (!dn) return '';
  const [y,m,d] = dn.split('-').map(Number);
  if (!y) return '';
  const hojeD = new Date();
  let idade = hojeD.getFullYear() - y;
  const mAtual = hojeD.getMonth() + 1;
  if (mAtual < m || (mAtual === m && hojeD.getDate() < d)) idade--;
  return idade > 0 ? idade + ' anos' : '';
}
function gf(id){ const el = document.getElementById(id); return el ? el.value : ''; }
function setF(id, v){
  const el = document.getElementById(id);
  if (el) el.value = v == null ? '' : v;
}
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function toast(msg, erro=false){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (erro ? ' erro' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}
function showLoading(msg='Carregando...'){
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading-overlay').classList.add('show');
}
function hideLoading(){
  document.getElementById('loading-overlay').classList.remove('show');
}

// ── DB (formato: {value, updatedAt}) ─────────────────────────────────────────
async function dbGet(key){
  const mem = memGet(key);
  if (mem !== undefined) return mem;
  const cached = localStorage.getItem(key);
  const cachedVal = cached ? (() => { try { return JSON.parse(cached); } catch(e){ return undefined; } })() : undefined;
  if (!modoOffline && db) {
    const fsPromise = db.collection('uti').doc(key).get().then(doc => {
      if (doc.exists) {
        const data = doc.data();
        const valor = data.value !== undefined ? data.value : data.v;
        if (valor !== undefined) {
          localStorage.setItem(key, JSON.stringify(valor));
          memSet(key, valor);
          return valor;
        }
      }
      return cachedVal ?? null;
    }).catch(e => { console.warn('dbGet:', e); return cachedVal ?? null; });
    if (cachedVal !== undefined) { fsPromise; return cachedVal; }
    const val = await fsPromise;
    memSet(key, val);
    return val;
  }
  if (cachedVal !== undefined) { memSet(key, cachedVal); return cachedVal; }
  return null;
}

async function dbSet(key, value){
  memSet(key, value);
  localStorage.setItem(key, JSON.stringify(value));
  if (!modoOffline && db) {
    try {
      await db.collection('uti').doc(key).set({
        value,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch(e) { console.warn('dbSet:', e); }
  }
}

async function dbDelete(key){
  memDel(key);
  localStorage.removeItem(key);
  if (!modoOffline && db) {
    try { await db.collection('uti').doc(key).delete(); }
    catch(e){ console.warn('dbDelete:', e); }
  }
}

async function dbGetMany(keys){
  if (!keys.length) return {};
  const result = {};
  const toFetch = [];
  for (const key of keys) {
    const mem = memGet(key);
    if (mem !== undefined) { result[key] = mem; continue; }
    const cached = localStorage.getItem(key);
    if (cached) {
      try { result[key] = JSON.parse(cached); continue; } catch(e){}
    }
    toFetch.push(key);
  }
  if (toFetch.length && !modoOffline && db) {
    await Promise.all(toFetch.map(async key => {
      try {
        const doc = await db.collection('uti').doc(key).get();
        if (doc.exists) {
          const data = doc.data();
          const valor = data.value !== undefined ? data.value : data.v;
          if (valor !== undefined) {
            localStorage.setItem(key, JSON.stringify(valor));
            memSet(key, valor);
            result[key] = valor;
            return;
          }
        }
        result[key] = null;
      } catch(e) {
        console.warn('dbGetMany:', key, e);
        result[key] = null;
      }
    }));
  }
  for (const key of keys) { if (!(key in result)) result[key] = null; }
  return result;
}

// ── CHAVES ───────────────────────────────────────────────────────────────────
function evKey(leito, turno, data){
  return `cm_ev_${leito}_${turno}_${data}`;
}

// ── DADOS DOS LEITOS ─────────────────────────────────────────────────────────
async function leitosData(){
  let d = await dbGet('cm_leitos');
  if (!d) {
    d = {};
    for (let i = 1; i <= TOTAL_LEITOS; i++) {
      d[i] = { ocupado:false, pac:'', diag:'', dn:'', adm:'', admHosp:'', comor:'', alergia:'' };
    }
    await dbSet('cm_leitos', d);
  }
  return d;
}

// ── NAVEGAÇÃO ────────────────────────────────────────────────────────────────
const TELAS_SIMPLES = ['t-login','t-turno','t-ala'];
function mostrarTela(id){
  document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa'));
  TELAS_SIMPLES.forEach(tid => {
    const el = document.getElementById(tid);
    if (el) el.style.display = 'none';
  });
  const el = document.getElementById(id);
  if (!el) return;
  if (TELAS_SIMPLES.includes(id)) el.style.display = 'flex';
  else el.classList.add('ativa');
}

function irTelaTurno(){
  mostrarTela('t-turno');
  const dot = document.getElementById('sync-dot');
  const txt = document.getElementById('sync-txt');
  if (modoOffline) { dot.className='sync-dot err'; txt.textContent='modo offline – dados locais'; }
  else             { dot.className='sync-dot ok';  txt.textContent='conectado ao Firebase'; }
}
function irTurno(){ irTelaTurno(); }
function irAla(){
  mostrarTela('t-ala');
  const sub = document.getElementById('ala-sub');
  if (sub) sub.textContent = `Turno ${turno === 'DIURNO' ? 'Diurno ☀' : 'Noturno 🌙'} — Selecione a ala`;
}
function irLeitos(){ mostrarTela('t-leitos'); renderLeitos(); window.scrollTo(0,0); }
function escolherAla(ala){
  alaAtual = ala;
  irLeitos();
}
function irForm(){ mostrarTela('t-form'); window.scrollTo(0,0); }

// ── AUTENTICAÇÃO ─────────────────────────────────────────────────────────────
async function fazerLogin(){
  const email = gf('li-email').trim();
  const senha = gf('li-senha');
  const errEl = document.getElementById('login-err');
  const btn = document.getElementById('btn-entrar');
  errEl.textContent = '';
  if (!email || !senha) { errEl.textContent = 'Preencha e-mail e senha.'; return; }
  btn.disabled = true; btn.textContent = 'Entrando...';
  try {
    await auth.signInWithEmailAndPassword(email, senha);
  } catch(e) {
    const msgs = {
      'auth/user-not-found':'Usuário não encontrado.',
      'auth/wrong-password':'Senha incorreta.',
      'auth/invalid-email':'E-mail inválido.',
      'auth/too-many-requests':'Muitas tentativas. Tente mais tarde.',
    };
    errEl.textContent = msgs[e.code] || 'Erro ao entrar.';
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}

function fazerLogout(){
  if (!confirm('Sair do sistema?')) return;
  if (auth) auth.signOut();
  else irTelaTurno();
}

// ── TURNO ────────────────────────────────────────────────────────────────────
async function escolherTurno(t){
  turno = t;
  // Atualiza badge para quando chegar nos leitos
  const setarBadge = () => {
    const b = document.getElementById('badge-leitos');
    if (b) { b.textContent = t==='DIURNO'?'☀ DIURNO':'☽ NOTURNO'; b.className='badge '+(t==='DIURNO'?'badge-d':'badge-n'); }
    const bu = document.getElementById('badge-user');
    if (bu) bu.textContent = usuarioEmail ? '👤 '+usuarioEmail.split('@')[0]+' · Sair' : 'Sair';
  };
  setarBadge();
  irAla(); // vai para seleção de ala antes dos leitos
}

// ══════════════════════════════════════════════════════════════════════════════
// RENDER LEITOS — agrupados por enfermaria
// ══════════════════════════════════════════════════════════════════════════════
async function renderLeitos(){
  const wrap = document.getElementById('enfermarias-wrap');
  wrap.innerHTML = '';
  const d = await leitosData();
  const hj = hoje();

  // Filtra enfermarias pela ala selecionada
  const enfsVisiveis = alaAtual === 'todos'
    ? ENFERMARIAS
    : ENFERMARIAS.filter(e => e.ala === alaAtual);

  // Atualiza subtítulo
  const sub = document.getElementById('leitos-sub');
  if (sub) {
    const nomeAla = alaAtual === 'terreo' ? 'CM Térreo (Enf. 01–08)' : alaAtual === 'primeiro' ? 'CM 1º Andar (Enf. 09–11)' : 'Todas as enfermarias';
    sub.textContent = `${turno==='DIURNO'?'☀ Diurno':'☽ Noturno'} · ${nomeAla}`;
  }

  const leitos = enfsVisiveis.flatMap(e => e.leitos);
  const chaves = leitos
    .filter(num => d[num]?.ocupado)
    .map(num => evKey(num, turno, hj));

  const evs = await dbGetMany(chaves);

  for (const enf of enfsVisiveis) {
    const secao = document.createElement('div');
    secao.className = 'enfermaria' + (enf.psico ? ' psico' : '');
    const psicoTag = enf.psico ? '<span class="tag-psico">PSICO</span>' : '';
    secao.innerHTML = `
      <div class="enfermaria-t">
        <div><span class="nome">${esc(enf.nome)}</span>${psicoTag}</div>
        <span class="andar">${esc(enf.andar)}</span>
      </div>
      <div class="leitos-grid" id="grid-enf-${enf.id}"></div>
    `;
    wrap.appendChild(secao);

    const grid = document.getElementById('grid-enf-' + enf.id);
    for (const num of enf.leitos) {
      const l = d[num] || { ocupado:false };
      const ev = l.ocupado ? (evs[evKey(num, turno, hj)] || null) : null;

      const card = document.createElement('div');
      card.className = 'leito-card' + (l.ocupado ? ' ocupado' : '') + (enf.psico ? ' psico' : '');
      card.onclick = () => abrirLeito(num);

      let badges = '';
      if (l.ocupado) {
        badges += `<span class="lb lb-cloud">${enf.psico ? '🧠' : '🩺'} Enf</span>`;
        if (ev) {
          badges += '<span class="lb lb-ok">✓ Evolução</span>';
          if (ev.bradClass)  badges += `<span class="lb lb-braden-${ev.bradClass}">Braden ${ev.bradTotal||''} ${ev.bradLabel||''}</span>`;
          if (ev.morseClass) badges += `<span class="lb lb-morse-${ev.morseClass}">Morse ${ev.morseTotal||''} ${ev.morseLabel||''}</span>`;
          if (ev.fugClass)   badges += `<span class="lb lb-fug-${ev.fugClass}">Fug ${ev.fugTotal||''} ${ev.fugLabel||''}</span>`;
        }
      }

      card.innerHTML = `
        <div class="leito-num">LEITO ${pad(num)}</div>
        <div class="leito-info">${l.ocupado
          ? `<div class="leito-pac">${esc(l.pac||'–')}</div><div class="leito-diag">${esc(l.diag||'')}</div>`
          : `<div class="leito-vazio">Vago</div>`}
        </div>
        <div class="leito-badge-row">${badges}</div>
      `;
      grid.appendChild(card);
    }
  }
}

// ── ABRIR LEITO — clique direto: vago→admissão, ocupado→formulário ───────────
async function abrirLeito(num){
  leitoAtual = num;
  const d = await leitosData();
  const l = d[num];
  if (l && l.ocupado) {
    abrirForm(num);
  } else {
    modoEdicaoAdm = false;
    abrirModalAdm(num, true);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FORMULÁRIO DE EVOLUÇÃO — CATÁLOGOS
// ══════════════════════════════════════════════════════════════════════════════

const CHK_PELE = [
  'Normocorado','Hipocorado','Acianótico','Cianótico','Ictérico','Anictérico','Íntegra','Não íntegra'
];
const CHK_NEURO = [
  'Consciente','Orientado','Desorientado','Sonolento','Comatoso'
];
const CHK_PUPILAS = [
  'Isocóricas','Anisocóricas','Midriáticas','Mióticas','Fixas','Fotorreagentes'
];
const CHK_TORAX = ['Tórax simétrico','Tórax assimétrico'];
const CHK_AP = ['MV+','Roncos','Sibilos','Creptos/Estertor'];
const CHK_CV = [
  'Perfusão inalterada','Perfusão lentificada','Edema',
  'Normocárdico','Taquicárdico','Bradicárdico',
  'Ausculta em 2T','Bulhas acessórias','Sopros'
];
const CHK_ABD = [
  'Plano','Globoso','Escavado','Flácido','Rígido','Distendido','Ascítico','Timpânico',
  'Dor','RHA+','RHA ausente'
];
const CHK_DIURESE = [
  'Presente','Ausente','Fralda','Disp. não invasivo (Jontex)','Aparadeira/Papagaio',
  'Nefrostomia D','Nefrostomia E','Clara','Concentrada','Colúria','Hematúria'
];
const CHK_INTEST = [
  'Presente','Ausente','Espontânea','Colostomia','Ileostomia',
  'Líquidas','Pastosas','Endurecidas','Melena','Hematoquezia','Acolia'
];

const MEDIDAS_PREV = [
  { id:'mp-tev',     q:'Necessita de profilaxia para TEV?' },
  { id:'mp-grades',  q:'Grades do leito elevadas?' },
  { id:'mp-cont',    q:'Necessita de contenção mecânica?' },
  { id:'mp-cont-tr', q:'Trocada contenção hoje?' },
  { id:'mp-cont-ok', q:'Contenção sem apertar/garrotear?' },
  { id:'mp-colch',   q:'Uso de colchão de ar?' },
  { id:'mp-cab',     q:'Cabeceira elevada a 30º?' },
  { id:'mp-higi',    q:'Higiene oral adequada?' }
];

const BRADEN_ITENS = [
  { id:'b1', label:'Percepção sensorial', ops:[
    {pt:1, tx:'Totalmente limitado'},{pt:2, tx:'Muito limitado'},
    {pt:3, tx:'Levemente limitado'},{pt:4, tx:'Nenhuma limitação'}
  ]},
  { id:'b2', label:'Umidade', ops:[
    {pt:1, tx:'Excessiva'},{pt:2, tx:'Muita'},
    {pt:3, tx:'Ocasional'},{pt:4, tx:'Rara'}
  ]},
  { id:'b3', label:'Atividade', ops:[
    {pt:1, tx:'Acamado'},{pt:2, tx:'Confinado a cadeira'},
    {pt:3, tx:'Deambula ocasionalmente'},{pt:4, tx:'Deambula frequentemente'}
  ]},
  { id:'b4', label:'Mobilidade', ops:[
    {pt:1, tx:'Imóvel'},{pt:2, tx:'Muito limitado'},
    {pt:3, tx:'Discreta limitação'},{pt:4, tx:'Sem limitação'}
  ]},
  { id:'b5', label:'Nutrição', ops:[
    {pt:1, tx:'Deficiente'},{pt:2, tx:'Inadequada'},
    {pt:3, tx:'Adequada'},{pt:4, tx:'Excelente'}
  ]},
  { id:'b6', label:'Fricção e cisalhamento', ops:[
    {pt:1, tx:'Problema'},{pt:2, tx:'Problema potencial'},{pt:3, tx:'Sem problema'}
  ]}
];

const MORSE_ITENS = [
  { id:'m1', label:'Histórico de quedas', ops:[
    {pt:0, tx:'Não'},{pt:25, tx:'Sim'}
  ]},
  { id:'m2', label:'Diagnóstico secundário', ops:[
    {pt:0, tx:'Não'},{pt:15, tx:'Sim'}
  ]},
  { id:'m3', label:'Auxílio na deambulação', ops:[
    {pt:0, tx:'Nenhum/Acamado'},{pt:15, tx:'Muletas/Bengala/Andador'},{pt:30, tx:'Mobiliário/Parede'}
  ]},
  { id:'m4', label:'Terapia endovenosa', ops:[
    {pt:0, tx:'Não'},{pt:20, tx:'Sim'}
  ]},
  { id:'m5', label:'Marcha', ops:[
    {pt:0, tx:'Normal/Acamado'},{pt:10, tx:'Fraca'},{pt:20, tx:'Comprometida'}
  ]},
  { id:'m6', label:'Estado mental', ops:[
    {pt:0, tx:'Orientado'},{pt:15, tx:'Superestima/Esquece limitações'}
  ]}
];

const FUGULIN_ITENS = [
  { id:'f1', label:'Estado mental', ops:[
    {pt:1, tx:'Orientado'},{pt:2, tx:'Períodos intermitentes de desorientação'},
    {pt:3, tx:'Períodos de inconsciência'},{pt:4, tx:'Inconsciente'}
  ]},
  { id:'f2', label:'Oxigenação', ops:[
    {pt:1, tx:'Não depende de oxigênio'},{pt:2, tx:'Cateter/Máscara intermitente'},
    {pt:3, tx:'Cateter/Máscara contínuo'},{pt:4, tx:'VM ou VNI'}
  ]},
  { id:'f3', label:'Sinais vitais', ops:[
    {pt:1, tx:'Controle de rotina (8/8h)'},{pt:2, tx:'Controle 6/6h'},
    {pt:3, tx:'Controle 4/4h'},{pt:4, tx:'Controle de 2/2h ou mais frequente'}
  ]},
  { id:'f4', label:'Motilidade', ops:[
    {pt:1, tx:'Movimenta todos os segmentos'},{pt:2, tx:'Limitação de movimentos'},
    {pt:3, tx:'Dificuldade para movimentar segmentos'},{pt:4, tx:'Incapaz de movimentar-se'}
  ]},
  { id:'f5', label:'Deambulação', ops:[
    {pt:1, tx:'Ambulante'},{pt:2, tx:'Auxílio para deambular'},
    {pt:3, tx:'Senta com auxílio'},{pt:4, tx:'Restrito ao leito'}
  ]},
  { id:'f6', label:'Alimentação', ops:[
    {pt:1, tx:'Auto-suficiente'},{pt:2, tx:'Necessita de auxílio'},
    {pt:3, tx:'SNG/SNE'},{pt:4, tx:'NPT/Cateter central'}
  ]},
  { id:'f7', label:'Cuidado corporal', ops:[
    {pt:1, tx:'Auto-suficiente'},{pt:2, tx:'Auxílio no banho/higiene'},
    {pt:3, tx:'Banho no leito com auxílio'},{pt:4, tx:'Banho no leito totalmente dependente'}
  ]},
  { id:'f8', label:'Eliminação', ops:[
    {pt:1, tx:'Auto-suficiente'},{pt:2, tx:'Uso de comadre/papagaio com auxílio'},
    {pt:3, tx:'Uso de fralda/SVD'},{pt:4, tx:'Evacuação no leito/Incontinência'}
  ]},
  { id:'f9', label:'Terapêutica', ops:[
    {pt:1, tx:'VO ou IM'},{pt:2, tx:'EV intermitente'},
    {pt:3, tx:'EV contínua'},{pt:4, tx:'EV contínua com drogas vasoativas'}
  ]},
  { id:'f10', label:'Comprometimento tecidual', ops:[
    {pt:1, tx:'Pele íntegra'},{pt:2, tx:'Alteração na pele/mucosa'},
    {pt:3, tx:'Solução de continuidade'},{pt:4, tx:'Lesão extensa/múltiplas lesões'}
  ]},
  { id:'f11', label:'Curativo', ops:[
    {pt:1, tx:'Sem curativo'},{pt:2, tx:'1 curativo simples'},
    {pt:3, tx:'2 ou mais curativos simples'},{pt:4, tx:'Curativo complexo/extenso'}
  ]},
  { id:'f12', label:'Tempo de curativos', ops:[
    {pt:1, tx:'Sem curativo'},{pt:2, tx:'< 15 min'},
    {pt:3, tx:'15–30 min'},{pt:4, tx:'> 30 min'}
  ]}
];

// ── BUILDERS ────────────────────────────────────────────────────────────────
function _montarCheckboxes(){
  const m = (id, arr, prefix) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.montado) return;
    el.innerHTML = arr.map(item => {
      const key = prefix + '-' + item.replace(/[^a-zA-Z0-9]/g, '_');
      return `<label class="ci"><input type="checkbox" id="${key}"> ${item}</label>`;
    }).join('');
    el.dataset.montado = '1';
  };
  m('chk-pele',    CHK_PELE,    'pele');
  m('chk-neuro',   CHK_NEURO,   'neuro');
  m('chk-pupilas', CHK_PUPILAS, 'pup');
  m('chk-torax',   CHK_TORAX,   'tor');
  m('chk-ap',      CHK_AP,      'ap');
  m('chk-cv',      CHK_CV,      'cv');
  m('chk-abd',     CHK_ABD,     'abd');
  m('chk-diurese', CHK_DIURESE, 'diu');
  m('chk-intest',  CHK_INTEST,  'int');
}

function _montarMedidasPrev(){
  const cont = document.getElementById('medidas-prev');
  if (!cont || cont.dataset.montado) return;
  cont.innerHTML = MEDIDAS_PREV.map(m => `
    <div class="medida-row">
      <span class="q">${esc(m.q)}</span>
      <div class="opts">
        <label><input type="radio" name="${m.id}" value="Sim"> Sim</label>
        <label><input type="radio" name="${m.id}" value="Não"> Não</label>
        <label><input type="radio" name="${m.id}" value="NA"> N/A</label>
      </div>
    </div>`).join('');
  cont.dataset.montado = '1';
}

function _montarEscalas(){
  _montarEscala('braden-itens',  BRADEN_ITENS,  'brad');
  _montarEscala('morse-itens',   MORSE_ITENS,   'morse');
  _montarEscala('fugulin-itens', FUGULIN_ITENS, 'fug');
}

function _montarEscala(containerId, itens, prefix){
  const cont = document.getElementById(containerId);
  if (!cont || cont.dataset.montado) return;
  cont.innerHTML = itens.map(item => `
    <div class="escala-item">
      <div class="escala-item-t">${esc(item.label)}<span class="vlr" id="${prefix}-v-${item.id}">–</span></div>
      <div class="escala-item-c">
        ${item.ops.map(op => `
          <label class="escala-op">
            <input type="radio" name="${prefix}-${item.id}" value="${op.pt}" data-pt="${op.pt}" onchange="_atualizarTotaisEscalas()">
            <span class="pt">${op.pt}</span>
            <span class="tx">${esc(op.tx)}</span>
          </label>`).join('')}
      </div>
    </div>
  `).join('');
  cont.dataset.montado = '1';
}

// ── ATUALIZAÇÃO DE TOTAIS ───────────────────────────────────────────────────
function _atualizarTotaisEscalas(){
  const brad = _totalEscala(BRADEN_ITENS, 'brad');
  let bLabel = 'Não avaliado';
  if (brad.total > 0 && brad.respondidos === BRADEN_ITENS.length) {
    if (brad.total <= 11)       bLabel = 'Risco ALTO';
    else if (brad.total <= 14)  bLabel = 'Risco moderado';
    else if (brad.total <= 16)  bLabel = 'Risco baixo';
    else                         bLabel = 'Sem risco';
  }
  document.getElementById('brad-total').textContent = brad.total > 0 ? brad.total : '–';
  document.getElementById('brad-label').textContent = bLabel;

  const morse = _totalEscala(MORSE_ITENS, 'morse');
  let mLabel = 'Não avaliado';
  if (morse.respondidos === MORSE_ITENS.length) {
    if (morse.total >= 45)      mLabel = 'Risco ALTO';
    else if (morse.total >= 25) mLabel = 'Risco moderado';
    else                         mLabel = 'Risco baixo';
  }
  document.getElementById('morse-total').textContent = morse.respondidos === MORSE_ITENS.length ? morse.total : '–';
  document.getElementById('morse-label').textContent = mLabel;

  const fug = _totalEscala(FUGULIN_ITENS, 'fug');
  let fLabel = 'Não avaliado';
  if (fug.respondidos === FUGULIN_ITENS.length) {
    if (fug.total > 34)         fLabel = 'Intensivo';
    else if (fug.total >= 29)   fLabel = 'Semi-intensivo';
    else if (fug.total >= 23)   fLabel = 'Alta dependência';
    else if (fug.total >= 18)   fLabel = 'Intermediário';
    else                         fLabel = 'Cuidado mínimo';
  }
  document.getElementById('fug-total').textContent = fug.respondidos === FUGULIN_ITENS.length ? fug.total : '–';
  document.getElementById('fug-label').textContent = fLabel;

  document.querySelectorAll('.escala-op').forEach(l => {
    l.classList.toggle('sel', l.querySelector('input').checked);
  });
}

function _totalEscala(itens, prefix){
  let total = 0, respondidos = 0;
  for (const item of itens) {
    const r = document.querySelector(`input[name="${prefix}-${item.id}"]:checked`);
    const vlr = document.getElementById(`${prefix}-v-${item.id}`);
    if (r) {
      const pt = parseInt(r.value);
      total += pt; respondidos++;
      if (vlr) vlr.textContent = pt;
    } else {
      if (vlr) vlr.textContent = '–';
    }
  }
  return { total, respondidos };
}

// ── ATB ─────────────────────────────────────────────────────────────────────
function addAtb(nome='', d0=''){
  const cont = document.getElementById('f-atb-list');
  const uid = 'atb-' + Date.now() + Math.random().toString(36).slice(2,6);
  const row = document.createElement('div');
  row.className = 'atb-row';
  row.innerHTML = `
    <input type="text" placeholder="Nome do antimicrobiano" value="${esc(nome)}" style="flex:2;min-width:120px;">
    <div style="display:flex;flex-direction:column;gap:2px;flex-shrink:0;">
      <span style="font-size:.6rem;font-weight:700;color:var(--muted);text-transform:uppercase;">D0 (início)</span>
      <input type="date" class="atb-d0" id="${uid}" value="${d0||''}" style="min-width:130px;" onchange="calcDiaAtb(this)">
    </div>
    <div style="display:flex;flex-direction:column;gap:2px;align-items:center;flex-shrink:0;">
      <span style="font-size:.6rem;font-weight:700;color:var(--muted);text-transform:uppercase;">Dia atual</span>
      <span class="atb-dia-atual" style="font-size:.85rem;font-weight:800;color:var(--verde);min-width:36px;text-align:center;">–</span>
    </div>
    <button class="rm" onclick="this.parentElement.remove()" title="Remover">×</button>
  `;
  cont.appendChild(row);
  _ativarCaixaAltaEm(row);
  // Calcula dia imediatamente se já tem data
  const dateInput = document.getElementById(uid);
  if (dateInput && d0) calcDiaAtb(dateInput);
}

function calcDiaAtb(input){
  const d0 = input.value;
  const span = input.closest('.atb-row')?.querySelector('.atb-dia-atual');
  if (!span) return;
  if (!d0) { span.textContent = '–'; return; }
  const inicio = new Date(d0 + 'T00:00:00');
  const agora  = new Date(hoje() + 'T00:00:00');
  const diff   = Math.round((agora - inicio) / 86400000);
  span.textContent = diff >= 0 ? 'D' + diff : '–';
}

function addDispExtra(desc=''){
  const cont = document.getElementById('disp-extras');
  const row = document.createElement('div');
  row.className = 'dyn-row';
  row.style.marginTop = '5px';
  row.innerHTML = `
    <input type="text" placeholder="Descrever dispositivo (ex: Dreno de tórax D, Pigtail...)" value="${esc(desc)}" style="flex:1;">
    <button class="btn-rem" onclick="this.parentElement.remove()">×</button>
  `;
  cont.appendChild(row);
  _ativarCaixaAltaEm(row);
}

function addInfusaoExtra(nome='', vol=''){
  const cont = document.getElementById('infusoes-extras');
  const row = document.createElement('div');
  row.className = 'dyn-row';
  row.style.marginTop = '4px';
  row.innerHTML = `
    <input type="text" placeholder="Tipo de infusão (ex: Ringer Lactato, SG 10%...)" value="${esc(nome)}" style="flex:2;">
    <input type="number" step="0.1" placeholder="ml/h" value="${vol||''}" style="width:80px;flex:none;">
    <span style="font-size:.68rem;color:var(--muted);">ml/h</span>
    <button class="btn-rem" onclick="this.parentElement.remove()">×</button>
  `;
  cont.appendChild(row);
  _ativarCaixaAltaEm(row);
}

// ══════════════════════════════════════════════════════════════════════════════
// ABRIR FORMULÁRIO DE EVOLUÇÃO
// ══════════════════════════════════════════════════════════════════════════════
async function abrirForm(num){
  leitoAtual = num;
  showLoading('Carregando evolução...');
  try {
    const dl = await leitosData();
    const pac = dl[num];
    const enf = enfermariaDoLeito(num);

    // Garante que builders foram montados
    _montarCheckboxes();
    _montarMedidasPrev();
    _montarEscalas();
    _montarSSVV();

    // Limpa
    _limparCamposEditaveis();
    document.getElementById('f-atb-list').innerHTML = '';

    // Cabeçalho do formulário
    document.getElementById('form-titulo').textContent = `Evolução – ${enf.nome} · Leito ${pad(num)}`;
    document.getElementById('form-sub').textContent = `Hospital dos Pescadores · Clínica Médica · ${pac.pac || ''}`;
    const b = document.getElementById('badge-form');
    b.textContent = turno === 'DIURNO' ? '☀ DIURNO' : '☽ NOTURNO';
    b.className = 'badge ' + (turno === 'DIURNO' ? 'badge-d' : 'badge-n');

    // Identificação (vem do leito — readonly)
    setF('f-pac',      pac.pac || '');
    setF('f-leito',    `Leito ${pad(num)} – ${enf.nome}`);
    setF('f-data',     hoje());
    setF('f-dn',       pac.dn || '');
    setF('f-idade',    calcIdade(pac.dn));
    setF('f-diag',     pac.diag || '');
    setF('f-adm',      pac.adm || '');
    setF('f-adm-hosp', pac.admHosp || '');
    setF('f-comor',    pac.comor || '');
    setF('f-alergia',  pac.alergia || '');

    // Tenta carregar evolução de hoje (deste turno) primeiro
    const evHoje = await dbGet(evKey(num, turno, hoje()));
    document.getElementById('cloud-tag').style.display = (!modoOffline && evHoje) ? 'inline' : 'none';

    if (evHoje) {
      _carregarDadosForm(evHoje);
      document.getElementById('herd-tag').style.display = 'none';
    } else {
      // Sem evolução deste turno → tenta herdar do turno anterior
      await _herdarCamposAnterior(num);
    }

    _atualizarTotaisEscalas();

    mostrarTela('t-form');
    _ativarCaixaAlta();
    window.scrollTo(0,0);
  } finally {
    hideLoading();
  }
}

// ── LIMPEZA DE CAMPOS ────────────────────────────────────────────────────────
function _limparCamposEditaveis(){
  const textIds = [
    'f-pele-outros','f-reducao','f-ap-outros','f-microorg',
    'f-cn-lmin','f-mv-fio2','f-mnr-lmin',
    'f-sne-vaz','f-soe-vaz','f-sng-vaz','f-npt-vaz','f-gtm-vaz',
    'f-svd-data','f-diur-m','f-diur-t','f-diur-n',
    'f-avp-local','f-avp-data','f-avc-local','f-avc-data',
    'f-cdl-local','f-cdl-data','f-drt-ins','f-drt-deb',
    'f-sne-data','f-cisto-data','f-svd2-data',
    'f-hv-m','f-hv-t','f-hv-n',
    'f-eletr','f-lesoes','f-ex-feitos','f-ex-sol','f-ex-prep','f-nir',
    'f-info','f-obs','f-glas'
  ];
  textIds.forEach(id => setF(id, ''));
  document.querySelectorAll('#t-form input[type="checkbox"]').forEach(cb => cb.checked = false);
  document.querySelectorAll('#t-form input[type="radio"]').forEach(r => r.checked = false);
  ['f-vni-tipo','f-avc-curat','f-drt-lado','f-sne-tipo'].forEach(id => setF(id, ''));
  document.getElementById('f-atb-list').innerHTML = '';
  document.getElementById('disp-extras').innerHTML = '';
  document.getElementById('infusoes-extras').innerHTML = '';
  // Limpa campos SSVV dinâmicos
  document.querySelectorAll('#ssvv-turnos input').forEach(i => i.value = '');
  document.getElementById('herd-tag').style.display = 'none';
}

// ── MONTAGEM DO GRID DE SSVV ─────────────────────────────────────────────────
function _montarSSVV(){
  const cont = document.getElementById('ssvv-turnos');
  if (!cont || cont.dataset.montado) return;
  const turnos = [
    { id:'m', label:'Manhã' },
    { id:'t', label:'Tarde' },
    { id:'n', label:'Noite' }
  ];
  const campos = ['PA','FC','FR','SpO2','Tax','HGT'];
  cont.innerHTML = turnos.map(tr => `
    <div style="margin-bottom:10px;">
      <p class="sub-t" style="margin-bottom:6px;">${tr.label}</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px;">
        ${campos.map(c => `
          <div class="fl" style="flex-direction:column;gap:3px;">
            <label style="font-size:.68rem;font-weight:700;color:var(--muted);min-width:0;">${c}</label>
            <input type="text" id="f-ssvv-${tr.id}-${c.toLowerCase().replace('²','2')}" placeholder="${c}">
          </div>`).join('')}
      </div>
    </div>
  `).join('');
  cont.dataset.montado = '1';
}

// ── HERANÇA DE CAMPOS ENTRE TURNOS ──────────────────────────────────────────
async function _herdarCamposAnterior(leito){
  const outro = turno === 'DIURNO' ? 'NOTURNO' : 'DIURNO';
  let ev = await dbGet(evKey(leito, outro, hoje()));
  if (!ev) {
    const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
    const ontemStr = ontem.getFullYear()+'-'+pad(ontem.getMonth()+1)+'-'+pad(ontem.getDate());
    ev = await dbGet(evKey(leito, 'NOTURNO', ontemStr))
      || await dbGet(evKey(leito, 'DIURNO', ontemStr));
  }
  if (!ev) return;

  if (ev.iso)       _marcaRadio('iso', ev.iso);
  if (ev.microorg)  setF('f-microorg', ev.microorg);
  if (ev.pupilas)   (ev.pupilas || []).forEach(v => _marcaCheck('pup-' + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  if (ev.vent)      _marcaRadio('vent', ev.vent);
  if (ev.ventExtra) {
    if (ev.ventExtra.cnLmin)  setF('f-cn-lmin',  ev.ventExtra.cnLmin);
    if (ev.ventExtra.mvFio2)  setF('f-mv-fio2',  ev.ventExtra.mvFio2);
    if (ev.ventExtra.mnrLmin) setF('f-mnr-lmin', ev.ventExtra.mnrLmin);
    if (ev.ventExtra.vniTipo) setF('f-vni-tipo', ev.ventExtra.vniTipo);
  }
  if (ev.dispositivos) {
    const disp = ev.dispositivos;
    ['avp','avc','cdl','drt','sne','cisto','svd2'].forEach(k => {
      if (disp[k] && disp[k].marcado) {
        const cb = document.getElementById('d-' + k);
        if (cb) cb.checked = true;
      }
    });
    if (disp.avp)   { setF('f-avp-local', disp.avp.local); setF('f-avp-data', disp.avp.data); }
    if (disp.avc)   { setF('f-avc-local', disp.avc.local); setF('f-avc-curat', disp.avc.curat); setF('f-avc-data', disp.avc.data); }
    if (disp.cdl)   { setF('f-cdl-local', disp.cdl.local); setF('f-cdl-data', disp.cdl.data); }
    if (disp.drt)   { setF('f-drt-lado', disp.drt.lado); setF('f-drt-ins', disp.drt.ins); }
    if (disp.sne)   { setF('f-sne-tipo', disp.sne.tipo); setF('f-sne-data', disp.sne.data); }
    if (disp.cisto) { setF('f-cisto-data', disp.cisto.data); }
    if (disp.svd2)  { setF('f-svd2-data', disp.svd2.data); }
  }
  (ev.dispExtras || []).forEach(d => addDispExtra(d));
  (ev.atbs || []).forEach(a => { if (a.nome) addAtb(a.nome, a.d0 || ''); });
  if (ev.dieta) _marcaRadio('dieta', ev.dieta);
  if (ev.hv != null) _marcaRadio('hv', ev.hv);
  (ev.infusoesExtras || []).forEach(inf => addInfusaoExtra(inf.nome, inf.vol));
  if (ev.svdInstaladaEm) setF('f-svd-data', ev.svdInstaladaEm);
  if (ev.medidasPrev) {
    Object.entries(ev.medidasPrev).forEach(([k, v]) => {
      const r = document.querySelector(`input[name="${k}"][value="${v}"]`);
      if (r) r.checked = true;
    });
  }
  _aplicarEscala(BRADEN_ITENS, 'brad',  ev.braden);
  _aplicarEscala(MORSE_ITENS,  'morse', ev.morse);
  _aplicarEscala(FUGULIN_ITENS,'fug',   ev.fugulin);
  if (ev.pulseira) _marcaRadio('pulseira', ev.pulseira);

  document.getElementById('herd-tag').style.display = 'inline';
  toast('↻ Campos herdados do turno anterior');
}

function _marcaRadio(name, val){
  const r = document.querySelector(`input[name="${name}"][value="${val}"]`);
  if (r) r.checked = true;
}
function _marcaCheck(id, val){
  const c = document.getElementById(id);
  if (c) c.checked = !!val;
}
function _aplicarEscala(itens, prefix, dados){
  if (!dados) return;
  for (const item of itens) {
    const pt = dados[item.id];
    if (pt != null) {
      const r = document.querySelector(`input[name="${prefix}-${item.id}"][value="${pt}"]`);
      if (r) r.checked = true;
    }
  }
}

// ── COLETA DE DADOS ─────────────────────────────────────────────────────────
function _coletarDados(){
  const getChks = (arr, prefix) => arr.filter(v => {
    const id = prefix + '-' + v.replace(/[^a-zA-Z0-9]/g, '_');
    return document.getElementById(id)?.checked;
  });
  const getRadio = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';

  const medidasPrev = {};
  MEDIDAS_PREV.forEach(m => {
    const v = document.querySelector(`input[name="${m.id}"]:checked`);
    if (v) medidasPrev[m.id] = v.value;
  });

  const coletarEscala = (itens, prefix) => {
    const dados = {};
    for (const item of itens) {
      const r = document.querySelector(`input[name="${prefix}-${item.id}"]:checked`);
      if (r) dados[item.id] = parseInt(r.value);
    }
    return dados;
  };
  const braden  = coletarEscala(BRADEN_ITENS,  'brad');
  const morse   = coletarEscala(MORSE_ITENS,   'morse');
  const fugulin = coletarEscala(FUGULIN_ITENS, 'fug');

  const bradT = Object.values(braden).reduce((s,v)=>s+v,0);
  const brespondidos = Object.keys(braden).length;
  let bradClass = '', bradLabel = '';
  if (brespondidos === BRADEN_ITENS.length) {
    if (bradT <= 11)      { bradClass = 'a'; bradLabel = 'alto'; }
    else if (bradT <= 14) { bradClass = 'm'; bradLabel = 'mod.'; }
    else                   { bradClass = 'b'; bradLabel = 'baixo'; }
  }
  const morseT = Object.values(morse).reduce((s,v)=>s+v,0);
  const mrespondidos = Object.keys(morse).length;
  let morseClass = '', morseLabel = '';
  if (mrespondidos === MORSE_ITENS.length) {
    if (morseT >= 45)      { morseClass = 'a'; morseLabel = 'alto'; }
    else if (morseT >= 25) { morseClass = 'm'; morseLabel = 'mod.'; }
    else                    { morseClass = 'b'; morseLabel = 'baixo'; }
  }
  const fugT = Object.values(fugulin).reduce((s,v)=>s+v,0);
  const frespondidos = Object.keys(fugulin).length;
  let fugClass = '', fugLabel = '';
  if (frespondidos === FUGULIN_ITENS.length) {
    if (fugT > 34)         { fugClass = 'i';   fugLabel = 'I'; }
    else if (fugT >= 29)   { fugClass = 'si';  fugLabel = 'SI'; }
    else if (fugT >= 23)   { fugClass = 'ad';  fugLabel = 'AD'; }
    else if (fugT >= 18)   { fugClass = 'itm'; fugLabel = 'ITM'; }
    else                    { fugClass = 'cm';  fugLabel = 'CM'; }
  }

  const atbs = [];
  document.querySelectorAll('#f-atb-list .atb-row').forEach(row => {
    const nome = row.querySelector('input[type="text"]')?.value.trim() || '';
    const d0   = row.querySelector('input[type="date"]')?.value || '';
    if (nome) atbs.push({ nome, d0 });
  });

  const dispExtras = [];
  document.querySelectorAll('#disp-extras .dyn-row').forEach(row => {
    const v = row.querySelector('input[type="text"]')?.value.trim() || '';
    if (v) dispExtras.push(v);
  });

  const infusoesExtras = [];
  document.querySelectorAll('#infusoes-extras .dyn-row').forEach(row => {
    const nome = row.querySelector('input[type="text"]')?.value.trim() || '';
    const vol  = row.querySelector('input[type="number"]')?.value || '';
    if (nome) infusoesExtras.push({ nome, vol });
  });

  const dispositivos = {
    avp:   { marcado:document.getElementById('d-avp').checked,   local:gf('f-avp-local'), data:gf('f-avp-data') },
    avc:   { marcado:document.getElementById('d-avc').checked,   local:gf('f-avc-local'), curat:gf('f-avc-curat'), data:gf('f-avc-data') },
    cdl:   { marcado:document.getElementById('d-cdl').checked,   local:gf('f-cdl-local'), data:gf('f-cdl-data') },
    drt:   { marcado:document.getElementById('d-drt').checked,   lado:gf('f-drt-lado'), ins:gf('f-drt-ins'), deb:gf('f-drt-deb') },
    sne:   { marcado:document.getElementById('d-sne').checked,   tipo:gf('f-sne-tipo'), data:gf('f-sne-data') },
    cisto: { marcado:document.getElementById('d-cisto').checked, data:gf('f-cisto-data') },
    svd2:  { marcado:document.getElementById('d-svd2').checked,  data:gf('f-svd2-data') }
  };

  // Coleta SSVV campo a campo
  const campos = ['pa','fc','fr','spo2','tax','hgt'];
  const ssvv = {};
  ['m','t','n'].forEach(tr => {
    ssvv[tr] = {};
    campos.forEach(c => { ssvv[tr][c] = gf(`f-ssvv-${tr}-${c}`); });
  });

  return {
    leito: leitoAtual, turno,
    data: gf('f-data'),
    pac: gf('f-pac'), diag: gf('f-diag'), dn: gf('f-dn'), idade: gf('f-idade'),
    adm: gf('f-adm'), admHosp: gf('f-adm-hosp'),
    comor: gf('f-comor'), alergia: gf('f-alergia'), pulseira: getRadio('pulseira'),
    iso: getRadio('iso'), microorg: gf('f-microorg'),
    pele: getChks(CHK_PELE, 'pele'), peleOutros: gf('f-pele-outros'),
    neuro: getChks(CHK_NEURO, 'neuro'), glas: gf('f-glas'), reducao: gf('f-reducao'),
    pupilas: getChks(CHK_PUPILAS, 'pup'),
    torax: getChks(CHK_TORAX, 'tor'),
    ap: getChks(CHK_AP, 'ap'), apOutros: gf('f-ap-outros'),
    vent: getRadio('vent'),
    ventExtra: { cnLmin:gf('f-cn-lmin'), mvFio2:gf('f-mv-fio2'), mnrLmin:gf('f-mnr-lmin'), vniTipo:gf('f-vni-tipo') },
    cv: getChks(CHK_CV, 'cv'),
    abd: getChks(CHK_ABD, 'abd'),
    dieta: getRadio('dieta'),
    dietaVaz: { sne:gf('f-sne-vaz'), soe:gf('f-soe-vaz'), sng:gf('f-sng-vaz'), npt:gf('f-npt-vaz'), gtm:gf('f-gtm-vaz') },
    diurese: getChks(CHK_DIURESE, 'diu'),
    svdInstaladaEm: gf('f-svd-data'),
    diureseMl: { m:gf('f-diur-m'), t:gf('f-diur-t'), n:gf('f-diur-n') },
    intest: getChks(CHK_INTEST, 'int'),
    dispositivos, dispExtras,
    hv: getRadio('hv'),
    hvVol: { m:gf('f-hv-m'), t:gf('f-hv-t'), n:gf('f-hv-n') },
    infusoesExtras,
    atbs,
    eletrolitos: gf('f-eletr'),
    medidasPrev,
    lesoes: gf('f-lesoes'),
    exFeitos: gf('f-ex-feitos'), exSol: gf('f-ex-sol'),
    nir: gf('f-nir'), exPrep: gf('f-ex-prep'),
    ssvv,
    info: gf('f-info'), obs: gf('f-obs'),
    braden, bradTotal: bradT, bradClass, bradLabel,
    morse,  morseTotal: morseT, morseClass, morseLabel,
    fugulin, fugTotal: fugT, fugClass, fugLabel,
    autor: usuarioEmail,
    criadoEm: new Date().toISOString()
  };
}

function _carregarDadosForm(d){
  setF('f-data', d.data || hoje());
  if (d.pulseira) _marcaRadio('pulseira', d.pulseira);

  if (d.iso) _marcaRadio('iso', d.iso);
  setF('f-microorg', d.microorg || '');

  (d.pele    || []).forEach(v => _marcaCheck('pele-'  + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  setF('f-pele-outros', d.peleOutros || '');
  (d.neuro   || []).forEach(v => _marcaCheck('neuro-' + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  setF('f-glas', d.glas || ''); setF('f-reducao', d.reducao || '');
  (d.pupilas || []).forEach(v => _marcaCheck('pup-'   + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.torax   || []).forEach(v => _marcaCheck('tor-'   + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.ap      || []).forEach(v => _marcaCheck('ap-'    + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  setF('f-ap-outros', d.apOutros || '');
  if (d.vent) _marcaRadio('vent', d.vent);
  if (d.ventExtra) {
    setF('f-cn-lmin',  d.ventExtra.cnLmin || '');
    setF('f-mv-fio2',  d.ventExtra.mvFio2 || '');
    setF('f-mnr-lmin', d.ventExtra.mnrLmin || '');
    setF('f-vni-tipo', d.ventExtra.vniTipo || '');
  }
  (d.cv  || []).forEach(v => _marcaCheck('cv-'  + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.abd || []).forEach(v => _marcaCheck('abd-' + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  if (d.dieta) _marcaRadio('dieta', d.dieta);
  if (d.dietaVaz) {
    setF('f-sne-vaz', d.dietaVaz.sne || '');
    setF('f-soe-vaz', d.dietaVaz.soe || '');
    setF('f-sng-vaz', d.dietaVaz.sng || '');
    setF('f-npt-vaz', d.dietaVaz.npt || '');
    setF('f-gtm-vaz', d.dietaVaz.gtm || '');
  }
  (d.diurese || []).forEach(v => _marcaCheck('diu-' + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  setF('f-svd-data', d.svdInstaladaEm || '');
  if (d.diureseMl) { setF('f-diur-m', d.diureseMl.m||''); setF('f-diur-t', d.diureseMl.t||''); setF('f-diur-n', d.diureseMl.n||''); }
  (d.intest || []).forEach(v => _marcaCheck('int-' + v.replace(/[^a-zA-Z0-9]/g, '_'), true));

  if (d.dispositivos) {
    const disp = d.dispositivos;
    ['avp','avc','cdl','drt','sne','cisto','svd2'].forEach(k => {
      const cb = document.getElementById('d-' + k);
      if (cb && disp[k] && disp[k].marcado) cb.checked = true;
    });
    if (disp.avp)   { setF('f-avp-local', disp.avp.local); setF('f-avp-data', disp.avp.data); }
    if (disp.avc)   { setF('f-avc-local', disp.avc.local); setF('f-avc-curat', disp.avc.curat); setF('f-avc-data', disp.avc.data); }
    if (disp.cdl)   { setF('f-cdl-local', disp.cdl.local); setF('f-cdl-data', disp.cdl.data); }
    if (disp.drt)   { setF('f-drt-lado', disp.drt.lado); setF('f-drt-ins', disp.drt.ins); setF('f-drt-deb', disp.drt.deb); }
    if (disp.sne)   { setF('f-sne-tipo', disp.sne.tipo); setF('f-sne-data', disp.sne.data); }
    if (disp.cisto) { setF('f-cisto-data', disp.cisto.data); }
    if (disp.svd2)  { setF('f-svd2-data', disp.svd2.data); }
  }
  (d.dispExtras || []).forEach(desc => addDispExtra(desc));

  if (d.hv != null) _marcaRadio('hv', d.hv);
  if (d.hvVol) { setF('f-hv-m', d.hvVol.m||''); setF('f-hv-t', d.hvVol.t||''); setF('f-hv-n', d.hvVol.n||''); }
  (d.infusoesExtras || []).forEach(inf => addInfusaoExtra(inf.nome, inf.vol));

  document.getElementById('f-atb-list').innerHTML = '';
  (d.atbs || []).forEach(a => { if (a.nome) addAtb(a.nome, a.d0 || ''); });

  setF('f-eletr', d.eletrolitos || '');

  if (d.medidasPrev) {
    Object.entries(d.medidasPrev).forEach(([k, v]) => {
      const r = document.querySelector(`input[name="${k}"][value="${v}"]`);
      if (r) r.checked = true;
    });
  }

  setF('f-lesoes',   d.lesoes   || '');
  setF('f-ex-feitos',d.exFeitos || '');
  setF('f-ex-sol',   d.exSol    || '');
  setF('f-nir',      d.nir      || '');
  setF('f-ex-prep',  d.exPrep   || '');

  // SSVV — pode ser objeto aninhado (novo) ou string (legado)
  if (d.ssvv && typeof d.ssvv === 'object') {
    const campos = ['pa','fc','fr','spo2','tax','hgt'];
    ['m','t','n'].forEach(tr => {
      if (d.ssvv[tr] && typeof d.ssvv[tr] === 'object') {
        campos.forEach(c => setF(`f-ssvv-${tr}-${c}`, d.ssvv[tr][c] || ''));
      }
    });
  }
  setF('f-info', d.info || '');
  setF('f-obs',  d.obs  || '');

  _aplicarEscala(BRADEN_ITENS, 'brad',  d.braden);
  _aplicarEscala(MORSE_ITENS,  'morse', d.morse);
  _aplicarEscala(FUGULIN_ITENS,'fug',   d.fugulin);
}

// ── GERADOR DE TEXTO AUTOMÁTICO PARA OBSERVAÇÕES ─────────────────────────────
function gerarTextoObs(){
  const d = _coletarDados();
  const partes = [];

  // Cabeçalho clínico
  let dih = '';
  if (d.admHosp) {
    const diff = Math.max(1, Math.round((new Date(hoje()+'T00:00:00') - new Date(d.admHosp+'T00:00:00')) / 86400000));
    dih = `${diff}º DIH`;
  } else if (d.adm) {
    const diff = Math.max(1, Math.round((new Date(hoje()+'T00:00:00') - new Date(d.adm+'T00:00:00')) / 86400000));
    dih = `${diff}º dia de internação`;
  } else { dih = 'X DIH'; }

  const diag  = d.diag  ? d.diag.trim()  : 'diagnóstico não informado';
  const comor = d.comor ? '; comorbidades: ' + d.comor.trim() : '';
  const aler  = (d.alergia && !/^nega|^nkda/i.test(d.alergia.trim()))
    ? `; alérgico a ${d.alergia.trim()}`
    : '; nega alergias';
  partes.push(`Paciente no ${dih} de internação por ${diag}${comor}${aler}.`);

  // Neurológico
  const neuroPartes = [];
  if (d.neuro?.length) neuroPartes.push(d.neuro.join(', ').toLowerCase());
  if (d.glas) neuroPartes.push(`Glasgow ${d.glas}`);
  if (d.pupilas?.length) neuroPartes.push(`pupilas ${d.pupilas.join(', ').toLowerCase()}`);
  if (neuroPartes.length) partes.push('Neurológico: ' + neuroPartes.join(', ') + '.');

  // Respiratório
  const respPartes = [];
  if (d.torax?.length) respPartes.push(d.torax.join(', ').toLowerCase());
  if (d.ap?.length) respPartes.push('ausculta: ' + d.ap.join(', ').toLowerCase());
  if (d.vent) {
    let ventStr = d.vent;
    if (d.vent === 'Cateter nasal' && d.ventExtra?.cnLmin) ventStr += ` ${d.ventExtra.cnLmin} L/min`;
    else if (d.vent === 'Macronebulização' && d.ventExtra?.mvFio2) ventStr += ` FiO₂ ${d.ventExtra.mvFio2}%`;
    else if (d.vent === 'Máscara NR' && d.ventExtra?.mnrLmin) ventStr += ` ${d.ventExtra.mnrLmin} L/min`;
    respPartes.push(`ventilação: ${ventStr.toLowerCase()}`);
  }
  if (respPartes.length) partes.push('Respiratório: ' + respPartes.join('; ') + '.');

  // Cardiovascular
  if (d.cv?.length) partes.push('Cardiovascular: ' + d.cv.join(', ').toLowerCase() + '.');

  // Abdome / dieta
  const abdPartes = [];
  if (d.abd?.length) abdPartes.push(d.abd.join(', ').toLowerCase());
  if (d.dieta) abdPartes.push(`dieta: ${d.dieta.toLowerCase()}`);
  if (abdPartes.length) partes.push('Abdome: ' + abdPartes.join('; ') + '.');

  // Pele
  const pelePartes = [...(d.pele||[])];
  if (d.peleOutros) pelePartes.push(d.peleOutros);
  if (pelePartes.length) partes.push('Pele: ' + pelePartes.join(', ').toLowerCase() + '.');

  // Diurese
  const diuPartes = [...(d.diurese||[])];
  const diurTotal = [d.diureseMl?.m, d.diureseMl?.t, d.diureseMl?.n].filter(Boolean).map(Number).reduce((a,b)=>a+b,0);
  if (diurTotal > 0) diuPartes.push(`débito ${diurTotal} ml no turno`);
  if (diuPartes.length) partes.push('Diurese: ' + diuPartes.join(', ').toLowerCase() + '.');

  // Eliminações intestinais
  if (d.intest?.length) partes.push('Eliminações intestinais: ' + d.intest.join(', ').toLowerCase() + '.');

  // Dispositivos
  const disps = [];
  const dp = d.dispositivos || {};
  if (dp.avp?.marcado) disps.push(`AVP${dp.avp.local?' em '+dp.avp.local.toLowerCase():''}`);
  if (dp.avc?.marcado) disps.push(`AVC${dp.avc.local?' em '+dp.avc.local.toLowerCase():''}`);
  if (dp.cdl?.marcado) disps.push(`CDL${dp.cdl.local?' em '+dp.cdl.local.toLowerCase():''}`);
  if (dp.drt?.marcado) disps.push(`dreno de tórax${dp.drt.lado?' '+dp.drt.lado.toLowerCase():''}`);
  if (dp.sne?.marcado) disps.push(dp.sne.tipo||'SNE/SNG');
  if (dp.cisto?.marcado) disps.push('cistostomia');
  if (dp.svd2?.marcado) disps.push('SVD');
  (d.dispExtras||[]).forEach(e => { if (e) disps.push(e.toLowerCase()); });
  if (disps.length) partes.push('Dispositivos: ' + disps.join(', ') + '.');

  // ATBs
  if (d.atbs?.length) {
    const atbStr = d.atbs.filter(a=>a.nome).map(a => {
      if (a.d0) {
        const diff = Math.round((new Date(hoje()+'T00:00:00') - new Date(a.d0+'T00:00:00')) / 86400000);
        return `${a.nome} (D${diff >= 0 ? diff : '?'})`;
      }
      return a.nome;
    }).join(', ');
    if (atbStr) partes.push('Antimicrobianos: ' + atbStr + '.');
  }

  // Escalas
  const escPartes = [];
  const bradT = parseInt(document.getElementById('brad-total')?.textContent);
  const bradL = document.getElementById('brad-label')?.textContent;
  if (!isNaN(bradT) && bradL && bradL !== 'Não avaliado') escPartes.push(`Braden ${bradT} (${bradL.toLowerCase()})`);
  const morseT = parseInt(document.getElementById('morse-total')?.textContent);
  const morseL = document.getElementById('morse-label')?.textContent;
  if (!isNaN(morseT) && morseL && morseL !== 'Não avaliado') escPartes.push(`Morse ${morseT} (${morseL.toLowerCase()})`);
  const fugT = parseInt(document.getElementById('fug-total')?.textContent);
  const fugL = document.getElementById('fug-label')?.textContent;
  if (!isNaN(fugT) && fugL && fugL !== 'Não avaliado') escPartes.push(`Fugulin ${fugT} (${fugL.toLowerCase()})`);
  if (escPartes.length) partes.push('Escalas: ' + escPartes.join('; ') + '.');

  const texto = partes.join('\n');
  const obsEl = document.getElementById('f-obs');
  if (obsEl) {
    obsEl.value = texto;
    obsEl.focus();
    obsEl.scrollIntoView({ behavior:'smooth', block:'center' });
  }
  toast('✓ Texto gerado — edite conforme necessário');
}


async function gerarPreview(){
  const d = _coletarDados();
  if (!d.pac.trim()) { toast('Identifique o paciente primeiro', true); return; }

  // Salva no banco (Firestore + localStorage + memCache)
  const key = evKey(leitoAtual, turno, d.data || hoje());
  await dbSet(key, d);
  memDel(key); // força refresh para mostrar badges no painel

  toast('✓ Evolução salva');
  _renderPreview(d);

  // Atualiza cabeçalho do preview
  const enf = enfermariaDoLeito(leitoAtual);
  document.getElementById('prev-sub').textContent = `${enf.nome} · Leito ${pad(leitoAtual)} · ${turno}`;
  const bp = document.getElementById('badge-prev');
  bp.textContent = turno === 'DIURNO' ? '☀ DIURNO' : '☽ NOTURNO';
  bp.className = 'badge ' + (turno === 'DIURNO' ? 'badge-d' : 'badge-n');
  document.getElementById('pdf-status').textContent = '';

  mostrarTela('t-prev');
  window.scrollTo(0,0);
}

function _renderPreview(d){
  const enf = enfermariaDoLeito(leitoAtual);
  const tipoTurno = turno === 'DIURNO' ? 'DIURNO (07h–19h)' : 'NOTURNO (19h–07h)';

  // Helpers
  const listaCheck = arr => (arr && arr.length) ? arr.join(', ') : '—';
  const ventText = (() => {
    if (!d.vent) return '—';
    if (d.vent === 'Cateter nasal' && d.ventExtra?.cnLmin) return `${d.vent} ${d.ventExtra.cnLmin} L/min`;
    if (d.vent === 'Macronebulização' && d.ventExtra?.mvFio2) return `${d.vent} FiO₂ ${d.ventExtra.mvFio2}%`;
    if (d.vent === 'Máscara NR' && d.ventExtra?.mnrLmin) return `${d.vent} ${d.ventExtra.mnrLmin} L/min`;
    if (d.vent === 'VNI' && d.ventExtra?.vniTipo) return `${d.vent} (${d.ventExtra.vniTipo})`;
    return d.vent;
  })();
  const dietaText = (() => {
    if (!d.dieta) return '—';
    const v = d.dietaVaz || {};
    const tipo = d.dieta;
    const k = tipo.toLowerCase();
    const vaz = v[k];
    return vaz ? `${tipo} – vazão ${vaz}` : tipo;
  })();
  const hvText = (() => {
    const partes = [];
    if (d.hv && d.hv !== 'Nenhuma') {
      const v = d.hvVol || {};
      const vols = [];
      if (v.m) vols.push(`M ${v.m}`);
      if (v.t) vols.push(`T ${v.t}`);
      if (v.n) vols.push(`N ${v.n}`);
      partes.push(d.hv + (vols.length ? ` – ${vols.join(' / ')} ml/h` : ''));
    }
    (d.infusoesExtras || []).forEach(inf => {
      if (inf.nome) partes.push(inf.nome + (inf.vol ? ` ${inf.vol} ml/h` : ''));
    });
    return partes.length ? partes.join(' · ') : 'Nenhuma';
  })();
  const dispList = [];
  if (d.dispositivos) {
    const dp = d.dispositivos;
    if (dp.avp?.marcado)   dispList.push(`AVP${dp.avp.local?` (${dp.avp.local})`:''}${dp.avp.data?` – inst. ${fmtD(dp.avp.data)}`:''}`);
    if (dp.avc?.marcado)   dispList.push(`AVC${dp.avc.local?` (${dp.avc.local})`:''}${dp.avc.curat?` – ${dp.avc.curat}`:''}${dp.avc.data?` – inst. ${fmtD(dp.avc.data)}`:''}`);
    if (dp.cdl?.marcado)   dispList.push(`CDL/HD${dp.cdl.local?` (${dp.cdl.local})`:''}${dp.cdl.data?` – inst. ${fmtD(dp.cdl.data)}`:''}`);
    if (dp.drt?.marcado)   dispList.push(`Dreno tórax${dp.drt.lado?` ${dp.drt.lado}`:''}${dp.drt.ins?` – inst. ${fmtD(dp.drt.ins)}`:''}${dp.drt.deb?` – débito 6h: ${dp.drt.deb}`:''}`);
    if (dp.sne?.marcado)   dispList.push(`${dp.sne.tipo||'SNE/SNG'}${dp.sne.data?` – inst. ${fmtD(dp.sne.data)}`:''}`);
    if (dp.cisto?.marcado) dispList.push(`Cistostomia${dp.cisto.data?` – inst. ${fmtD(dp.cisto.data)}`:''}`);
    if (dp.svd2?.marcado)  dispList.push(`SVD${dp.svd2.data?` – inst. ${fmtD(dp.svd2.data)}`:''}`);
  }
  (d.dispExtras || []).forEach(desc => { if (desc) dispList.push(desc); });
  const atbList = (d.atbs || []).filter(a=>a.nome).map(a => {
    let texto = a.nome;
    if (a.d0) {
      const inicio = new Date(a.d0 + 'T00:00:00');
      const agora  = new Date(hoje() + 'T00:00:00');
      const diff   = Math.round((agora - inicio) / 86400000);
      texto += ` (D0: ${fmtD(a.d0)} — D${diff >= 0 ? diff : '?'})`;
    }
    return texto;
  });
  const medList = [];
  if (d.medidasPrev) {
    const labels = {
      'mp-tev':'Profilaxia TEV','mp-grades':'Grades','mp-cont':'Contenção mecânica',
      'mp-cont-tr':'Contenção trocada hoje','mp-cont-ok':'Contenção sem garrotear',
      'mp-colch':'Colchão de ar','mp-cab':'Cabeceira 30°','mp-higi':'Higiene oral'
    };
    Object.entries(d.medidasPrev).forEach(([k,v])=>{
      if (labels[k]) medList.push(`${labels[k]}: ${v}`);
    });
  }
  const bradCls  = d.bradLabel ? `${d.bradTotal||'—'} – ${d.bradLabel === 'alto' ? 'Risco ALTO' : d.bradLabel === 'mod.' ? 'Risco moderado' : 'Risco baixo'}` : 'Não avaliado';
  const morseCls = d.morseLabel ? `${d.morseTotal||'—'} – ${d.morseLabel === 'alto' ? 'Risco ALTO' : d.morseLabel === 'mod.' ? 'Risco moderado' : 'Risco baixo'}` : 'Não avaliado';
  const fugMap = { i:'Intensivo', si:'Semi-intensivo', ad:'Alta dependência', itm:'Intermediário', cm:'Cuidado mínimo' };
  const fugCls = d.fugClass ? `${d.fugTotal||'—'} – ${fugMap[d.fugClass]}` : 'Não avaliado';

  document.getElementById('preview-area').innerHTML = `
    <div class="pv-head">
      <h2>Hospital dos Pescadores – Clínica Médica</h2>
      <h3>Evolução de Enfermagem</h3>
      <p>${esc(enf.nome)} · Leito ${pad(leitoAtual)} · Turno ${tipoTurno} · ${fmtD(d.data || hoje())}</p>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Identificação</div>
      <div class="pv-sec-c">
        <div class="pr"><span class="pl">Paciente:</span><span class="pv">${esc(d.pac)}</span></div>
        <div class="pr">
          <span class="pl">DN:</span><span class="pv">${fmtD(d.dn)||'—'}</span>
          <span class="pl">Idade:</span><span class="pv">${esc(d.idade)||'—'}</span>
          <span class="pl">Adm. enfermaria:</span><span class="pv">${fmtD(d.adm)||'—'}</span>
          <span class="pl">Adm. HOSPESC:</span><span class="pv">${fmtD(d.admHosp)||'—'}</span>
        </div>
        <div class="pr"><span class="pl">Diagnóstico:</span><span class="pv">${esc(d.diag)||'—'}</span></div>
        <div class="pr"><span class="pl">Comorbidades:</span><span class="pv">${esc(d.comor)||'—'}</span></div>
        <div class="pr"><span class="pl">Alergias:</span><span class="pv">${esc(d.alergia)||'—'}</span></div>
        <div class="pr">
          <span class="pl">Pulseira ID:</span><span class="pv">${esc(d.pulseira)||'—'}</span>
          <span class="pl">Isolamento:</span><span class="pv">${esc(d.iso)||'—'}${d.microorg?` (${esc(d.microorg)})`:''}</span>
        </div>
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Pele e Mucosas</div>
      <div class="pv-sec-c pv-check-list">${listaCheck(d.pele)}${d.peleOutros?` · ${esc(d.peleOutros)}`:''}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Neurológico</div>
      <div class="pv-sec-c">
        <div>${listaCheck(d.neuro)}${d.glas?` · Glasgow ${esc(d.glas)}`:''}${d.reducao?` · Redução de força: ${esc(d.reducao)}`:''}</div>
        <div style="margin-top:3px;"><strong>Pupilas:</strong> ${listaCheck(d.pupilas)}</div>
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Sistema Respiratório</div>
      <div class="pv-sec-c">
        <div>${listaCheck(d.torax)}</div>
        <div style="margin-top:3px;"><strong>Ausculta:</strong> ${listaCheck(d.ap)}${d.apOutros?` · ${esc(d.apOutros)}`:''}</div>
        <div style="margin-top:3px;"><strong>Ventilação:</strong> ${esc(ventText)}</div>
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Cardiovascular</div>
      <div class="pv-sec-c pv-check-list">${listaCheck(d.cv)}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Abdome</div>
      <div class="pv-sec-c pv-check-list">${listaCheck(d.abd)}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Dieta / Eliminações</div>
      <div class="pv-sec-c">
        <div><strong>Dieta:</strong> ${esc(dietaText)}</div>
        <div style="margin-top:3px;"><strong>Diurese:</strong> ${(d.diurese||[]).join(', ')||'—'}
          ${d.svdInstaladaEm?' — SVD instalada em '+fmtD(d.svdInstaladaEm):''}
          ${(d.diureseMl?.m||d.diureseMl?.t||d.diureseMl?.n) ? ` — Débito: M ${d.diureseMl.m||'—'} / T ${d.diureseMl.t||'—'} / N ${d.diureseMl.n||'—'} ml` : ''}
        </div>
        <div style="margin-top:3px;"><strong>Eliminações intestinais:</strong> ${(d.intest||[]).join(', ')||'—'}</div>
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Dispositivos Médicos</div>
      <div class="pv-sec-c pv-textao">${dispList.length ? dispList.join('\n') : '—'}</div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Hidratação Venosa</div>
      <div class="pv-sec-c">${esc(hvText)}</div>
    </div>

    <div id="pdf-break-point"></div>

    <div class="pv-sec">
      <div class="pv-sec-t">Antimicrobianos em Uso</div>
      <div class="pv-sec-c">${atbList.length ? atbList.join(' · ') : '—'}</div>
    </div>

    ${d.eletrolitos ? `
    <div class="pv-sec">
      <div class="pv-sec-t">Reposição / Correção de Eletrólitos</div>
      <div class="pv-sec-c pv-textao">${esc(d.eletrolitos)}</div>
    </div>`:''}

    ${medList.length ? `
    <div class="pv-sec">
      <div class="pv-sec-t">Medidas Preventivas</div>
      <div class="pv-sec-c">${medList.join(' · ')}</div>
    </div>`:''}

    ${d.lesoes ? `
    <div class="pv-sec">
      <div class="pv-sec-t">Lesões e Curativos</div>
      <div class="pv-sec-c pv-textao">${esc(d.lesoes)}</div>
    </div>`:''}

    ${(d.exFeitos||d.exSol||d.exPrep||d.nir) ? `
    <div class="pv-sec">
      <div class="pv-sec-t">Exames e Procedimentos</div>
      <div class="pv-sec-c">
        ${d.exFeitos ? `<div><strong>Realizados hoje:</strong> ${esc(d.exFeitos)}</div>` : ''}
        ${d.exSol    ? `<div style="margin-top:3px;"><strong>Solicitados hoje:</strong> ${esc(d.exSol)}${d.nir?' — NIR às '+esc(d.nir):''}</div>` : ''}
        ${d.exPrep   ? `<div style="margin-top:3px;"><strong>Preparo p/ amanhã:</strong> ${esc(d.exPrep)}</div>` : ''}
      </div>
    </div>`:''}

    ${(() => {
      const campos = ['pa','fc','fr','spo2','tax','hgt'];
      const labels = {pa:'PA',fc:'FC',fr:'FR',spo2:'SpO2',tax:'Tax',hgt:'HGT'};
      const turnosLabel = {m:'Manhã',t:'Tarde',n:'Noite'};
      const linhas = ['m','t','n'].map(tr => {
        if (!d.ssvv || !d.ssvv[tr]) return '';
        const vals = campos.filter(c => d.ssvv[tr][c]).map(c => `${labels[c]}: ${esc(d.ssvv[tr][c])}`);
        if (!vals.length) return '';
        return `<div style="margin-bottom:3px;"><strong>${turnosLabel[tr]}:</strong> ${vals.join(' · ')}</div>`;
      }).filter(Boolean);
      if (!linhas.length) return '';
      return `<div class="pv-sec"><div class="pv-sec-t">SSVV / HGT</div><div class="pv-sec-c">${linhas.join('')}</div></div>`;
    })()}

    ${d.info ? `
    <div class="pv-sec">
      <div class="pv-sec-t">Informações Complementares</div>
      <div class="pv-sec-c pv-textao">${esc(d.info)}</div>
    </div>`:''}

    <div class="pv-sec">
      <div class="pv-sec-t">Escalas</div>
      <div style="border:1px solid black;border-top:none;">
        <div class="pv-escala primeira"><span>Braden — LPP</span><span>${bradCls}</span></div>
        <div class="pv-escala"><span>Morse — Queda</span><span>${morseCls}</span></div>
        <div class="pv-escala"><span>Fugulin — Complexidade</span><span>${fugCls}</span></div>
      </div>
    </div>

    ${d.obs ? `
    <div class="pv-sec">
      <div class="pv-sec-t">Observações / Intercorrências</div>
      <div class="pv-sec-c pv-textao">${esc(d.obs)}</div>
    </div>`:''}

    <div class="pv-foot">
      ${esc(d.autor)||'—'} · ${new Date().toLocaleString('pt-BR')}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// GERAR PDF + ENVIAR AO DRIVE
// ══════════════════════════════════════════════════════════════════════════════
async function gerarPDF(){
  const btn = document.getElementById('btn-pdf');
  const status = document.getElementById('pdf-status');
  const area = document.getElementById('preview-area');
  const wrap = document.getElementById('preview-wrap');
  if (!area.innerHTML.trim()) { alert('Gere a impressão primeiro.'); return; }

  btn.disabled = true; btn.textContent = '⏳ Gerando...';
  status.textContent = 'Capturando...'; status.style.color = 'var(--muted)';

  const origW = area.style.width, origMW = area.style.maxWidth;
  const origWW = wrap.style.width, origWMW = wrap.style.maxWidth;
  const origBody = document.body.style.overflow;
  const LARGURA = 780;
  area.style.width = LARGURA + 'px'; area.style.maxWidth = 'none';
  wrap.style.width = LARGURA + 'px'; wrap.style.maxWidth = 'none';
  document.body.style.overflow = 'hidden';

  try {
    const {jsPDF} = window.jspdf;
    const pdf = new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const contentW = pageW - margin*2;
    const contentH = pageH - margin*2;

    const canvas = await html2canvas(area, {
      scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false,
      width: LARGURA, windowWidth: LARGURA
    });

    const mmTotal = (canvas.height / canvas.width) * contentW;
    let larguraUso = contentW;
    const PAGINAS = 2;
    if (mmTotal > PAGINAS * contentH) {
      larguraUso = contentW * (PAGINAS * contentH) / mmTotal;
    }
    const pxPorPag = Math.floor((contentH / contentW) * canvas.width * (contentW / larguraUso));

    let breakPx = null;
    const breakEl = area.querySelector('#pdf-break-point');
    if (breakEl) {
      const areaTop = area.getBoundingClientRect().top;
      const breakTop = breakEl.getBoundingClientRect().top;
      breakPx = Math.round((breakTop - areaTop) * 2);
    }
    const offsetX = margin + (contentW - larguraUso) / 2;

    function addFatia(yStart, yEnd){
      const h = yEnd - yStart;
      const sc = document.createElement('canvas');
      sc.width = canvas.width; sc.height = h;
      const ctx = sc.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,sc.width,h);
      ctx.drawImage(canvas, 0,yStart, canvas.width,h, 0,0, canvas.width,h);
      const mmH = (h / canvas.width) * larguraUso;
      pdf.addImage(sc.toDataURL('image/jpeg',.92), 'JPEG', offsetX, margin, larguraUso, mmH);
    }

    if (canvas.height <= pxPorPag) {
      addFatia(0, canvas.height);
    } else if (breakPx && breakPx > 0 && breakPx < canvas.height && breakPx <= pxPorPag) {
      addFatia(0, breakPx);
      pdf.addPage();
      addFatia(breakPx, Math.min(breakPx + pxPorPag, canvas.height));
    } else {
      let y = 0, pag = 0;
      while (y < canvas.height && pag < PAGINAS) {
        if (pag > 0) pdf.addPage();
        const yEnd = Math.min(y + pxPorPag, canvas.height);
        addFatia(y, yEnd);
        y = yEnd; pag++;
      }
    }

    const d = _coletarDados();
    const [ano,mes,dia] = (d.data||hoje()).split('-');
    const dataBR = dia + mes + ano;
    const nomePac = (d.pac || '').trim();
    const primNome = (nomePac.split(' ')[0] || 'Pac').toUpperCase();
    const pastaNome = nomePac
      ? `Leito ${pad(leitoAtual)} - ${nomePac}`
      : `Leito ${pad(leitoAtual)} - Sem identificacao`;
    const titulo = `EvolucaoCM_L${pad(leitoAtual)}_${turno}_${dataBR}_${primNome}`;

    status.textContent = 'Enviando ao Drive...';
    const dataUri = pdf.output('datauristring');
    const base64 = dataUri.split(',')[1];

    const payload = JSON.stringify({
      titulo,
      arquivoBase64: base64,
      pasta: pastaNome,
      pastaRaizId: PASTA_EVOLUCAO_ID
    });

    // Usa FormData para garantir "simple request" sem preflight CORS.
    // O Apps Script lê e-postData.contents quando o body chega como campo 'payload'.
    // Alternativa: envia como texto puro via form urlencoded — também sem preflight.
    const form = new FormData();
    form.append('payload', payload);

    let enviado = false;
    try {
      await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: form
      });
      enviado = true;
    } catch(fetchErr) {
      console.warn('fetch FormData falhou, tentando text/plain:', fetchErr);
    }

    // Fallback: text/plain (funciona quando FormData não é aceita)
    if (!enviado) {
      await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: payload
      });
    }

    status.textContent = '✓ Enviado ao Drive com sucesso';
    status.style.color = 'var(--verde)';
    toast('✓ PDF salvo no Drive');

  } catch(err) {
    console.error('gerarPDF:', err);
    status.textContent = 'Erro ao gerar/enviar. Tente novamente ou use Ctrl+P.';
    status.style.color = 'var(--vermelho)';
  } finally {
    area.style.width = origW; area.style.maxWidth = origMW;
    wrap.style.width = origWW; wrap.style.maxWidth = origWMW;
    document.body.style.overflow = origBody;
  }

  btn.disabled = false; btn.textContent = '☁ Salvar PDF no Drive';
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL ADMISSÃO (também usado para edição)
// ══════════════════════════════════════════════════════════════════════════════
async function acaoEditarAdmissao(){
  modoEdicaoAdm = true;
  abrirModalAdm(leitoAtual, false);
}

async function abrirModalAdm(leito, isNova){
  const d = await leitosData();
  const l = d[leito] || {};
  const enf = enfermariaDoLeito(leito);

  document.getElementById('modal-adm-titulo').textContent = isNova
    ? `Admissão – ${enf.nome} · Leito ${pad(leito)}`
    : `Editar dados – ${enf.nome} · Leito ${pad(leito)}`;

  setF('m-pac', l.pac || '');
  setF('m-diag', l.diag || '');
  setF('m-dn', l.dn || '');
  setF('m-adm', l.adm || (isNova ? hoje() : ''));
  setF('m-adm-hosp', l.admHosp || '');
  setF('m-sexo', l.sexo || '');
  setF('m-origem', l.origem || '');
  setF('m-origem-outro', l.origemOutro || '');
  document.getElementById('m-origem-outro-wrap').style.display =
    l.origem === 'Transferência de outro serviço' ? 'flex' : 'none';
  setF('m-comor', l.comor || '');
  setF('m-alergia', l.alergia || '');

  // Botão de Alta no modal — só quando o leito está ocupado e estamos editando
  const btnAlta = document.getElementById('btn-alta-modal');
  btnAlta.style.display = (l.ocupado && !isNova) ? '' : 'none';

  document.getElementById('modal-adm').classList.add('show');
  _ativarCaixaAlta();
}

function fecharModalAdm(){
  document.getElementById('modal-adm').classList.remove('show');
}

async function salvarAdmissao(){
  const pac = gf('m-pac').trim();
  if (!pac) { toast('Informe o nome do paciente', true); return; }

  showLoading('Salvando...');
  try {
    const d = await leitosData();
    const l = d[leitoAtual] || {};
    const novaAdmissao = !modoEdicaoAdm && !l.ocupado;
    const origem = gf('m-origem');
    const origemOutro = gf('m-origem-outro').trim();

    d[leitoAtual] = {
      ocupado: true,
      pac:     pac.toUpperCase(),
      diag:    gf('m-diag').toUpperCase(),
      dn:      gf('m-dn'),
      adm:     gf('m-adm'),
      admHosp: gf('m-adm-hosp'),
      comor:   gf('m-comor').toUpperCase(),
      alergia: gf('m-alergia').toUpperCase(),
      sexo:    gf('m-sexo'),
      origem,
      origemOutro: origem === 'Transferência de outro serviço' ? origemOutro : '',
      admissaoRegistradaEm: l.admissaoRegistradaEm || new Date().toISOString()
    };
    await dbSet('cm_leitos', d);
    memDel('cm_leitos');

    if (novaAdmissao) {
      try {
        const log = (await dbGet('cm_admissao_log')) || [];
        log.push({
          leito: leitoAtual,
          paciente: d[leitoAtual].pac,
          diagnostico: d[leitoAtual].diag,
          dn: d[leitoAtual].dn,
          sexo: d[leitoAtual].sexo,
          admEnfermaria: d[leitoAtual].adm,
          admHospital:   d[leitoAtual].admHosp,
          origem, origemOutro,
          autor: usuarioEmail,
          registradoEm: new Date().toISOString()
        });
        await dbSet('cm_admissao_log', log);
      } catch(e) { console.warn('Log adm:', e); }
    }

    fecharModalAdm();
    toast(novaAdmissao ? '✓ Paciente admitido' : '✓ Dados atualizados');
    await renderLeitos();

    // Se é admissão nova → segue direto para a evolução
    if (novaAdmissao) {
      setTimeout(() => abrirForm(leitoAtual), 400);
    } else if (modoEdicaoAdm) {
      // Se estava editando a partir do formulário, atualiza os campos do form
      const enf = enfermariaDoLeito(leitoAtual);
      setF('f-pac',      d[leitoAtual].pac);
      setF('f-leito',    `Leito ${pad(leitoAtual)} – ${enf.nome}`);
      setF('f-dn',       d[leitoAtual].dn);
      setF('f-idade',    calcIdade(d[leitoAtual].dn));
      setF('f-diag',     d[leitoAtual].diag);
      setF('f-adm',      d[leitoAtual].adm);
      setF('f-adm-hosp', d[leitoAtual].admHosp);
      setF('f-comor',    d[leitoAtual].comor);
      setF('f-alergia',  d[leitoAtual].alergia);
    }
  } finally {
    hideLoading();
    modoEdicaoAdm = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ALTA — fluxo similar à UTI
// ══════════════════════════════════════════════════════════════════════════════
// Chamado da preview screen
async function confirmarAlta(){
  abrirModalAlta(leitoAtual);
}

// Chamado do botão "Alta" dentro do modal de admissão
async function darAltaPeloModal(){
  fecharModalAdm();
  abrirModalAlta(leitoAtual);
}

function abrirModalAlta(leito){
  leitoParaAlta = leito;
  document.getElementById('modal-alta-titulo').textContent = `🏥 Alta – Leito ${pad(leito)}`;
  setF('alta-tipo', '');
  setF('alta-destino', '');
  document.getElementById('alta-destino-wrap').style.display = 'none';
  setF('alta-data', hoje());
  const agora = new Date();
  setF('alta-hora', pad(agora.getHours()) + ':' + pad(agora.getMinutes()));
  setF('alta-obs', '');
  document.getElementById('modal-alta').classList.add('show');
  _ativarCaixaAlta();
}

function fecharModalAlta(){
  document.getElementById('modal-alta').classList.remove('show');
}

async function confirmarAltaFinal(){
  const tipo = gf('alta-tipo');
  const destino = gf('alta-destino').trim();
  const data = gf('alta-data');
  const hora = gf('alta-hora');
  const obs = gf('alta-obs').trim();

  if (!tipo) { toast('Selecione o tipo de alta', true); return; }
  if (tipo === 'Transferência para outro serviço' && !destino) {
    toast('Informe o destino da transferência', true); return;
  }
  if (!data || !hora) { toast('Informe data e hora da alta', true); return; }

  if (!confirm(`Confirmar alta do Leito ${pad(leitoParaAlta)}?\nEsta ação libera o leito.`)) return;

  showLoading('Registrando alta...');
  try {
    const d = await leitosData();
    const pacAntes = { ...d[leitoParaAlta] };

    try {
      const log = (await dbGet('cm_alta_log')) || [];
      log.push({
        leito: leitoParaAlta,
        paciente: pacAntes.pac || '',
        diagnostico: pacAntes.diag || '',
        dn: pacAntes.dn || '',
        sexo: pacAntes.sexo || '',
        admEnfermaria: pacAntes.adm || '',
        admHospital:   pacAntes.admHosp || '',
        origem: pacAntes.origem || '',
        origemOutro: pacAntes.origemOutro || '',
        tipoAlta: tipo,
        destino: tipo === 'Transferência para outro serviço' ? destino : '',
        dataAlta: data,
        horaAlta: hora,
        observacao: obs,
        autor: usuarioEmail,
        registradoEm: new Date().toISOString()
      });
      await dbSet('cm_alta_log', log);
    } catch(e) { console.warn('Log alta:', e); }

    // Libera o leito
    d[leitoParaAlta] = {
      ocupado:false, pac:'', diag:'', dn:'', adm:'', admHosp:'',
      comor:'', alergia:'', sexo:'', origem:'', origemOutro:''
    };
    await dbSet('cm_leitos', d);
    memDel('cm_leitos');

    // Apaga evoluções do dia (para não herdar dados na próxima admissão)
    await dbDelete(evKey(leitoParaAlta, 'DIURNO',  hoje()));
    await dbDelete(evKey(leitoParaAlta, 'NOTURNO', hoje()));

    fecharModalAlta();
    toast(`✓ ${tipo} registrada – Leito ${pad(leitoParaAlta)} liberado`);
    await irLeitos();
  } finally {
    hideLoading();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TRANSFERÊNCIA — mover paciente para outro leito (mesma enfermaria ou outra)
// ══════════════════════════════════════════════════════════════════════════════
async function prepararTransferencia(){
  const enf = enfermariaDoLeito(leitoAtual);
  const novoLeito = prompt(
    `Transferir "${gf('f-pac')}" do ${enf.nome} · Leito ${pad(leitoAtual)} para qual leito?\n\n(informe um número de 1 a ${TOTAL_LEITOS})`
  );
  if (!novoLeito) return;
  const dest = parseInt(novoLeito);
  if (isNaN(dest) || dest < 1 || dest > TOTAL_LEITOS) { toast('Leito inválido', true); return; }
  if (dest === leitoAtual) { toast('Destino igual à origem', true); return; }

  showLoading('Transferindo...');
  try {
    const ld = await leitosData();
    if (ld[dest] && ld[dest].ocupado) {
      hideLoading();
      toast('Leito ' + pad(dest) + ' já está ocupado', true);
      return;
    }

    // Move dados de admissão
    ld[dest] = { ...ld[leitoAtual] };
    ld[leitoAtual] = {
      ocupado:false, pac:'', diag:'', dn:'', adm:'', admHosp:'',
      comor:'', alergia:'', sexo:'', origem:'', origemOutro:''
    };
    await dbSet('cm_leitos', ld);
    memDel('cm_leitos');

    // Move evoluções do dia
    for (const t of ['DIURNO', 'NOTURNO']) {
      const ev = await dbGet(evKey(leitoAtual, t, hoje()));
      if (ev) {
        await dbSet(evKey(dest, t, hoje()), { ...ev, leito: dest });
        await dbDelete(evKey(leitoAtual, t, hoje()));
      }
    }

    leitoAtual = dest;
    toast(`✓ Transferido para Leito ${pad(dest)}`);
    await irLeitos();
  } catch(e) {
    console.error('transferência:', e);
    toast('Erro: ' + e.message, true);
  } finally {
    hideLoading();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CAIXA ALTA AUTOMÁTICA (mobile-safe via blur)
// ══════════════════════════════════════════════════════════════════════════════
function _ativarCaixaAlta(){
  document.querySelectorAll('input[type="text"], textarea').forEach(el => _ativarCaixaAltaEm(el));
}
function _ativarCaixaAltaEm(root){
  const aplicar = el => {
    if (el.dataset.ca === '1') return;
    el.dataset.ca = '1';
    if (el.readOnly) return;
    el.setAttribute('autocapitalize', 'characters');
    el.addEventListener('blur', () => {
      if (el.readOnly) return;
      const up = el.value.toUpperCase();
      if (el.value !== up) el.value = up;
    });
  };
  if (root.matches && root.matches('input[type="text"], textarea')) aplicar(root);
  if (root.querySelectorAll) {
    root.querySelectorAll('input[type="text"], textarea').forEach(aplicar);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// IMPRESSÃO EM LOTE — todas as evoluções do turno de uma ala
// ══════════════════════════════════════════════════════════════════════════════
async function imprimirLote(ala){
  const hj = hoje();
  const enfs = ala === 'todos' ? ENFERMARIAS
    : ENFERMARIAS.filter(e => e.ala === ala);
  const leitos = enfs.flatMap(e => e.leitos);

  showLoading('Carregando evoluções do turno...');
  try {
    const ld = await leitosData();
    const chaves = leitos
      .filter(n => ld[n]?.ocupado)
      .map(n => evKey(n, turno, hj));

    if (!chaves.length) {
      hideLoading();
      toast('Nenhum leito ocupado nesta ala', true);
      return;
    }

    const evs = await dbGetMany(chaves);
    const pares = leitos
      .filter(n => ld[n]?.ocupado && evs[evKey(n, turno, hj)])
      .map(n => ({ leito: n, pac: ld[n], ev: evs[evKey(n, turno, hj)] }));

    if (!pares.length) {
      hideLoading();
      toast('Nenhuma evolução preenchida neste turno', true);
      return;
    }

    // Monta HTML de todas as evoluções concatenadas para impressão
    let htmlTotal = '';
    for (const { leito, pac, ev } of pares) {
      const enf = enfermariaDoLeito(leito);
      ev.pac      = ev.pac      || pac.pac      || '';
      ev.diag     = ev.diag     || pac.diag     || '';
      ev.dn       = ev.dn       || pac.dn       || '';
      ev.adm      = ev.adm      || pac.adm      || '';
      ev.admHosp  = ev.admHosp  || pac.admHosp  || '';
      ev.comor    = ev.comor    || pac.comor    || '';
      ev.alergia  = ev.alergia  || pac.alergia  || '';
      ev.leito    = leito;
      ev.turno    = turno;
      // Gera HTML da evolução usando o mesmo _htmlEvolucao
      htmlTotal += _htmlEvolucaoLote(ev, enf, leito);
    }

    hideLoading();
    _abrirJanelaImpressao(htmlTotal, pares.length);

  } catch(e) {
    hideLoading();
    console.error('imprimirLote:', e);
    toast('Erro ao carregar evoluções: ' + e.message, true);
  }
}

function _htmlEvolucaoLote(d, enf, leitoNum){
  const tipoTurno = (d.turno||turno) === 'DIURNO' ? 'DIURNO (07h–19h)' : 'NOTURNO (19h–07h)';
  const listaCheck = arr => (arr && arr.length) ? arr.join(', ') : '—';

  const ventText = (() => {
    if (!d.vent) return '—';
    if (d.vent === 'Cateter nasal' && d.ventExtra?.cnLmin) return `${d.vent} ${d.ventExtra.cnLmin} L/min`;
    if (d.vent === 'Macronebulização' && d.ventExtra?.mvFio2) return `${d.vent} FiO₂ ${d.ventExtra.mvFio2}%`;
    if (d.vent === 'Máscara NR' && d.ventExtra?.mnrLmin) return `${d.vent} ${d.ventExtra.mnrLmin} L/min`;
    if (d.vent === 'VNI' && d.ventExtra?.vniTipo) return `${d.vent} (${d.ventExtra.vniTipo})`;
    return d.vent;
  })();

  const dietaText = (() => {
    if (!d.dieta) return '—';
    const v = d.dietaVaz || {};
    const k = d.dieta.toLowerCase();
    return v[k] ? `${d.dieta} – vazão ${v[k]}` : d.dieta;
  })();

  const hvText = (() => {
    const partes = [];
    if (d.hv && d.hv !== 'Nenhuma') {
      const v = d.hvVol || {};
      const vols = [v.m&&`M ${v.m}`, v.t&&`T ${v.t}`, v.n&&`N ${v.n}`].filter(Boolean);
      partes.push(d.hv + (vols.length ? ` – ${vols.join(' / ')} ml/h` : ''));
    }
    (d.infusoesExtras||[]).forEach(inf => { if (inf.nome) partes.push(inf.nome+(inf.vol?` ${inf.vol} ml/h`:'')); });
    return partes.length ? partes.join(' · ') : 'Nenhuma';
  })();

  const dispList = [];
  const dp = d.dispositivos || {};
  if (dp.avp?.marcado)   dispList.push(`AVP${dp.avp.local?` (${dp.avp.local})`:''}${dp.avp.data?` inst. ${fmtD(dp.avp.data)}`:''}`);
  if (dp.avc?.marcado)   dispList.push(`AVC${dp.avc.local?` (${dp.avc.local})`:''}${dp.avc.data?` inst. ${fmtD(dp.avc.data)}`:''}`);
  if (dp.cdl?.marcado)   dispList.push(`CDL${dp.cdl.local?` (${dp.cdl.local})`:''}${dp.cdl.data?` inst. ${fmtD(dp.cdl.data)}`:''}`);
  if (dp.drt?.marcado)   dispList.push(`Dreno tórax${dp.drt.lado?` ${dp.drt.lado}`:''}${dp.drt.deb?` déb: ${dp.drt.deb}`:''}`);
  if (dp.sne?.marcado)   dispList.push(dp.sne.tipo||'SNE/SNG');
  if (dp.cisto?.marcado) dispList.push('Cistostomia');
  if (dp.svd2?.marcado)  dispList.push('SVD');
  (d.dispExtras||[]).forEach(desc => { if (desc) dispList.push(desc); });

  const atbList = (d.atbs||[]).filter(a=>a.nome).map(a => {
    if (a.d0) {
      const diff = Math.round((new Date(hoje()+'T00:00:00') - new Date(a.d0+'T00:00:00')) / 86400000);
      return `${a.nome} (D0: ${fmtD(a.d0)} — D${diff>=0?diff:'?'})`;
    }
    return a.nome;
  });

  const bradMap = {a:'Risco ALTO', m:'Risco moderado', b:'Risco baixo'};
  const morseMap = {a:'Risco ALTO', m:'Risco moderado', b:'Risco baixo'};
  const fugMap = {i:'Intensivo', si:'Semi-intensivo', ad:'Alta dependência', itm:'Intermediário', cm:'Cuidado mínimo'};
  const bradCls  = d.bradClass  ? `${d.bradTotal} – ${bradMap[d.bradClass]||d.bradClass}` : 'Não avaliado';
  const morseCls = d.morseClass ? `${d.morseTotal} – ${morseMap[d.morseClass]||d.morseClass}` : 'Não avaliado';
  const fugCls   = d.fugClass   ? `${d.fugTotal} – ${fugMap[d.fugClass]||d.fugClass}` : 'Não avaliado';

  const campos = ['pa','fc','fr','spo2','tax','hgt'];
  const ssvvLabels = {pa:'PA',fc:'FC',fr:'FR',spo2:'SpO2',tax:'Tax',hgt:'HGT'};
  const ssvvTurnosLabel = {m:'Manhã',t:'Tarde',n:'Noite'};
  const ssvvHtml = (() => {
    if (!d.ssvv) return '';
    const linhas = ['m','t','n'].map(tr => {
      if (!d.ssvv[tr]) return '';
      const vals = campos.filter(c => d.ssvv[tr][c]).map(c => `${ssvvLabels[c]}: ${esc(d.ssvv[tr][c])}`);
      return vals.length ? `<div><strong>${ssvvTurnosLabel[tr]}:</strong> ${vals.join(' · ')}</div>` : '';
    }).filter(Boolean);
    return linhas.length ? linhas.join('') : '';
  })();

  return `
  <div class="evolucao-pagina">
    <div class="pv-head">
      <h2>Hospital dos Pescadores – Clínica Médica</h2>
      <h3>Evolução de Enfermagem</h3>
      <p>${esc(enf.nome)} · Leito ${pad(leitoNum)} · Turno ${tipoTurno} · ${fmtD(d.data || hoje())}</p>
    </div>
    <div class="pv-sec"><div class="pv-sec-t">Identificação</div><div class="pv-sec-c">
      <div class="pr"><span class="pl">Paciente:</span><span class="pv">${esc(d.pac)}</span></div>
      <div class="pr">
        <span class="pl">DN:</span><span class="pv">${fmtD(d.dn)||'—'}</span>
        <span class="pl">Idade:</span><span class="pv">${esc(d.idade||calcIdade(d.dn))||'—'}</span>
        <span class="pl">Adm. enfermaria:</span><span class="pv">${fmtD(d.adm)||'—'}</span>
        <span class="pl">Adm. HOSPESC:</span><span class="pv">${fmtD(d.admHosp)||'—'}</span>
      </div>
      <div class="pr"><span class="pl">Diagnóstico:</span><span class="pv">${esc(d.diag)||'—'}</span></div>
      <div class="pr"><span class="pl">Comorbidades:</span><span class="pv">${esc(d.comor)||'—'}</span></div>
      <div class="pr"><span class="pl">Alergias:</span><span class="pv">${esc(d.alergia)||'—'}</span>
        <span class="pl">Pulseira:</span><span class="pv">${esc(d.pulseira)||'—'}</span>
        <span class="pl">Isolamento:</span><span class="pv">${esc(d.iso)||'—'}${d.microorg?` (${esc(d.microorg)})`:''}</span>
      </div>
    </div></div>

    <div class="pv-sec"><div class="pv-sec-t">Neurológico / Pele</div><div class="pv-sec-c">
      <div>${listaCheck(d.neuro)}${d.glas?` · Glasgow ${esc(d.glas)}`:''}${d.reducao?` · Força: ${esc(d.reducao)}`:''} · Pupilas: ${listaCheck(d.pupilas)}</div>
      <div style="margin-top:2px;"><strong>Pele:</strong> ${listaCheck(d.pele)}${d.peleOutros?` · ${esc(d.peleOutros)}`:''}</div>
    </div></div>

    <div class="pv-sec"><div class="pv-sec-t">Respiratório / CV / Abdome</div><div class="pv-sec-c">
      <div>${listaCheck(d.torax)} · Ausculta: ${listaCheck(d.ap)}${d.apOutros?` · ${esc(d.apOutros)}`:''} · Vent: ${esc(ventText)}</div>
      <div style="margin-top:2px;"><strong>CV:</strong> ${listaCheck(d.cv)} · <strong>Abdome:</strong> ${listaCheck(d.abd)}</div>
    </div></div>

    <div class="pv-sec"><div class="pv-sec-t">Dieta / Diurese / Intest.</div><div class="pv-sec-c">
      <div><strong>Dieta:</strong> ${esc(dietaText)} · <strong>Diurese:</strong> ${listaCheck(d.diurese)}${d.diureseMl?.m||d.diureseMl?.t||d.diureseMl?.n?' Déb: M '+( d.diureseMl?.m||'—')+'/T '+(d.diureseMl?.t||'—')+'/N '+(d.diureseMl?.n||'—')+' ml':''}</div>
      <div style="margin-top:2px;"><strong>Intest.:</strong> ${listaCheck(d.intest)}</div>
    </div></div>

    ${dispList.length?`<div class="pv-sec"><div class="pv-sec-t">Dispositivos</div><div class="pv-sec-c">${dispList.join(' · ')}</div></div>`:''}

    <div class="pv-sec"><div class="pv-sec-t">HV / ATBs</div><div class="pv-sec-c">
      <div><strong>HV:</strong> ${esc(hvText)}</div>
      ${atbList.length?`<div style="margin-top:2px;"><strong>ATBs:</strong> ${atbList.join(' · ')}</div>`:''}
      ${d.eletrolitos?`<div style="margin-top:2px;"><strong>Eletrólitos:</strong> ${esc(d.eletrolitos)}</div>`:''}
    </div></div>

    ${ssvvHtml?`<div class="pv-sec"><div class="pv-sec-t">SSVV / HGT</div><div class="pv-sec-c">${ssvvHtml}</div></div>`:''}

    <div class="pv-sec"><div class="pv-sec-t">Escalas</div>
      <div style="border:1px solid black;border-top:none;">
        <div class="pv-escala primeira"><span>Braden — LPP</span><span>${bradCls}</span></div>
        <div class="pv-escala"><span>Morse — Queda</span><span>${morseCls}</span></div>
        <div class="pv-escala"><span>Fugulin — Complexidade</span><span>${fugCls}</span></div>
      </div>
    </div>

    ${d.obs?`<div class="pv-sec"><div class="pv-sec-t">Observações / Intercorrências</div><div class="pv-sec-c pv-textao">${esc(d.obs)}</div></div>`:''}

    <div class="pv-foot">${esc(d.autor)||'Enf.'} · ${new Date().toLocaleString('pt-BR')}</div>
  </div>`;
}

function _abrirJanelaImpressao(htmlConteudo, qtd){
  const estilos = Array.from(document.styleSheets)
    .flatMap(ss => { try { return Array.from(ss.cssRules).map(r=>r.cssText); } catch(e){ return []; } })
    .join('\n');

  const janela = window.open('', '_blank', 'width=900,height=700');
  janela.document.write(`<!DOCTYPE html><html lang="pt-BR"><head>
    <meta charset="UTF-8">
    <title>Evoluções CM – Turno ${turno} – ${fmtD(hoje())}</title>
    <style>
      ${estilos}
      body { background: white; margin: 0; padding: 0; font-family: 'IBM Plex Sans', sans-serif; }
      .evolucao-pagina { page-break-after: always; break-after: page; padding: 6mm; font-size: .66rem; }
      .evolucao-pagina:last-child { page-break-after: avoid; break-after: avoid; }
      .pv-head { text-align:center; padding:.4rem; border-bottom:2px solid #000; margin-bottom:0; }
      .pv-head h2 { font-size:.82rem; font-weight:800; text-transform:uppercase; margin:0; }
      .pv-head h3 { font-size:.7rem; font-weight:700; margin:1px 0; }
      .pv-head p  { font-size:.64rem; margin:0; }
      .pv-sec { margin:0; }
      .pv-sec-t { background:#1e8449; color:white; font-size:.58rem; font-weight:800;
        letter-spacing:.05em; text-transform:uppercase; padding:2px 7px;
        border:1px solid black; border-bottom:none; }
      .pv-sec-c { padding:3px 7px; border:1px solid black; border-top:none; font-size:.64rem; }
      .pv-sec-c .pr { display:flex; flex-wrap:wrap; gap:2px 10px; border-bottom:1px solid #ddd; padding:2px 0; }
      .pv-sec-c .pr:last-child { border-bottom:none; }
      .pv-sec-c .pl { color:#555; font-weight:700; font-size:.58rem; text-transform:uppercase; }
      .pv-sec-c .pv { font-weight:500; }
      .pv-textao { white-space:pre-wrap; word-break:break-word; line-height:1.4; }
      .pv-escala { display:flex; justify-content:space-between; padding:2px 7px;
        border-bottom:1px solid black; font-size:.62rem; }
      .pv-escala.primeira { }
      .pv-escala:last-child { border-bottom:none; }
      .pv-foot { border-top:2px solid #000; padding:.3rem .5rem;
        display:flex; justify-content:space-between; font-size:.6rem; color:#555; }
      @media print {
        .evolucao-pagina { page-break-after: always; break-after: page; }
        .evolucao-pagina:last-child { page-break-after: avoid; }
      }
    </style>
  </head><body>
    <div style="text-align:center;padding:6px 0;background:#1e8449;color:white;font-size:.75rem;font-weight:700;print-color-adjust:exact;">
      Clínica Médica – Hospital dos Pescadores · Turno ${turno} · ${fmtD(hoje())} · ${qtd} evolução(ões)
      <button onclick="window.print()" style="margin-left:16px;padding:3px 12px;background:white;color:#1e8449;border:none;border-radius:4px;font-weight:700;cursor:pointer;">🖨 Imprimir</button>
    </div>
    ${htmlConteudo}
  </body></html>`);
  janela.document.close();
}

document.addEventListener('DOMContentLoaded', () => {
  mostrarTela('t-login');
  document.getElementById('t-login').classList.add('ativa');

  if (!auth) { modoOffline = true; return; }

  auth.onAuthStateChanged(user => {
    if (user) {
      usuarioEmail = user.email;
      irTelaTurno();
    } else {
      mostrarTela('t-login');
    }
  });
});
