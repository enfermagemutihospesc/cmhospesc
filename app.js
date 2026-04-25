/* ══════════════════════════════════════════════════════════════
   SISTEMA CLÍNICA MÉDICA UTI – HOSPESC
   Chaves no Firestore (prefixo cm_):
     cm_leitos                      → estado dos 34 leitos
     cm_ev_<leito>_<turno>_<data>  → evolução
     cm_admissao_log                → log de admissões (futuro uso)
     cm_alta_log                    → log de altas (futuro uso)
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

// Cache em memória da sessão — evita chamadas repetidas ao Firestore
const memCache = {};
function memSet(key, val){ memCache[key] = val; }
function memGet(key){ return key in memCache ? memCache[key] : undefined; }
function memDel(key){ delete memCache[key]; }

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

// ── DB (mesmo formato da UTI: {value, updatedAt}) ────────────────────────────
async function dbGet(key){
  // 1) cache em memória (mais rápido)
  const mem = memGet(key);
  if (mem !== undefined) return mem;
  // 2) localStorage (síncrono, sem rede)
  const cached = localStorage.getItem(key);
  const cachedVal = cached ? (() => { try { return JSON.parse(cached); } catch(e){ return undefined; } })() : undefined;
  // Retorna o cache local imediatamente se disponível e vai buscar Firestore em background
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
    }).catch(e => { console.warn('dbGet firestore:', e); return cachedVal ?? null; });
    // Se já tem cache local, retorna imediato e deixa o Firestore atualizar em background
    if (cachedVal !== undefined) { fsPromise; return cachedVal; }
    // Sem cache: espera o Firestore
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
    } catch(e) { console.warn('dbSet firestore:', e); }
  }
}

// Busca múltiplas chaves em paralelo (uma única ida ao Firestore por chave, todas simultâneas)
async function dbGetMany(keys){
  if (!keys.length) return {};
  // Primeiro verifica quais já estão em memória/localStorage
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
  // Busca o que falta no Firestore em paralelo
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
  // Preenche nulls para keys não encontradas
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
    // Inicializa com 34 leitos vagos
    d = {};
    for (let i = 1; i <= TOTAL_LEITOS; i++) {
      d[i] = { ocupado:false, pac:'', diag:'', dn:'', adm:'', admHosp:'', comor:'', alergia:'' };
    }
    await dbSet('cm_leitos', d);
  }
  return d;
}

// ── NAVEGAÇÃO ────────────────────────────────────────────────────────────────
function mostrarTela(id){
  document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa'));
  ['t-login','t-turno'].forEach(tid => {
    const el = document.getElementById(tid);
    if (el) el.style.display = 'none';
  });
  const el = document.getElementById(id);
  if (!el) return;
  if (['t-login','t-turno'].includes(id)) el.style.display = 'flex';
  else el.classList.add('ativa');
}

function irTelaTurno(){
  mostrarTela('t-turno');
  const dot = document.getElementById('sync-dot');
  const txt = document.getElementById('sync-txt');
  if (modoOffline) {
    dot.className = 'sync-dot err';
    txt.textContent = 'modo offline – dados locais';
  } else {
    dot.className = 'sync-dot ok';
    txt.textContent = 'conectado ao Firebase';
  }
}
function irTurno(){ irTelaTurno(); }
function irLeitos(){ mostrarTela('t-leitos'); renderLeitos(); window.scrollTo(0,0); }

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
  mostrarTela('t-leitos');
  const b = document.getElementById('badge-leitos');
  b.textContent = t === 'DIURNO' ? '☀ DIURNO' : '☽ NOTURNO';
  b.className = 'badge ' + (t === 'DIURNO' ? 'badge-d' : 'badge-n');
  document.getElementById('badge-user').textContent = usuarioEmail
    ? '👤 ' + usuarioEmail.split('@')[0] + ' · Sair'
    : 'Sair';
  await renderLeitos();
}

// ── RENDER LEITOS — agrupados por enfermaria ─────────────────────────────────
async function renderLeitos(){
  const wrap = document.getElementById('enfermarias-wrap');
  wrap.innerHTML = '';
  const d = await leitosData();
  const hj = hoje();

  // Coleta todas as chaves de evolução dos leitos ocupados de uma vez
  const leitos = ENFERMARIAS.flatMap(e => e.leitos);
  const chaves = leitos
    .filter(num => d[num]?.ocupado)
    .map(num => evKey(num, turno, hj));

  // Busca todas em paralelo — uma única rodada de I/O
  const evs = await dbGetMany(chaves);

  for (const enf of ENFERMARIAS) {
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
      card.onclick = () => abrirModalLeito(num);

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

// ── MODAL AÇÃO DO LEITO ──────────────────────────────────────────────────────
async function abrirModalLeito(leito){
  leitoAtual = leito;
  const d = await leitosData();
  const l = d[leito];
  const enf = enfermariaDoLeito(leito);
  const tit = `${enf.nome} – Leito ${pad(leito)}`;
  document.getElementById('modal-leito-titulo').textContent = tit;

  const info = document.getElementById('modal-leito-info');
  const btnAlta = document.getElementById('btn-dar-alta');
  const btnEdit = document.getElementById('btn-editar-adm');

  if (l && l.ocupado) {
    info.innerHTML = `<strong>${esc(l.pac)}</strong><br>${esc(l.diag||'(sem diagnóstico)')}
      ${l.adm?`<br><small>Admitido em ${fmtD(l.adm)}</small>`:''}`;
    btnAlta.style.display = '';
    btnEdit.style.display = '';
  } else {
    info.innerHTML = '<em style="color:var(--muted);">Leito vago. Ao abrir a evolução será solicitada a admissão do paciente.</em>';
    btnAlta.style.display = 'none';
    btnEdit.style.display = 'none';
  }
  document.getElementById('modal-leito').classList.add('show');
}

function fecharModalLeito(){
  document.getElementById('modal-leito').classList.remove('show');
}

async function acaoEvoluir(){
  fecharModalLeito();
  const d = await leitosData();
  const l = d[leitoAtual];
  if (!l || !l.ocupado) {
    modoEdicaoAdm = false;
    abrirModalAdm(leitoAtual, true);
    return;
  }
  abrirForm(leitoAtual);
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

// ── BRADEN ──
const BRADEN_ITENS = [
  { id:'b1', label:'Percepção sensorial', ops:[
    {pt:1, tx:'Totalmente limitado'},
    {pt:2, tx:'Muito limitado'},
    {pt:3, tx:'Levemente limitado'},
    {pt:4, tx:'Nenhuma limitação'}
  ]},
  { id:'b2', label:'Umidade', ops:[
    {pt:1, tx:'Excessiva'},
    {pt:2, tx:'Muita'},
    {pt:3, tx:'Ocasional'},
    {pt:4, tx:'Rara'}
  ]},
  { id:'b3', label:'Atividade', ops:[
    {pt:1, tx:'Acamado'},
    {pt:2, tx:'Confinado a cadeira'},
    {pt:3, tx:'Deambula ocasionalmente'},
    {pt:4, tx:'Deambula frequentemente'}
  ]},
  { id:'b4', label:'Mobilidade', ops:[
    {pt:1, tx:'Imóvel'},
    {pt:2, tx:'Muito limitado'},
    {pt:3, tx:'Discreta limitação'},
    {pt:4, tx:'Sem limitação'}
  ]},
  { id:'b5', label:'Nutrição', ops:[
    {pt:1, tx:'Deficiente'},
    {pt:2, tx:'Inadequada'},
    {pt:3, tx:'Adequada'},
    {pt:4, tx:'Excelente'}
  ]},
  { id:'b6', label:'Fricção e cisalhamento', ops:[
    {pt:1, tx:'Problema'},
    {pt:2, tx:'Problema potencial'},
    {pt:3, tx:'Sem problema'}
  ]}
];

// ── MORSE ──
const MORSE_ITENS = [
  { id:'m1', label:'Histórico de quedas', ops:[
    {pt:0, tx:'Não'},
    {pt:25, tx:'Sim'}
  ]},
  { id:'m2', label:'Diagnóstico secundário', ops:[
    {pt:0, tx:'Não'},
    {pt:15, tx:'Sim'}
  ]},
  { id:'m3', label:'Auxílio na deambulação', ops:[
    {pt:0, tx:'Nenhum / acamado / auxiliado por profissional'},
    {pt:15, tx:'Muletas / bengala / andador'},
    {pt:30, tx:'Mobiliário / parede'}
  ]},
  { id:'m4', label:'Terapia endovenosa / dispositivo EV', ops:[
    {pt:0, tx:'Não'},
    {pt:20, tx:'Sim'}
  ]},
  { id:'m5', label:'Marcha', ops:[
    {pt:0, tx:'Normal / sem deambulação / acamado / cadeira de rodas'},
    {pt:10, tx:'Fraca'},
    {pt:20, tx:'Comprometida'}
  ]},
  { id:'m6', label:'Estado mental', ops:[
    {pt:0, tx:'Orientado / capaz quanto a sua capacidade/limitação'},
    {pt:15, tx:'Superestima capacidade / esquece limitações'}
  ]}
];

// ── FUGULIN AMPLIADA ──
const FUGULIN_ITENS = [
  { id:'f1',  label:'Estado mental', ops:[
    {pt:4, tx:'Inconsciente'},
    {pt:3, tx:'Períodos de inconsciência'},
    {pt:2, tx:'Períodos de desorientação no tempo/espaço'},
    {pt:1, tx:'Orientação no tempo e espaço'}
  ]},
  { id:'f2',  label:'Oxigenação', ops:[
    {pt:4, tx:'Ventilação mecânica'},
    {pt:3, tx:'Uso contínuo de O2'},
    {pt:2, tx:'Uso intermitente de O2'},
    {pt:1, tx:'Não depende de O2'}
  ]},
  { id:'f3',  label:'Sinais vitais', ops:[
    {pt:4, tx:'Controle ≤ 2/2 horas'},
    {pt:3, tx:'Controle até 4/4 horas'},
    {pt:2, tx:'Controle entre 4/6 horas'},
    {pt:1, tx:'Controle 8/8 horas'}
  ]},
  { id:'f4',  label:'Motilidade', ops:[
    {pt:4, tx:'Incapaz de movimentar qualquer segmento'},
    {pt:3, tx:'Dificuldade de movimentar segmentos'},
    {pt:2, tx:'Limitação de movimentos'},
    {pt:1, tx:'Movimenta todos os segmentos'}
  ]},
  { id:'f5',  label:'Deambulação', ops:[
    {pt:4, tx:'Restrito ao leito'},
    {pt:3, tx:'Locomoção por cadeira de rodas'},
    {pt:2, tx:'Necessita auxílio para deambular'},
    {pt:1, tx:'Ambulante'}
  ]},
  { id:'f6',  label:'Alimentação', ops:[
    {pt:4, tx:'Por cateter central'},
    {pt:3, tx:'Por SNG'},
    {pt:2, tx:'Por boca com auxílio'},
    {pt:1, tx:'Autossuficiente'}
  ]},
  { id:'f7',  label:'Cuidado corporal', ops:[
    {pt:4, tx:'Banho no leito e higiene oral pela enfermagem'},
    {pt:3, tx:'Banho no chuveiro e higiene oral pela enfermagem'},
    {pt:2, tx:'Auxílio no banho e/ou higiene oral'},
    {pt:1, tx:'Autossuficiente'}
  ]},
  { id:'f8',  label:'Eliminação', ops:[
    {pt:4, tx:'Eliminação no leito e uso de SVD'},
    {pt:3, tx:'Uso de comadre ou eliminação no leito'},
    {pt:2, tx:'Uso de vaso sanitário com auxílio'},
    {pt:1, tx:'Autossuficiente'}
  ]},
  { id:'f9',  label:'Terapêutica', ops:[
    {pt:4, tx:'Uso de drogas vasoativas EV contínua'},
    {pt:3, tx:'VO por SNG'},
    {pt:2, tx:'EV intermitente'},
    {pt:1, tx:'IM ou VO'}
  ]},
  { id:'f10', label:'Comprometimento tecidual', ops:[
    {pt:4, tx:'Até tendões/cápsulas, eviscerações'},
    {pt:3, tx:'Tecido subcutâneo e músculo, incisão cirúrgica, ostomias, dreno'},
    {pt:2, tx:'Alteração de cor (equimoses, hiperemia) e/ou epiderme/derme'},
    {pt:1, tx:'Pele íntegra'}
  ]},
  { id:'f11', label:'Curativo', ops:[
    {pt:4, tx:'3 vezes ao dia ou mais'},
    {pt:3, tx:'2 vezes ao dia'},
    {pt:2, tx:'1 vez ao dia'},
    {pt:1, tx:'Sem curativo'}
  ]},
  { id:'f12', label:'Tempo de curativos', ops:[
    {pt:4, tx:'Superior a 30 minutos'},
    {pt:3, tx:'Entre 15 e 30 minutos'},
    {pt:2, tx:'Entre 5 e 15 minutos'},
    {pt:1, tx:'Sem curativo'}
  ]}
];

// ══════════════════════════════════════════════════════════════════════════════
// ABRIR FORMULÁRIO
// ══════════════════════════════════════════════════════════════════════════════
async function abrirForm(leito){
  leitoAtual = leito;
  showLoading('Carregando evolução...');
  try {
    const d = await leitosData();
    const l = d[leito];
    const enf = enfermariaDoLeito(leito);

    // Monta os checkboxes e escalas (só na primeira vez)
    _montarCheckboxes();
    _montarMedidasPrev();
    _montarEscalas();

    // Preenche identificação (readonly)
    setF('f-pac', l.pac || '');
    setF('f-leito', pad(leito));
    setF('f-diag', (l.diag || '').toUpperCase());
    setF('f-dn', l.dn || '');
    setF('f-adm', l.adm || '');
    setF('f-comor', (l.comor || '').toUpperCase());

    // Calcula idade
    if (l.dn) {
      const [y,m,dd] = l.dn.split('-').map(Number);
      const dn = new Date(y, m-1, dd);
      const hj = new Date();
      let idade = hj.getFullYear() - dn.getFullYear();
      if (hj.getMonth() < dn.getMonth() || (hj.getMonth() === dn.getMonth() && hj.getDate() < dn.getDate())) idade--;
      setF('f-idade', idade + ' anos');
    } else setF('f-idade', '');

    setF('f-data', hoje());
    setF('f-alergia', (l.alergia || '').toUpperCase());

    // Carrega evolução existente ou limpa campos
    const ev = await dbGet(evKey(leito, turno, hoje()));
    if (ev) {
      _carregarDadosForm(ev);
      toast('📄 Evolução deste turno carregada');
    } else {
      _limparCamposEditaveis();
      await _herdarCamposAnterior(leito);
    }

    // Atualiza cabeçalho
    document.getElementById('form-sub').textContent = `${enf.nome} · Leito ${pad(leito)} · ${turno === 'DIURNO' ? 'Diurno' : 'Noturno'} · ${fmtD(hoje())}`;
    const b = document.getElementById('badge-form');
    b.textContent = turno === 'DIURNO' ? '☀ DIURNO' : '☽ NOTURNO';
    b.className = 'badge ' + (turno === 'DIURNO' ? 'badge-d' : 'badge-n');

    _atualizarTotaisEscalas();
    _ativarCaixaAltaForm();
    mostrarTela('t-form');
    window.scrollTo(0, 0);
  } finally {
    hideLoading();
  }
}

function irForm(){ mostrarTela('t-form'); window.scrollTo(0,0); }

// ── CONSTRUÇÃO DOS CAMPOS DINÂMICOS ──────────────────────────────────────────
function _montarCheckboxes(){
  const m = (id, arr, prefix) => {
    const el = document.getElementById(id);
    if (el.dataset.montado) return;
    el.innerHTML = arr.map(item => {
      const key = prefix + '-' + item.replace(/[^a-zA-Z0-9]/g, '_');
      return `<label><input type="checkbox" id="${key}"> ${item}</label>`;
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
  if (cont.dataset.montado) return;
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
  _montarEscala('braden-itens',  BRADEN_ITENS,  'brad',  _atualizarTotaisEscalas);
  _montarEscala('morse-itens',   MORSE_ITENS,   'morse', _atualizarTotaisEscalas);
  _montarEscala('fugulin-itens', FUGULIN_ITENS, 'fug',   _atualizarTotaisEscalas);
}

function _montarEscala(containerId, itens, prefix, onChange){
  const cont = document.getElementById(containerId);
  if (cont.dataset.montado) return;
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

// ── ATUALIZAÇÃO DE TOTAIS DAS ESCALAS ────────────────────────────────────────
function _atualizarTotaisEscalas(){
  // Braden: soma 6 itens (de 1-4 cada = 3 a 23)
  // Classificação: ≤11 = alto; 12-14 = moderado; 15-16 = baixo; >16 = sem risco
  const brad = _totalEscala(BRADEN_ITENS, 'brad');
  let bLabel = 'Não avaliado', bClass = '';
  if (brad.total > 0 && brad.respondidos === BRADEN_ITENS.length) {
    if (brad.total <= 11)       { bLabel = 'Risco ALTO';      bClass = 'a'; }
    else if (brad.total <= 14)  { bLabel = 'Risco moderado';  bClass = 'm'; }
    else if (brad.total <= 16)  { bLabel = 'Risco baixo';     bClass = 'b'; }
    else                         { bLabel = 'Sem risco';       bClass = 'b'; }
  }
  document.getElementById('brad-total').textContent = brad.total > 0 ? brad.total : '–';
  document.getElementById('brad-label').textContent = bLabel;

  // Morse: 0-125 (alguns máx. 125 se tudo no máx.)
  // 0-24 baixo; 25-44 moderado; ≥45 alto
  const morse = _totalEscala(MORSE_ITENS, 'morse');
  let mLabel = 'Não avaliado', mClass = '';
  if (morse.respondidos === MORSE_ITENS.length) {
    if (morse.total >= 45)      { mLabel = 'Risco ALTO';      mClass = 'a'; }
    else if (morse.total >= 25) { mLabel = 'Risco moderado';  mClass = 'm'; }
    else                         { mLabel = 'Risco baixo';     mClass = 'b'; }
  }
  document.getElementById('morse-total').textContent = morse.total >= 0 && morse.respondidos === MORSE_ITENS.length ? morse.total : '–';
  document.getElementById('morse-label').textContent = mLabel;

  // Fugulin (12 itens × 1-4): total 12-48
  // >34 Intensivo; 29-34 Semi-I; 23-28 Alta dep; 18-22 Interm; 12-17 Mín
  const fug = _totalEscala(FUGULIN_ITENS, 'fug');
  let fLabel = 'Não avaliado', fClass = '';
  if (fug.respondidos === FUGULIN_ITENS.length) {
    if (fug.total > 34)         { fLabel = 'Intensivo';        fClass = 'i'; }
    else if (fug.total >= 29)   { fLabel = 'Semi-intensivo';   fClass = 'si'; }
    else if (fug.total >= 23)   { fLabel = 'Alta dependência'; fClass = 'ad'; }
    else if (fug.total >= 18)   { fLabel = 'Intermediário';    fClass = 'itm'; }
    else                         { fLabel = 'Cuidado mínimo';   fClass = 'cm'; }
  }
  document.getElementById('fug-total').textContent = fug.respondidos === FUGULIN_ITENS.length ? fug.total : '–';
  document.getElementById('fug-label').textContent = fLabel;

  // Marca visual do item selecionado
  document.querySelectorAll('.escala-op').forEach(l => {
    l.classList.toggle('sel', l.querySelector('input').checked);
  });
}

function _totalEscala(itens, prefix){
  let total = 0, respondidos = 0;
  for (const item of itens) {
    const r = document.querySelector(`input[name="${prefix}-${item.id}"]:checked`);
    // Atualiza display individual
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

// ── ATB ──────────────────────────────────────────────────────────────────────
function addAtb(nome='', dias=''){
  const cont = document.getElementById('f-atb-list');
  const row = document.createElement('div');
  row.className = 'atb-row';
  row.innerHTML = `
    <input type="text" placeholder="Nome do antimicrobiano" value="${esc(nome)}">
    <span style="font-size:.72rem;color:var(--muted);">D</span>
    <input type="number" placeholder="dias" value="${dias||''}" min="1">
    <button class="rm" onclick="this.parentElement.remove()" title="Remover">×</button>
  `;
  cont.appendChild(row);
  _ativarCaixaAltaEm(row);
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
    'f-sne-data','f-cisto-data','f-svd2-data','f-disp-outro',
    'f-hv-m','f-hv-t','f-hv-n',
    'f-eletr','f-lesoes','f-ex-feitos','f-ex-sol','f-ex-prep','f-nir',
    'f-ssvv-m','f-ssvv-t','f-ssvv-n','f-info','f-obs','f-glas'
  ];
  textIds.forEach(id => setF(id, ''));

  // Checkboxes
  document.querySelectorAll('#t-form input[type="checkbox"]').forEach(cb => cb.checked = false);
  // Radios
  document.querySelectorAll('#t-form input[type="radio"]').forEach(r => r.checked = false);
  // Selects
  ['f-pulseira','f-vni-tipo','f-avc-curat','f-drt-lado','f-sne-tipo'].forEach(id => setF(id, ''));
  // ATB
  document.getElementById('f-atb-list').innerHTML = '';
}

// ── HERANÇA DE CAMPOS ENTRE TURNOS ───────────────────────────────────────────
async function _herdarCamposAnterior(leito){
  // Busca evolução anterior (outro turno de hoje OU último turno de ontem)
  const outro = turno === 'DIURNO' ? 'NOTURNO' : 'DIURNO';
  let ev = await dbGet(evKey(leito, outro, hoje()));
  if (!ev) {
    const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
    const ontemStr = ontem.getFullYear()+'-'+pad(ontem.getMonth()+1)+'-'+pad(ontem.getDate());
    ev = await dbGet(evKey(leito, 'NOTURNO', ontemStr))
      || await dbGet(evKey(leito, 'DIURNO', ontemStr));
  }
  if (!ev) return;

  // Herda: isolamento, pupilas, ventilação, dispositivos, ATBs, medidas preventivas, escalas
  // NÃO herda: SSVV, observações, lesões, exames
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
  // Dispositivos
  if (ev.dispositivos) {
    const disp = ev.dispositivos;
    ['avp','avc','cdl','drt','sne','cisto','svd2','outro'].forEach(k => {
      if (disp[k] && disp[k].marcado) document.getElementById('d-' + k).checked = true;
    });
    if (disp.avp)  { setF('f-avp-local', disp.avp.local); setF('f-avp-data', disp.avp.data); }
    if (disp.avc)  { setF('f-avc-local', disp.avc.local); setF('f-avc-curat', disp.avc.curat); setF('f-avc-data', disp.avc.data); }
    if (disp.cdl)  { setF('f-cdl-local', disp.cdl.local); setF('f-cdl-data', disp.cdl.data); }
    if (disp.drt)  { setF('f-drt-lado', disp.drt.lado); setF('f-drt-ins', disp.drt.ins); }
    if (disp.sne)  { setF('f-sne-tipo', disp.sne.tipo); setF('f-sne-data', disp.sne.data); }
    if (disp.cisto){ setF('f-cisto-data', disp.cisto.data); }
    if (disp.svd2) { setF('f-svd2-data', disp.svd2.data); }
    if (disp.outro){ setF('f-disp-outro', disp.outro.desc); }
  }
  // ATBs
  (ev.atbs || []).forEach(a => { if (a.nome) addAtb(a.nome, a.dias); });
  // Dieta
  if (ev.dieta) _marcaRadio('dieta', ev.dieta);
  // Hidratação venosa
  if (ev.hv) _marcaRadio('hv', ev.hv);
  // SVD instalada
  if (ev.svdInstaladaEm) setF('f-svd-data', ev.svdInstaladaEm);
  // Medidas preventivas
  if (ev.medidasPrev) {
    Object.entries(ev.medidasPrev).forEach(([k, v]) => {
      const r = document.querySelector(`input[name="${k}"][value="${v}"]`);
      if (r) r.checked = true;
    });
  }
  // Escalas
  _aplicarEscala(BRADEN_ITENS, 'brad',  ev.braden);
  _aplicarEscala(MORSE_ITENS,  'morse', ev.morse);
  _aplicarEscala(FUGULIN_ITENS,'fug',   ev.fugulin);
  // Pulseira
  if (ev.pulseira) setF('f-pulseira', ev.pulseira);
  // Alergia já vem do cabeçalho (readonly)

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

// ── COLETA DE DADOS ──────────────────────────────────────────────────────────
function _coletarDados(){
  const getChks = (arr, prefix) => arr.filter(v => {
    const id = prefix + '-' + v.replace(/[^a-zA-Z0-9]/g, '_');
    return document.getElementById(id)?.checked;
  });
  const getRadio = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';

  // Medidas preventivas
  const medidasPrev = {};
  MEDIDAS_PREV.forEach(m => {
    const v = document.querySelector(`input[name="${m.id}"]:checked`);
    if (v) medidasPrev[m.id] = v.value;
  });

  // Escalas
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

  // Totais e classes (para badges no painel)
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

  // ATBs
  const atbs = [];
  document.querySelectorAll('#f-atb-list .atb-row').forEach(row => {
    const nome = row.querySelector('input[type="text"]').value.trim();
    const dias = row.querySelector('input[type="number"]').value;
    if (nome) atbs.push({ nome, dias });
  });

  // Dispositivos
  const dispositivos = {
    avp:   { marcado:document.getElementById('d-avp').checked,   local:gf('f-avp-local'), data:gf('f-avp-data') },
    avc:   { marcado:document.getElementById('d-avc').checked,   local:gf('f-avc-local'), curat:gf('f-avc-curat'), data:gf('f-avc-data') },
    cdl:   { marcado:document.getElementById('d-cdl').checked,   local:gf('f-cdl-local'), data:gf('f-cdl-data') },
    drt:   { marcado:document.getElementById('d-drt').checked,   lado:gf('f-drt-lado'), ins:gf('f-drt-ins'), deb:gf('f-drt-deb') },
    sne:   { marcado:document.getElementById('d-sne').checked,   tipo:gf('f-sne-tipo'), data:gf('f-sne-data') },
    cisto: { marcado:document.getElementById('d-cisto').checked, data:gf('f-cisto-data') },
    svd2:  { marcado:document.getElementById('d-svd2').checked,  data:gf('f-svd2-data') },
    outro: { marcado:document.getElementById('d-outro').checked, desc:gf('f-disp-outro') }
  };

  return {
    leito: leitoAtual,
    turno,
    data: gf('f-data'),
    pac: gf('f-pac'),
    diag: gf('f-diag'),
    dn: gf('f-dn'),
    idade: gf('f-idade'),
    adm: gf('f-adm'),
    comor: gf('f-comor'),
    alergia: gf('f-alergia'),
    pulseira: gf('f-pulseira'),
    iso: getRadio('iso'),
    microorg: gf('f-microorg'),
    pele: getChks(CHK_PELE, 'pele'),
    peleOutros: gf('f-pele-outros'),
    neuro: getChks(CHK_NEURO, 'neuro'),
    glas: gf('f-glas'),
    reducao: gf('f-reducao'),
    pupilas: getChks(CHK_PUPILAS, 'pup'),
    torax: getChks(CHK_TORAX, 'tor'),
    ap: getChks(CHK_AP, 'ap'),
    apOutros: gf('f-ap-outros'),
    vent: getRadio('vent'),
    ventExtra: {
      cnLmin:  gf('f-cn-lmin'),
      mvFio2:  gf('f-mv-fio2'),
      mnrLmin: gf('f-mnr-lmin'),
      vniTipo: gf('f-vni-tipo')
    },
    cv: getChks(CHK_CV, 'cv'),
    abd: getChks(CHK_ABD, 'abd'),
    dieta: getRadio('dieta'),
    dietaVaz: {
      sne: gf('f-sne-vaz'), soe: gf('f-soe-vaz'),
      sng: gf('f-sng-vaz'), npt: gf('f-npt-vaz'), gtm: gf('f-gtm-vaz')
    },
    diurese: getChks(CHK_DIURESE, 'diu'),
    svdInstaladaEm: gf('f-svd-data'),
    diureseMl: { m:gf('f-diur-m'), t:gf('f-diur-t'), n:gf('f-diur-n') },
    intest: getChks(CHK_INTEST, 'int'),
    dispositivos,
    hv: getRadio('hv'),
    hvVol: { m:gf('f-hv-m'), t:gf('f-hv-t'), n:gf('f-hv-n') },
    atbs,
    eletrolitos: gf('f-eletr'),
    medidasPrev,
    lesoes: gf('f-lesoes'),
    exFeitos: gf('f-ex-feitos'),
    exSol: gf('f-ex-sol'),
    nir: gf('f-nir'),
    exPrep: gf('f-ex-prep'),
    ssvv: { m:gf('f-ssvv-m'), t:gf('f-ssvv-t'), n:gf('f-ssvv-n') },
    info: gf('f-info'),
    obs: gf('f-obs'),

    // Escalas
    braden, bradTotal: bradT, bradClass, bradLabel,
    morse,  morseTotal: morseT, morseClass, morseLabel,
    fugulin,fugTotal: fugT, fugClass, fugLabel,

    autor: usuarioEmail,
    criadoEm: new Date().toISOString()
  };
}

function _carregarDadosForm(d){
  setF('f-data', d.data || hoje());
  setF('f-alergia', d.alergia || '');
  setF('f-pulseira', d.pulseira || '');

  if (d.iso) _marcaRadio('iso', d.iso);
  setF('f-microorg', d.microorg || '');

  (d.pele    || []).forEach(v => _marcaCheck('pele-'  + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.neuro   || []).forEach(v => _marcaCheck('neuro-' + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.pupilas || []).forEach(v => _marcaCheck('pup-'   + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.torax   || []).forEach(v => _marcaCheck('tor-'   + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.ap      || []).forEach(v => _marcaCheck('ap-'    + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.cv      || []).forEach(v => _marcaCheck('cv-'    + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.abd     || []).forEach(v => _marcaCheck('abd-'   + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.diurese || []).forEach(v => _marcaCheck('diu-'   + v.replace(/[^a-zA-Z0-9]/g, '_'), true));
  (d.intest  || []).forEach(v => _marcaCheck('int-'   + v.replace(/[^a-zA-Z0-9]/g, '_'), true));

  setF('f-pele-outros', d.peleOutros);
  setF('f-glas', d.glas);
  setF('f-reducao', d.reducao);
  setF('f-ap-outros', d.apOutros);

  if (d.vent) _marcaRadio('vent', d.vent);
  if (d.ventExtra) {
    setF('f-cn-lmin',  d.ventExtra.cnLmin);
    setF('f-mv-fio2',  d.ventExtra.mvFio2);
    setF('f-mnr-lmin', d.ventExtra.mnrLmin);
    setF('f-vni-tipo', d.ventExtra.vniTipo);
  }

  if (d.dieta) _marcaRadio('dieta', d.dieta);
  if (d.dietaVaz) {
    setF('f-sne-vaz', d.dietaVaz.sne); setF('f-soe-vaz', d.dietaVaz.soe);
    setF('f-sng-vaz', d.dietaVaz.sng); setF('f-npt-vaz', d.dietaVaz.npt);
    setF('f-gtm-vaz', d.dietaVaz.gtm);
  }

  setF('f-svd-data', d.svdInstaladaEm);
  if (d.diureseMl) {
    setF('f-diur-m', d.diureseMl.m); setF('f-diur-t', d.diureseMl.t); setF('f-diur-n', d.diureseMl.n);
  }

  if (d.dispositivos) {
    const disp = d.dispositivos;
    ['avp','avc','cdl','drt','sne','cisto','svd2','outro'].forEach(k => {
      document.getElementById('d-' + k).checked = !!(disp[k] && disp[k].marcado);
    });
    if (disp.avp)   { setF('f-avp-local', disp.avp.local); setF('f-avp-data', disp.avp.data); }
    if (disp.avc)   { setF('f-avc-local', disp.avc.local); setF('f-avc-curat', disp.avc.curat); setF('f-avc-data', disp.avc.data); }
    if (disp.cdl)   { setF('f-cdl-local', disp.cdl.local); setF('f-cdl-data', disp.cdl.data); }
    if (disp.drt)   { setF('f-drt-lado', disp.drt.lado); setF('f-drt-ins', disp.drt.ins); setF('f-drt-deb', disp.drt.deb); }
    if (disp.sne)   { setF('f-sne-tipo', disp.sne.tipo); setF('f-sne-data', disp.sne.data); }
    if (disp.cisto) { setF('f-cisto-data', disp.cisto.data); }
    if (disp.svd2)  { setF('f-svd2-data', disp.svd2.data); }
    if (disp.outro) { setF('f-disp-outro', disp.outro.desc); }
  }

  if (d.hv) _marcaRadio('hv', d.hv);
  if (d.hvVol) { setF('f-hv-m', d.hvVol.m); setF('f-hv-t', d.hvVol.t); setF('f-hv-n', d.hvVol.n); }

  document.getElementById('f-atb-list').innerHTML = '';
  (d.atbs || []).forEach(a => addAtb(a.nome, a.dias));

  setF('f-eletr', d.eletrolitos);
  setF('f-lesoes', d.lesoes);
  setF('f-ex-feitos', d.exFeitos);
  setF('f-ex-sol', d.exSol);
  setF('f-nir', d.nir);
  setF('f-ex-prep', d.exPrep);
  if (d.ssvv) { setF('f-ssvv-m', d.ssvv.m); setF('f-ssvv-t', d.ssvv.t); setF('f-ssvv-n', d.ssvv.n); }
  setF('f-info', d.info);
  setF('f-obs', d.obs);

  if (d.medidasPrev) {
    Object.entries(d.medidasPrev).forEach(([k,v]) => {
      const r = document.querySelector(`input[name="${k}"][value="${v}"]`);
      if (r) r.checked = true;
    });
  }

  _aplicarEscala(BRADEN_ITENS, 'brad',  d.braden);
  _aplicarEscala(MORSE_ITENS,  'morse', d.morse);
  _aplicarEscala(FUGULIN_ITENS,'fug',   d.fugulin);
  _atualizarTotaisEscalas();
}

// ── CAIXA ALTA ───────────────────────────────────────────────────────────────
function _ativarCaixaAltaForm(){
  document.querySelectorAll('#t-form input[type="text"], #t-form textarea').forEach(el => {
    if (el.dataset.ca === '1') return;
    el.dataset.ca = '1';
    if (el.readOnly) return;
    // Sugere ao teclado mobile que mostre maiúsculas
    el.setAttribute('autocapitalize', 'characters');
    // Converte só ao perder foco (não atrapalha autocorrect/autocomplete do mobile)
    el.addEventListener('blur', () => {
      if (el.readOnly) return;
      const up = el.value.toUpperCase();
      if (el.value !== up) el.value = up;
    });
  });
}
function _ativarCaixaAltaEm(container){
  container.querySelectorAll('input[type="text"], textarea').forEach(el => {
    if (el.dataset.ca === '1') return;
    el.dataset.ca = '1';
    if (el.readOnly) return;
    el.setAttribute('autocapitalize', 'characters');
    el.addEventListener('blur', () => {
      if (el.readOnly) return;
      const up = el.value.toUpperCase();
      if (el.value !== up) el.value = up;
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PREVIEW + PDF
// ══════════════════════════════════════════════════════════════════════════════
async function gerarPreview(){
  const d = _coletarDados();
  if (!d.pac) { toast('Paciente não identificado', true); return; }

  showLoading('Salvando...');
  try {
    const key = evKey(leitoAtual, turno, hoje());
    await dbSet(key, d);
    memDel(key); // invalida para que renderLeitos releia no retorno
  }
  catch(e){ console.error('salvar:', e); toast('Erro ao salvar', true); }
  finally { hideLoading(); }

  _renderPreview(d);
  const b = document.getElementById('badge-prev');
  b.textContent = turno === 'DIURNO' ? '☀ DIURNO' : '☽ NOTURNO';
  b.className = 'badge ' + (turno === 'DIURNO' ? 'badge-d' : 'badge-n');
  const enf = enfermariaDoLeito(leitoAtual);
  document.getElementById('prev-sub').textContent = `${enf.nome} · Leito ${pad(leitoAtual)} · ${fmtD(hoje())}`;
  mostrarTela('t-prev');
  window.scrollTo(0, 0);
}

function _renderPreview(d){
  const area = document.getElementById('preview-area');
  const listaCheck = arr => arr && arr.length ? arr.map(x => `<span>${esc(x)}</span>`).join('') : '<span>—</span>';

  // Texto da ventilação
  let ventText = d.vent || '—';
  if (d.vent === 'CN' && d.ventExtra?.cnLmin) ventText = `CN ${d.ventExtra.cnLmin} L/min`;
  else if (d.vent === 'MV' && d.ventExtra?.mvFio2) ventText = `MV ${d.ventExtra.mvFio2}%`;
  else if (d.vent === 'Mascara NR') ventText = `Máscara NR${d.ventExtra?.mnrLmin?' '+d.ventExtra.mnrLmin+' L/min':''}`;
  else if (d.vent === 'VNI' && d.ventExtra?.vniTipo) ventText = `VNI (${d.ventExtra.vniTipo})`;

  // Dieta
  let dietaText = d.dieta || '—';
  if (d.dieta === 'SNE' && d.dietaVaz?.sne) dietaText = `SNE – vazão ${d.dietaVaz.sne}`;
  else if (d.dieta === 'SOE' && d.dietaVaz?.soe) dietaText = `SOE – vazão ${d.dietaVaz.soe}`;
  else if (d.dieta === 'SNG' && d.dietaVaz?.sng) dietaText = `SNG – vazão ${d.dietaVaz.sng}`;
  else if (d.dieta === 'NPT' && d.dietaVaz?.npt) dietaText = `NPT – vazão ${d.dietaVaz.npt}`;
  else if (d.dieta === 'GTM' && d.dietaVaz?.gtm) dietaText = `GTM – vazão ${d.dietaVaz.gtm}`;

  // Dispositivos
  const disp = d.dispositivos || {};
  const dispList = [];
  if (disp.avp?.marcado)   dispList.push(`AVP${disp.avp.local?' ('+disp.avp.local+')':''}${disp.avp.data?' – inst '+fmtD(disp.avp.data):''}`);
  if (disp.avc?.marcado)   dispList.push(`AVC${disp.avc.local?' ('+disp.avc.local+')':''}${disp.avc.curat?' – '+disp.avc.curat:''}${disp.avc.data?' – '+fmtD(disp.avc.data):''}`);
  if (disp.cdl?.marcado)   dispList.push(`CDL/HD${disp.cdl.local?' ('+disp.cdl.local+')':''}${disp.cdl.data?' – '+fmtD(disp.cdl.data):''}`);
  if (disp.drt?.marcado)   dispList.push(`Dreno tórax ${disp.drt.lado||''}${disp.drt.ins?' – inserção '+fmtD(disp.drt.ins):''}${disp.drt.deb?' – débito 6h: '+disp.drt.deb:''}`);
  if (disp.sne?.marcado)   dispList.push(`${disp.sne.tipo||'SNE/SNG'}${disp.sne.data?' – inserção '+fmtD(disp.sne.data):''}`);
  if (disp.cisto?.marcado) dispList.push(`Cistostomia${disp.cisto.data?' – '+fmtD(disp.cisto.data):''}`);
  if (disp.svd2?.marcado)  dispList.push(`SVD${disp.svd2.data?' – '+fmtD(disp.svd2.data):''}`);
  if (disp.outro?.marcado) dispList.push(`Outro: ${disp.outro.desc||''}`);

  // ATBs
  const atbList = (d.atbs||[]).map(a => `${a.nome}${a.dias?' / D'+a.dias:''}`);

  // Medidas preventivas
  const medList = MEDIDAS_PREV.map(m => {
    const v = d.medidasPrev?.[m.id];
    if (!v) return null;
    return `${m.q} <strong>${v}</strong>`;
  }).filter(Boolean);

  // HV
  let hvText = d.hv || 'Nenhuma';
  if (d.hvVol && (d.hvVol.m || d.hvVol.t || d.hvVol.n)) {
    const p = [];
    if (d.hvVol.m) p.push('M ' + d.hvVol.m);
    if (d.hvVol.t) p.push('T ' + d.hvVol.t);
    if (d.hvVol.n) p.push('N ' + d.hvVol.n);
    hvText += ' — ' + p.join(' / ') + ' ml/h';
  }

  // Classificações das escalas
  const bradCls = d.bradLabel ? `<strong>${d.bradTotal}</strong> – ${d.bradClass==='a'?'Risco ALTO':d.bradClass==='m'?'Risco moderado':'Risco baixo / sem risco'}` : '—';
  const morseCls = d.morseLabel ? `<strong>${d.morseTotal}</strong> – ${d.morseClass==='a'?'Risco ALTO':d.morseClass==='m'?'Risco moderado':'Risco baixo'}` : '—';
  const fugNomes = { cm:'Cuidado mínimo', itm:'Intermediário', ad:'Alta dependência', si:'Semi-intensivo', i:'Intensivo' };
  const fugCls = d.fugClass ? `<strong>${d.fugTotal}</strong> – ${fugNomes[d.fugClass]||''}` : '—';

  const enf = enfermariaDoLeito(d.leito);

  area.innerHTML = `
    <div class="pv-h">
      <div class="logo">🏥</div>
      <h1>PREFEITURA MUNICIPAL DO NATAL<br>HOSPITAL DOS PESCADORES – CLÍNICA MÉDICA<br>EVOLUÇÃO DO ENFERMEIRO</h1>
      <div class="logo" style="text-align:right;">HOSPESC</div>
    </div>

    <div class="pv-id">
      <div class="pv-row">
        <span><strong>Data:</strong> ${fmtD(d.data)}</span>
        <span><strong>Turno:</strong> ${d.turno === 'DIURNO' ? 'Diurno' : 'Noturno'}</span>
        <span><strong>${esc(enf.nome)}</strong></span>
        <span><strong>Leito:</strong> ${pad(d.leito)}</span>
      </div>
      <div class="pv-row" style="margin-top:3px;">
        <span><strong>Paciente:</strong> ${esc(d.pac)}</span>
        <span><strong>Idade:</strong> ${esc(d.idade)||'—'}</span>
        <span><strong>DN:</strong> ${fmtD(d.dn)||'—'}</span>
      </div>
      <div class="pv-row" style="margin-top:3px;">
        <span><strong>Admissão:</strong> ${fmtD(d.adm)||'—'}</span>
        <span><strong>Diagnóstico:</strong> ${esc(d.diag)||'—'}</span>
      </div>
      <div class="pv-row" style="margin-top:3px;">
        <span><strong>Comorbidades:</strong> ${esc(d.comor)||'—'}</span>
      </div>
      <div class="pv-row" style="margin-top:3px;">
        <span><strong>Alergias:</strong> ${esc(d.alergia)||'Não referidas'}</span>
        <span><strong>Pulseira:</strong> ${esc(d.pulseira)||'—'}</span>
        ${d.iso ? `<span><strong>Isolamento:</strong> ${esc(d.iso)}${d.microorg?' ('+esc(d.microorg)+')':''}</span>` : ''}
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Pele e Mucosas</div>
      <div class="pv-sec-c pv-check-list">
        ${listaCheck(d.pele)}
        ${d.peleOutros ? `<span>${esc(d.peleOutros)}</span>` : ''}
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Avaliação Neurológica</div>
      <div class="pv-sec-c">
        <div class="pv-check-list">${listaCheck(d.neuro)}</div>
        <div class="pv-row" style="margin-top:3px;">
          ${d.glas ? `<span><strong>Glasgow:</strong> ${esc(d.glas)}</span>` : ''}
          ${d.reducao ? `<span><strong>Redução de força:</strong> ${esc(d.reducao)}</span>` : ''}
          ${(d.pupilas||[]).length ? `<span><strong>Pupilas:</strong> ${(d.pupilas||[]).join(', ')}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="pv-sec">
      <div class="pv-sec-t">Sistema Respiratório</div>
      <div class="pv-sec-c">
        <div class="pv-check-list">${listaCheck(d.torax)}</div>
        <div><strong>AP:</strong> ${(d.ap||[]).join(', ')||'—'}${d.apOutros?' / '+esc(d.apOutros):''}</div>
        <div><strong>Ventilação:</strong> ${esc(ventText)}</div>
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

    ${(d.ssvv?.m||d.ssvv?.t||d.ssvv?.n) ? `
    <div class="pv-sec">
      <div class="pv-sec-t">SSVV / HGT</div>
      <div class="pv-sec-c">
        ${d.ssvv.m?`<div><strong>Manhã:</strong> ${esc(d.ssvv.m)}</div>`:''}
        ${d.ssvv.t?`<div><strong>Tarde:</strong> ${esc(d.ssvv.t)}</div>`:''}
        ${d.ssvv.n?`<div><strong>Noite:</strong> ${esc(d.ssvv.n)}</div>`:''}
      </div>
    </div>`:''}

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

    // Quebra preferencial
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
    const enf = enfermariaDoLeito(leitoAtual);
    const pastaNome = nomePac
      ? `Leito ${pad(leitoAtual)} - ${nomePac}`
      : `Leito ${pad(leitoAtual)} - Sem identificacao`;
    const titulo = `EvolucaoCM_L${pad(leitoAtual)}_${turno}_${dataBR}_${primNome}`;

    status.textContent = 'Enviando ao Drive...';
    const dataUri = pdf.output('datauristring');
    const base64 = dataUri.split(',')[1];

    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        titulo,
        arquivoBase64: base64,
        pasta: pastaNome,
        pastaRaizId: PASTA_EVOLUCAO_ID
      })
    });

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

async function acaoEditarAdmissao(){
  fecharModalLeito();
  modoEdicaoAdm = true;
  abrirModalAdm(leitoAtual, false);
}

async function acaoAlta(){
  fecharModalLeito();
  leitoParaAlta = leitoAtual;
  document.getElementById('modal-alta-titulo').textContent = `Alta – Leito ${pad(leitoAtual)}`;
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

// ── MODAL ADMISSÃO ───────────────────────────────────────────────────────────
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
    memDel('cm_leitos'); // invalida cache para próxima leitura refletir a mudança
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

    // Se é admissão nova, encaminha para a evolução
    if (novaAdmissao && !modoEdicaoAdm) {
      setTimeout(() => abrirForm(leitoAtual), 400);
    }
  } finally {
    hideLoading();
    modoEdicaoAdm = false;
  }
}

// ── ALTA ─────────────────────────────────────────────────────────────────────
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
  if (!data) { toast('Informe a data da alta', true); return; }

  if (!confirm(`Confirmar alta do Leito ${pad(leitoParaAlta)}?\nEsta ação libera o leito.`)) return;

  showLoading('Dando alta...');
  try {
    const d = await leitosData();
    const pacAntes = { ...d[leitoParaAlta] };

    // Grava log de alta
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
    // Invalida cache da evolução do leito liberado (para não aparecer badge no próximo turno)
    memDel(evKey(leitoParaAlta, turno, hoje()));
    toast(`✓ Alta registrada – Leito ${pad(leitoParaAlta)} liberado`);
    await renderLeitos();
  } finally {
    hideLoading();
  }
}

// ── CAIXA ALTA AUTOMÁTICA ────────────────────────────────────────────────────
function _ativarCaixaAlta(){
  document.querySelectorAll('.overlay.show input[type="text"], .overlay.show textarea').forEach(el => {
    if (el.dataset.ca === '1') return;
    el.dataset.ca = '1';
    if (el.readOnly) return;
    el.setAttribute('autocapitalize', 'characters');
    el.addEventListener('blur', () => {
      if (el.readOnly) return;
      const up = el.value.toUpperCase();
      if (el.value !== up) el.value = up;
    });
  });
}

// ── INICIALIZAÇÃO ────────────────────────────────────────────────────────────
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
