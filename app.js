/* ============================================================
   Reembolso de Viagem — app.js
   Front-end estático (GitHub Pages) + Firebase Auth/Firestore.
   Comprovantes: imagem comprimida no navegador e salva em base64
   na coleção `comprovantes` (o plano gratuito não inclui Storage).
   ============================================================ */
'use strict';

(function () {

  // ---------- Checagem de configuração ----------
  const telaCarregando = document.getElementById('telaCarregando');
  if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.apiKey ||
      window.FIREBASE_CONFIG.apiKey.indexOf('COLE_') === 0) {
    telaCarregando.hidden = true;
    document.getElementById('telaConfig').hidden = false;
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const FV = firebase.firestore.FieldValue;

  // ---------- Constantes ----------
  const PARAMS_PADRAO = { limiteDiaAlimentacao: 120, taxaKm: 0.93 };
  const MAX_CHARS_IMG = 850000;      // ~640 KB de arquivo → cabe no doc de 1 MB
  const MAX_BYTES_PDF = 680 * 1024;

  const REGRAS_PADRAO = `## 1. Alimentação
- Valor máximo de **R$ 60,00 por refeição**.
- Em dias de trabalho integral: R$ 60,00 para o almoço + R$ 60,00 para o jantar (**R$ 120,00 no dia**).
- O valor pode ser dividido livremente durante o dia (ex.: R$ 70,00 no almoço e R$ 50,00 no jantar).
- **Será descontado automaticamente caso ultrapasse o valor disponibilizado.** Ex.: total gasto no dia R$ 126,00 → desconto de R$ 6,00 → você recebe R$ 120,00.
- **Importante:** o valor não é acumulativo entre os dias. O que não for usado num dia não transfere para outro.
- Hospedagens em Airbnb devem ser alinhadas previamente com a Lilian; café da manhã: **R$ 40,00**.

## 2. Transporte (Uber)
- A empresa arca com o Uber quando o deslocamento for necessário para a prestação de serviços da empresa.
- **Uber X é o padrão obrigatório** para todos os deslocamentos.
- **Uber Comfort** só em casos extremos:
- Ausência total de veículos na categoria X em horários de alta demanda.
- Sucessivos cancelamentos que coloquem em risco compromissos com horários rígidos.
- Necessidade de transporte de volumes que exijam veículo com mais espaço interno.
- Ao usar Comfort, é **obrigatório justificar** o motivo no envio da solicitação.

## 3. Combustível (Gasolina)
- Deslocamentos com veículo próprio: reembolso de **R$ 0,93 por km rodado**.
- Comprovação: **print da rota no Maps**. Ex.: 15,7 km × 0,93 = R$ 14,60.

## 4. Cupons Fiscais
- Todos os cupons fiscais devem ser apresentados para reembolso — **print de pagamento de pix/cartão NÃO serve**.
- **NÃO SERÁ REEMBOLSADO SEM CUPOM FISCAL.**
- Locais que não emitem cupom podem fazer um cupom a mão com assinatura/carimbo do estabelecimento.
- Uber e iFood: print com o endereço do deslocamento e o pedido com valor final.

## 5. Prestação de Contas
- Lance cada despesa aqui no sistema, na aba **Nova**, com o comprovante anexado.
- A solicitação fica **Pendente** até um moderador aprovar ou negar (negativas vêm com o motivo).

## 6. Datas de Pagamento
- Os pagamentos seguem ciclos de **7 dias úteis** após a solicitação.
- Datas de pagamento: dias **15, 20, 25 e 30**.`;

  // ---------- Estado ----------
  let usuarioAtual = null;
  let perfil = null;             // { uid, nome, email, papel }
  let params = Object.assign({}, PARAMS_PADRAO);
  let regrasTexto = REGRAS_PADRAO;
  let regrasMeta = null;
  let minhas = [];
  let todas = [];
  let usuarios = [];
  let emailsAcesso = [];
  let comprovante = null;        // { dados, mime, nome }
  let unsubs = [];
  let cadastroEmAndamento = false;
  let urlModalAtual = null;
  let abaAtual = null;

  // ---------- Atalhos ----------
  const $ = (sel) => document.querySelector(sel);
  const modalRoot = $('#modalRoot');
  const toastRoot = $('#toastRoot');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const fmtBRL = (n) => (typeof n === 'number' ? n : 0)
    .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtNum = (n) => (typeof n === 'number' ? n : 0).toFixed(2).replace('.', ',');
  function fmtData(iso) {
    if (!iso || iso.length !== 10) return iso || '';
    const p = iso.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }
  function parseValor(str) {
    str = String(str == null ? '' : str).trim();
    if (!str) return NaN;
    if (str.indexOf(',') >= 0) str = str.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(str);
    return isNaN(n) ? NaN : Math.round(n * 100) / 100;
  }
  function hojeISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }
  function debounce(fn, ms) {
    let t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  function toast(msg, tipo) {
    const d = document.createElement('div');
    d.className = 'toast' + (tipo === 'erro' ? ' erro-t' : tipo === 'ok' ? ' ok-t' : '');
    d.textContent = msg;
    toastRoot.appendChild(d);
    setTimeout(() => d.remove(), 4500);
  }
  const rotuloStatus = (s) =>
    s === 'pendente' ? 'Pendente' : s === 'aprovada' ? 'Aprovada' : 'Negada';
  const docsToArr = (snap) =>
    snap.docs.map((d) => Object.assign({ id: d.id }, d.data({ serverTimestamps: 'estimate' })));
  const ordCriado = (a, b) =>
    ((b.criadoEm && b.criadoEm.toMillis ? b.criadoEm.toMillis() : 0) -
     (a.criadoEm && a.criadoEm.toMillis ? a.criadoEm.toMillis() : 0));
  const ehMod = () => perfil && perfil.papel === 'moderador';

  function nomeDe(sol) {
    const u = usuarios.find((x) => x.id === sol.uid);
    return (u && u.nome) || sol.nome || '—';
  }
  function msgErroFirebase(e) {
    const code = (e && e.code) || '';
    const mapa = {
      'auth/invalid-credential': 'E-mail ou senha incorretos.',
      'auth/wrong-password': 'E-mail ou senha incorretos.',
      'auth/user-not-found': 'E-mail ou senha incorretos.',
      'auth/invalid-email': 'E-mail inválido.',
      'auth/email-already-in-use': 'Este e-mail já tem conta — use "Entrar".',
      'auth/weak-password': 'Senha muito fraca (mínimo 6 caracteres).',
      'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
      'auth/network-request-failed': 'Falha de conexão. Verifique a internet.',
      'permission-denied': 'Sem permissão para essa ação.',
      'app/email-nao-liberado': 'Seu e-mail ainda não foi liberado. Peça a um moderador para liberar na aba Equipe.'
    };
    return mapa[code] || (e && e.message) || 'Erro inesperado. Tente de novo.';
  }

  // ---------- Modal ----------
  function abrirModal(html, larga) {
    modalRoot.innerHTML =
      '<div class="modal-fundo" id="modalFundo"><div class="modal-caixa' +
      (larga ? ' larga' : '') + '">' + html + '</div></div>';
    $('#modalFundo').addEventListener('click', (e) => {
      if (e.target.id === 'modalFundo') fecharModal();
    });
  }
  function fecharModal() {
    modalRoot.innerHTML = '';
    if (urlModalAtual) { URL.revokeObjectURL(urlModalAtual); urlModalAtual = null; }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharModal(); });

  // ---------- Telas ----------
  function mostrarTela(id) {
    ['telaCarregando', 'telaLogin', 'telaBloqueado', 'app'].forEach((t) => {
      document.getElementById(t).hidden = (t !== id);
    });
  }

  // ============================================================
  // AUTENTICAÇÃO
  // ============================================================
  const loginErro = $('#loginErro');
  function mostrarErroLogin(msg) { loginErro.textContent = msg; loginErro.hidden = !msg; }

  $('#linkCriarConta').addEventListener('click', (e) => {
    e.preventDefault(); mostrarErroLogin('');
    $('#formLogin').hidden = true; $('#formCadastro').hidden = false;
  });
  $('#linkVoltarLogin').addEventListener('click', (e) => {
    e.preventDefault(); mostrarErroLogin('');
    $('#formCadastro').hidden = true; $('#formLogin').hidden = false;
  });

  $('#formLogin').addEventListener('submit', async (e) => {
    e.preventDefault(); mostrarErroLogin('');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await auth.signInWithEmailAndPassword(
        $('#loginEmail').value.trim().toLowerCase(), $('#loginSenha').value);
    } catch (err) { mostrarErroLogin(msgErroFirebase(err)); }
    btn.disabled = false;
  });

  $('#linkEsqueci').addEventListener('click', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim().toLowerCase();
    if (!email) { mostrarErroLogin('Digite seu e-mail no campo acima e clique de novo em "Esqueci a senha".'); return; }
    try {
      await auth.sendPasswordResetEmail(email);
      mostrarErroLogin('');
      toast('E-mail de redefinição enviado para ' + email, 'ok');
    } catch (err) { mostrarErroLogin(msgErroFirebase(err)); }
  });

  $('#formCadastro').addEventListener('submit', async (e) => {
    e.preventDefault(); mostrarErroLogin('');
    const nome = $('#cadNome').value.trim();
    const email = $('#cadEmail').value.trim().toLowerCase();
    const senha = $('#cadSenha').value;
    if (!nome) { mostrarErroLogin('Informe seu nome completo.'); return; }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    cadastroEmAndamento = true;
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, senha);
      try {
        await cred.user.updateProfile({ displayName: nome });
        await db.collection('usuarios').doc(cred.user.uid).set({
          nome: nome, email: email, papel: 'funcionario', criadoEm: FV.serverTimestamp()
        });
      } catch (errDoc) {
        // e-mail não liberado na lista de acesso → desfaz a conta
        try { await cred.user.delete(); } catch (_) { await auth.signOut(); }
        throw { code: 'app/email-nao-liberado' };
      }
      cadastroEmAndamento = false;
      await tratarAuth(cred.user);
    } catch (err) {
      mostrarErroLogin(msgErroFirebase(err));
    }
    cadastroEmAndamento = false;
    btn.disabled = false;
  });

  $('#btnSair').addEventListener('click', () => auth.signOut());
  $('#btnSairBloqueado').addEventListener('click', () => auth.signOut());

  auth.onAuthStateChanged((user) => {
    if (cadastroEmAndamento) return;
    tratarAuth(user);
  });

  function limparUnsubs() {
    unsubs.forEach((u) => { try { u(); } catch (_) {} });
    unsubs = [];
  }

  async function tratarAuth(user) {
    limparUnsubs();
    usuarioAtual = user;
    perfil = null;
    if (!user) {
      minhas = []; todas = []; usuarios = []; emailsAcesso = [];
      mostrarTela('telaLogin');
      return;
    }
    let snap = null;
    try { snap = await db.collection('usuarios').doc(user.uid).get(); } catch (_) {}
    if (!snap || !snap.exists) {
      // conta Auth existe mas o perfil não — tenta criar (vale se o e-mail foi liberado depois)
      try {
        await db.collection('usuarios').doc(user.uid).set({
          nome: user.displayName || user.email,
          email: user.email, papel: 'funcionario', criadoEm: FV.serverTimestamp()
        });
        snap = await db.collection('usuarios').doc(user.uid).get();
      } catch (_) {
        mostrarTela('telaBloqueado');
        return;
      }
    }
    perfil = Object.assign({ uid: user.uid }, snap.data());
    montarUI();
    assinarDados();
    mostrarTela('app');
  }

  // ============================================================
  // DADOS (listeners em tempo real)
  // ============================================================
  function assinarDados() {
    // Perfil: reage a promoção/rebaixamento e remoção
    unsubs.push(db.collection('usuarios').doc(perfil.uid).onSnapshot((s) => {
      if (!s.exists) { auth.signOut(); return; }
      const novo = s.data();
      const mudouPapel = novo.papel !== perfil.papel;
      perfil = Object.assign({ uid: perfil.uid }, novo);
      if (mudouPapel) tratarAuth(usuarioAtual);
    }, () => {}));

    // Regras e parâmetros (todos)
    unsubs.push(db.collection('config').doc('regras').onSnapshot((s) => {
      regrasTexto = (s.exists && s.data().conteudo) || REGRAS_PADRAO;
      regrasMeta = s.exists ? s.data() : null;
      renderRegras();
    }, () => {}));
    unsubs.push(db.collection('config').doc('parametros').onSnapshot((s) => {
      params = Object.assign({}, PARAMS_PADRAO, s.exists ? s.data() : {});
      atualizarHintsCategoria();
    }, () => {}));

    // Minhas solicitações (todos)
    unsubs.push(db.collection('solicitacoes').where('uid', '==', perfil.uid)
      .onSnapshot((s) => { minhas = docsToArr(s); renderMinhas(); },
        (e) => toast(msgErroFirebase(e), 'erro')));

    // Moderador: tudo + usuários + lista de acesso
    if (ehMod()) {
      unsubs.push(db.collection('solicitacoes').onSnapshot((s) => {
        todas = docsToArr(s); renderPainel();
      }, (e) => toast(msgErroFirebase(e), 'erro')));
      unsubs.push(db.collection('usuarios').onSnapshot((s) => {
        usuarios = docsToArr(s).sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
        preencherFiltroFuncionarios(); renderPainel(); renderEquipe();
      }, () => {}));
      unsubs.push(db.collection('config').doc('acesso').onSnapshot((s) => {
        emailsAcesso = (s.exists && s.data().emails) || [];
        renderEquipe();
      }, () => {}));
    }
  }

  // ============================================================
  // UI GERAL / ABAS
  // ============================================================
  function montarUI() {
    $('#topoNome').textContent = perfil.nome + (ehMod() ? ' · moderador' : '');
    document.querySelectorAll('.so-mod').forEach((el) => { el.hidden = !ehMod(); });
    $('#nvData').max = hojeISO();
    renderRegras();
    renderMinhas();
    if (ehMod()) { renderPainel(); renderEquipe(); }
    irParaAba(ehMod() ? 'painel' : 'minhas');
  }

  $('#navAbas').addEventListener('click', (e) => {
    const btn = e.target.closest('.aba');
    if (btn) irParaAba(btn.dataset.aba);
  });

  function irParaAba(nome) {
    abaAtual = nome;
    document.querySelectorAll('.aba').forEach((b) =>
      b.classList.toggle('ativa', b.dataset.aba === nome));
    ['regras', 'nova', 'minhas', 'painel', 'equipe'].forEach((n) => {
      const sec = document.getElementById('sec' + n.charAt(0).toUpperCase() + n.slice(1));
      if (sec) sec.hidden = (n !== nome);
    });
    if (nome === 'nova') $('#nvData').max = hojeISO();
    window.scrollTo(0, 0);
  }

  // ============================================================
  // REGRAS
  // ============================================================
  function renderMd(txt) {
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const linhas = esc(txt).split('\n');
    let html = '', emLista = false;
    for (const l of linhas) {
      const t = l.trim();
      if (t.indexOf('- ') === 0) {
        if (!emLista) { html += '<ul>'; emLista = true; }
        html += '<li>' + inline(t.slice(2)) + '</li>';
        continue;
      }
      if (emLista) { html += '</ul>'; emLista = false; }
      if (t.indexOf('### ') === 0) html += '<h4>' + inline(t.slice(4)) + '</h4>';
      else if (t.indexOf('## ') === 0) html += '<h3>' + inline(t.slice(3)) + '</h3>';
      else if (t !== '') html += '<p>' + inline(t) + '</p>';
    }
    if (emLista) html += '</ul>';
    return html;
  }

  function renderRegras() {
    $('#regrasView').innerHTML = renderMd(regrasTexto);
    const rod = $('#regrasRodape');
    if (regrasMeta && regrasMeta.atualizadoEm && regrasMeta.atualizadoEm.toDate) {
      rod.textContent = 'Atualizado em ' +
        regrasMeta.atualizadoEm.toDate().toLocaleString('pt-BR') +
        (regrasMeta.atualizadoPor ? ' por ' + regrasMeta.atualizadoPor : '');
      rod.hidden = false;
    } else rod.hidden = true;
  }

  $('#btnEditarRegras').addEventListener('click', () => {
    $('#regrasTexto').value = regrasTexto;
    $('#paramLimiteDia').value = fmtNum(params.limiteDiaAlimentacao);
    $('#paramTaxaKm').value = fmtNum(params.taxaKm);
    $('#regrasView').hidden = true;
    $('#regrasRodape').hidden = true;
    $('#btnEditarRegras').hidden = true;
    $('#regrasEditor').hidden = false;
  });
  function fecharEditorRegras() {
    $('#regrasEditor').hidden = true;
    $('#regrasView').hidden = false;
    $('#btnEditarRegras').hidden = !ehMod();
    renderRegras();
  }
  $('#btnCancelarRegras').addEventListener('click', fecharEditorRegras);
  $('#btnRestaurarRegras').addEventListener('click', () => {
    $('#regrasTexto').value = REGRAS_PADRAO;
    $('#paramLimiteDia').value = fmtNum(PARAMS_PADRAO.limiteDiaAlimentacao);
    $('#paramTaxaKm').value = fmtNum(PARAMS_PADRAO.taxaKm);
  });
  $('#btnSalvarRegras').addEventListener('click', async () => {
    const conteudo = $('#regrasTexto').value.trim();
    const limite = parseValor($('#paramLimiteDia').value);
    const taxa = parseValor($('#paramTaxaKm').value);
    if (!conteudo) { toast('O texto das regras não pode ficar vazio.', 'erro'); return; }
    if (!(limite > 0) || !(taxa > 0)) { toast('Parâmetros inválidos — use números maiores que zero.', 'erro'); return; }
    try {
      const batch = db.batch();
      batch.set(db.collection('config').doc('regras'), {
        conteudo: conteudo, atualizadoEm: FV.serverTimestamp(), atualizadoPor: perfil.nome
      });
      batch.set(db.collection('config').doc('parametros'), {
        limiteDiaAlimentacao: limite, taxaKm: taxa
      });
      await batch.commit();
      toast('Regras salvas!', 'ok');
      fecharEditorRegras();
    } catch (e) { toast(msgErroFirebase(e), 'erro'); }
  });

  // ============================================================
  // NOVA SOLICITAÇÃO
  // ============================================================
  const nvCategoria = $('#nvCategoria');
  const nvData = $('#nvData');
  const nvKm = $('#nvKm');
  const nvValor = $('#nvValor');
  const nvJustificativa = $('#nvJustificativa');
  const nvDescricao = $('#nvDescricao');
  const alimBox = $('#alimBox');

  const HINTS = {
    'Alimentação': () => 'Cupom fiscal obrigatório — print de pix/cartão NÃO vale. Limite do dia: ' + fmtBRL(params.limiteDiaAlimentacao) + '.',
    'Uber': () => 'Anexe o print com o endereço do deslocamento e o valor final. Uber X é o padrão; Comfort exige justificativa.',
    'Combustível': () => 'Anexe o print da rota no Maps. Valor calculado automaticamente: km × ' + fmtBRL(params.taxaKm) + '.',
    'Hospedagem': () => 'Airbnb deve ser alinhado previamente com a Lilian (café da manhã: R$ 40,00).',
    'Outros': () => 'Descreva a despesa e anexe o cupom fiscal.'
  };

  function atualizarHintsCategoria() {
    const cat = nvCategoria.value;
    const hint = $('#nvHint');
    if (cat && HINTS[cat]) { hint.textContent = HINTS[cat](); hint.hidden = false; }
    else hint.hidden = true;
    $('#hintKm').textContent = fmtBRL(params.taxaKm) + ' por km — o valor é calculado automaticamente.';
  }

  function subtipoSelecionado() {
    const r = document.querySelector('input[name="nvSubtipo"]:checked');
    return r ? r.value : 'Uber X';
  }

  function aoMudarCategoria() {
    const cat = nvCategoria.value;
    $('#blocoSubtipo').hidden = (cat !== 'Uber');
    $('#blocoKm').hidden = (cat !== 'Combustível');
    atualizarJustificativa();
    atualizarHintsCategoria();
    if (cat === 'Combustível') {
      nvValor.readOnly = true;
      calcularCombustivel();
    } else {
      nvValor.readOnly = false;
    }
    checarAlimentacaoDebounced();
  }
  function atualizarJustificativa() {
    const precisa = (nvCategoria.value === 'Uber' && subtipoSelecionado() === 'Uber Comfort');
    $('#blocoJustificativa').hidden = !precisa;
  }
  function calcularCombustivel() {
    const km = parseValor(nvKm.value);
    nvValor.value = (km > 0) ? fmtNum(Math.round(km * params.taxaKm * 100) / 100) : '';
  }

  nvCategoria.addEventListener('change', aoMudarCategoria);
  document.querySelectorAll('input[name="nvSubtipo"]').forEach((r) =>
    r.addEventListener('change', atualizarJustificativa));
  nvKm.addEventListener('input', () => { calcularCombustivel(); checarAlimentacaoDebounced(); });

  // --- Validação automática de alimentação (limite do dia) ---
  async function checarAlimentacao() {
    alimBox.hidden = true;
    if (nvCategoria.value !== 'Alimentação') return null;
    const dataDesp = nvData.value;
    const valor = parseValor(nvValor.value);
    if (!dataDesp || !(valor > 0)) return null;

    const snap = await db.collection('solicitacoes')
      .where('uid', '==', perfil.uid)
      .where('categoria', '==', 'Alimentação')
      .where('dataDespesa', '==', dataDesp)
      .get();
    const anteriores = snap.docs.map((d) => d.data()).filter((d) => d.status !== 'negada');
    const efetivo = (d) => d.status === 'aprovada'
      ? (typeof d.valorAprovado === 'number' ? d.valorAprovado : d.valor)
      : (typeof d.valorSugerido === 'number' ? d.valorSugerido : d.valor);
    const somaAnterior = Math.round(anteriores.reduce((s, d) => s + efetivo(d), 0) * 100) / 100;

    const limite = params.limiteDiaAlimentacao;
    const disponivel = Math.max(0, Math.round((limite - somaAnterior) * 100) / 100);
    const considerado = Math.min(valor, disponivel);
    const desconto = Math.round((valor - considerado) * 100) / 100;
    const somaDia = Math.round((somaAnterior + valor) * 100) / 100;

    if (desconto > 0) {
      alimBox.className = 'aviso';
      alimBox.innerHTML =
        '⚠️ <b>Limite diário de alimentação ultrapassado.</b><br>' +
        'Dia ' + fmtData(dataDesp) + ': já lançado ' + fmtBRL(somaAnterior) +
        ' + esta solicitação ' + fmtBRL(valor) + ' = <b>' + fmtBRL(somaDia) + '</b> (limite ' +
        fmtBRL(limite) + ').<br>Desconto automático: <b>' + fmtBRL(desconto) +
        '</b> → você recebe <b>' + fmtBRL(considerado) + '</b> desta solicitação.';
      alimBox.hidden = false;
    } else if (somaAnterior > 0) {
      alimBox.className = 'aviso ok';
      alimBox.innerHTML = 'ℹ️ Já lançado ' + fmtBRL(somaAnterior) + ' de alimentação em ' +
        fmtData(dataDesp) + '. Com esta solicitação: ' + fmtBRL(somaDia) +
        ' — dentro do limite de ' + fmtBRL(limite) + '.';
      alimBox.hidden = false;
    }
    return { somaDia: somaDia, desconto: desconto, considerado: considerado };
  }
  const checarAlimentacaoDebounced = debounce(() => {
    checarAlimentacao().catch(() => {});
  }, 500);
  nvData.addEventListener('change', checarAlimentacaoDebounced);
  nvValor.addEventListener('input', checarAlimentacaoDebounced);

  // --- Comprovante: leitura + compressão ---
  function lerDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('Não consegui ler o arquivo.'));
      r.readAsDataURL(file);
    });
  }
  async function comprimirImagem(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('Não consegui abrir a imagem.'));
        i.src = url;
      });
      let maxDim = 1600, qual = 0.8, out = null;
      for (let t = 0; t < 8; t++) {
        const escala = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * escala));
        const h = Math.max(1, Math.round(img.height * escala));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        out = cv.toDataURL('image/jpeg', qual);
        if (out.length <= MAX_CHARS_IMG) break;
        if (qual > 0.5) qual -= 0.15;
        else maxDim = Math.round(maxDim * 0.75);
      }
      if (!out || out.length > MAX_CHARS_IMG)
        throw new Error('Imagem grande demais mesmo comprimida. Tente outra foto.');
      return out;
    } finally { URL.revokeObjectURL(url); }
  }
  async function processarArquivo(file) {
    if (file.type === 'application/pdf') {
      if (file.size > MAX_BYTES_PDF)
        throw new Error('PDF muito grande (máx. ~650 KB). Tire uma foto do cupom.');
      return { dados: await lerDataURL(file), mime: 'application/pdf', nome: file.name };
    }
    if (file.type.indexOf('image/') !== 0)
      throw new Error('Formato não aceito. Envie foto (JPG/PNG) ou PDF.');
    const dados = await comprimirImagem(file);
    return { dados: dados, mime: 'image/jpeg', nome: file.name.replace(/\.\w+$/, '') + '.jpg' };
  }

  $('#nvArquivo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#uploadTexto').textContent = '⏳ Processando arquivo…';
    try {
      comprovante = await processarArquivo(file);
    } catch (err) {
      comprovante = null;
      toast(err.message, 'erro');
    }
    $('#uploadTexto').textContent = '📎 Tirar foto ou anexar arquivo';
    e.target.value = '';
    renderPreview();
  });

  function renderPreview() {
    const prev = $('#uploadPreview');
    const area = $('#areaUpload');
    if (!comprovante) {
      prev.hidden = true; prev.innerHTML = '';
      area.hidden = false;
      return;
    }
    const kb = Math.round(comprovante.dados.length * 3 / 4 / 1024);
    prev.innerHTML =
      (comprovante.mime === 'application/pdf'
        ? '<span class="pdf-icone">📄</span>'
        : '<img src="' + comprovante.dados + '" alt="comprovante">') +
      '<div class="preview-info"><b>' + esc(comprovante.nome) + '</b>' +
      '<span class="mini">' + kb + ' KB · pronto para envio</span></div>' +
      '<button type="button" class="btn perigo" id="btnRemoverArq">✕</button>';
    prev.hidden = false;
    area.hidden = true;
    $('#btnRemoverArq').addEventListener('click', () => { comprovante = null; renderPreview(); });
  }

  // --- Envio ---
  $('#formNova').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnEnviar');
    const cat = nvCategoria.value;
    const dataDesp = nvData.value;

    if (!dataDesp) { toast('Informe a data da despesa.', 'erro'); return; }
    if (dataDesp > hojeISO()) { toast('A data da despesa não pode ser futura.', 'erro'); return; }
    if (!cat) { toast('Selecione a categoria.', 'erro'); return; }

    let km = null;
    if (cat === 'Combustível') {
      km = parseValor(nvKm.value);
      if (!(km > 0)) { toast('Informe os km rodados.', 'erro'); return; }
      calcularCombustivel();
    }
    const valor = parseValor(nvValor.value);
    if (!(valor > 0)) { toast('Informe um valor válido.', 'erro'); return; }

    const subtipo = (cat === 'Uber') ? subtipoSelecionado() : null;
    const justificativa = nvJustificativa.value.trim();
    if (subtipo === 'Uber Comfort' && !justificativa) {
      toast('Uber Comfort exige justificativa — explique a exceção.', 'erro');
      $('#blocoJustificativa').hidden = false;
      nvJustificativa.focus();
      return;
    }
    if (!comprovante) {
      toast('Anexe o comprovante — sem cupom fiscal não há reembolso.', 'erro');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      let alim = null;
      if (cat === 'Alimentação') alim = await checarAlimentacao();

      const id = db.collection('solicitacoes').doc().id;
      const batch = db.batch();
      batch.set(db.collection('comprovantes').doc(id), {
        uid: perfil.uid, dados: comprovante.dados, mime: comprovante.mime,
        nome: comprovante.nome, criadoEm: FV.serverTimestamp()
      });
      batch.set(db.collection('solicitacoes').doc(id), {
        uid: perfil.uid,
        nome: perfil.nome,
        dataDespesa: dataDesp,
        categoria: cat,
        subtipo: subtipo,
        km: km,
        valor: valor,
        descricao: nvDescricao.value.trim(),
        justificativa: justificativa,
        status: 'pendente',
        observacao: '',
        valorSugerido: alim ? alim.considerado : valor,
        alimDesconto: alim ? alim.desconto : 0,
        alimTotalDia: alim ? alim.somaDia : null,
        comprovanteMime: comprovante.mime,
        criadoEm: FV.serverTimestamp()
      });
      await batch.commit();

      toast('Solicitação enviada! Acompanhe em "Minhas".', 'ok');
      e.target.reset();
      comprovante = null;
      renderPreview();
      alimBox.hidden = true;
      aoMudarCategoria();
      irParaAba('minhas');
    } catch (err) {
      toast(msgErroFirebase(err), 'erro');
    }
    btn.disabled = false;
    btn.textContent = 'Enviar solicitação';
  });

  // ============================================================
  // MINHAS SOLICITAÇÕES
  // ============================================================
  function renderMinhas() {
    const lista = $('#listaMinhas');
    const arr = minhas.slice().sort(ordCriado);
    if (!arr.length) {
      lista.innerHTML = '<div class="cartao vazio">Nenhuma solicitação ainda.<br>Crie a primeira na aba ➕ Nova.</div>';
      return;
    }
    lista.innerHTML = arr.map((s) => {
      let extras = '';
      if (s.status === 'pendente' && s.alimDesconto > 0)
        extras += '<div class="sol-alerta">⚠️ Sujeita a desconto de ' + fmtBRL(s.alimDesconto) +
          ' (limite do dia) → reembolso previsto ' + fmtBRL(s.valorSugerido) + '</div>';
      if (s.status === 'aprovada')
        extras += '<div class="sol-obs-ok">✓ Aprovada: <b>' + fmtBRL(s.valorAprovado) + '</b>' +
          (typeof s.valorAprovado === 'number' && s.valorAprovado !== s.valor
            ? ' <span class="mini">(solicitado ' + fmtBRL(s.valor) + ')</span>' : '') +
          (s.observacao ? '<br>' + esc(s.observacao) : '') + '</div>';
      if (s.status === 'negada')
        extras += '<div class="sol-obs"><b>Motivo da negativa:</b> ' + esc(s.observacao || '—') + '</div>';
      return '<div class="cartao sol">' +
        '<div class="sol-topo"><span class="chip chip-' + s.status + '">' + rotuloStatus(s.status) +
        '</span><b>' + fmtBRL(s.valor) + '</b></div>' +
        '<div class="sol-info">' + esc(s.categoria) +
        (s.subtipo ? ' · ' + esc(s.subtipo) : '') +
        (s.km ? ' · ' + fmtNum(s.km) + ' km' : '') +
        ' · ' + fmtData(s.dataDespesa) + '</div>' +
        (s.descricao ? '<div class="sol-info">' + esc(s.descricao) + '</div>' : '') +
        (s.justificativa ? '<div class="sol-just"><b>Justificativa:</b> ' + esc(s.justificativa) + '</div>' : '') +
        extras +
        '<div class="sol-botoes">' +
        '<button class="btn" data-acao="ver" data-id="' + s.id + '">📄 Comprovante</button>' +
        (s.status === 'pendente'
          ? '<button class="btn perigo" data-acao="excluir" data-id="' + s.id + '">🗑 Excluir</button>' : '') +
        '</div></div>';
    }).join('');
  }

  $('#listaMinhas').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    if (btn.dataset.acao === 'ver') verComprovante(btn.dataset.id);
    if (btn.dataset.acao === 'excluir') confirmarExcluir(btn.dataset.id);
  });

  function confirmarExcluir(id) {
    abrirModal(
      '<h3>Excluir solicitação?</h3>' +
      '<p>A solicitação e o comprovante serão apagados. Essa ação não pode ser desfeita.</p>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">Cancelar</button>' +
      '<button class="btn perigo" id="mdConfirmar">🗑 Excluir</button></div>');
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdConfirmar').addEventListener('click', async () => {
      try {
        const batch = db.batch();
        batch.delete(db.collection('solicitacoes').doc(id));
        batch.delete(db.collection('comprovantes').doc(id));
        await batch.commit();
        toast('Solicitação excluída.', 'ok');
      } catch (e2) { toast(msgErroFirebase(e2), 'erro'); }
      fecharModal();
    });
  }

  // ============================================================
  // VISUALIZAR COMPROVANTE
  // ============================================================
  function dataURLtoBlob(dataURL) {
    const partes = dataURL.split(',');
    const mime = (partes[0].match(/data:(.*?)(;|$)/) || [])[1] || 'application/octet-stream';
    const bin = atob(partes[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function verComprovante(id) {
    try {
      const d = await db.collection('comprovantes').doc(id).get();
      if (!d.exists) { toast('Comprovante não encontrado.', 'erro'); return; }
      const c = d.data();
      const blob = dataURLtoBlob(c.dados);
      urlModalAtual = URL.createObjectURL(blob);
      const corpo = c.mime === 'application/pdf'
        ? '<iframe class="comprovante" src="' + urlModalAtual + '"></iframe>'
        : '<img class="comprovante" src="' + urlModalAtual + '" alt="comprovante">';
      abrirModal(
        '<h3>Comprovante</h3>' + corpo +
        '<div class="linha-botoes">' +
        '<a class="btn" href="' + urlModalAtual + '" target="_blank" rel="noopener">Abrir em nova aba</a>' +
        '<button class="btn primario" id="mdFechar">Fechar</button></div>', true);
      $('#mdFechar').addEventListener('click', fecharModal);
    } catch (e) { toast(msgErroFirebase(e), 'erro'); }
  }

  // ============================================================
  // PAINEL DO MODERADOR
  // ============================================================
  ['fltStatus', 'fltFuncionario', 'fltDe', 'fltAte'].forEach((id) => {
    document.getElementById(id).addEventListener('change', renderPainel);
  });

  function preencherFiltroFuncionarios() {
    const sel = $('#fltFuncionario');
    const atual = sel.value;
    sel.innerHTML = '<option value="">Todos</option>' +
      usuarios.map((u) => '<option value="' + u.id + '">' + esc(u.nome) + '</option>').join('');
    sel.value = atual;
  }

  function filtroPeriodo(s) {
    const de = $('#fltDe').value, ate = $('#fltAte').value;
    if (de && s.dataDespesa < de) return false;
    if (ate && s.dataDespesa > ate) return false;
    return true;
  }

  function renderPainel() {
    if (!ehMod()) return;
    const pendentes = todas.filter((s) => s.status === 'pendente').length;
    const badge = $('#badgePendentes');
    badge.textContent = pendentes;
    badge.hidden = pendentes === 0;

    const st = $('#fltStatus').value;
    const func = $('#fltFuncionario').value;
    const arr = todas
      .filter((s) => (st === 'todas' || s.status === st))
      .filter((s) => (!func || s.uid === func))
      .filter(filtroPeriodo)
      .sort(ordCriado);

    const lista = $('#listaPainel');
    lista.innerHTML = !arr.length
      ? '<div class="cartao vazio">Nada por aqui com esses filtros. 🎉</div>'
      : arr.map((s) =>
        '<div class="cartao sol">' +
        '<div class="sol-nome">' + esc(nomeDe(s)) + '</div>' +
        '<div class="sol-topo"><span class="chip chip-' + s.status + '">' + rotuloStatus(s.status) +
        '</span><b>' + fmtBRL(s.valor) + '</b></div>' +
        '<div class="sol-info">' + esc(s.categoria) +
        (s.subtipo ? ' · ' + esc(s.subtipo) : '') +
        (s.km ? ' · ' + fmtNum(s.km) + ' km' : '') +
        ' · ' + fmtData(s.dataDespesa) + '</div>' +
        (s.descricao ? '<div class="sol-info">' + esc(s.descricao) + '</div>' : '') +
        (s.justificativa ? '<div class="sol-just"><b>Justificativa:</b> ' + esc(s.justificativa) + '</div>' : '') +
        (s.alimDesconto > 0
          ? '<div class="sol-alerta">⚠️ Excede o limite diário de alimentação — desconto sugerido ' +
            fmtBRL(s.alimDesconto) + ' → reembolso ' + fmtBRL(s.valorSugerido) + '</div>' : '') +
        (s.status === 'aprovada'
          ? '<div class="sol-obs-ok">✓ Aprovada: <b>' + fmtBRL(s.valorAprovado) + '</b>' +
            (s.moderadoPor ? ' · por ' + esc(s.moderadoPor) : '') +
            (s.observacao ? '<br>' + esc(s.observacao) : '') + '</div>' : '') +
        (s.status === 'negada'
          ? '<div class="sol-obs"><b>Negada' + (s.moderadoPor ? ' por ' + esc(s.moderadoPor) : '') +
            ':</b> ' + esc(s.observacao) + '</div>' : '') +
        '<div class="sol-botoes">' +
        '<button class="btn" data-acao="ver" data-id="' + s.id + '">📄 Comprovante</button>' +
        (s.status === 'pendente'
          ? '<button class="btn sucesso" data-acao="aprovar" data-id="' + s.id + '">✓ Aprovar</button>' +
            '<button class="btn perigo" data-acao="negar" data-id="' + s.id + '">✕ Negar</button>'
          : '') +
        '</div></div>').join('');

    renderTotalizador();
  }

  $('#listaPainel').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    const sol = todas.find((s) => s.id === btn.dataset.id);
    if (btn.dataset.acao === 'ver') verComprovante(btn.dataset.id);
    if (btn.dataset.acao === 'aprovar' && sol) abrirAprovar(sol);
    if (btn.dataset.acao === 'negar' && sol) abrirNegar(sol);
  });

  function abrirAprovar(sol) {
    const sugerido = typeof sol.valorSugerido === 'number' ? sol.valorSugerido : sol.valor;
    abrirModal(
      '<h3>Aprovar solicitação</h3>' +
      '<p><b>' + esc(nomeDe(sol)) + '</b> — ' + esc(sol.categoria) +
      (sol.subtipo ? ' (' + esc(sol.subtipo) + ')' : '') + ' — ' + fmtData(sol.dataDespesa) + '</p>' +
      '<p>Valor solicitado: <b>' + fmtBRL(sol.valor) + '</b></p>' +
      (sol.alimDesconto > 0
        ? '<div class="aviso">⚠️ Limite diário de alimentação ultrapassado. Desconto sugerido: <b>' +
          fmtBRL(sol.alimDesconto) + '</b> → reembolso sugerido <b>' + fmtBRL(sugerido) + '</b>.</div>'
        : '') +
      '<label>Valor a reembolsar (R$)' +
      '<input type="text" id="mdValorAprovado" inputmode="decimal" value="' + fmtNum(sugerido) + '"></label>' +
      '<label>Observação <span class="mini">(opcional — fica visível para o funcionário)</span>' +
      '<textarea id="mdObsAprovar" rows="2"></textarea></label>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">Cancelar</button>' +
      '<button class="btn sucesso" id="mdConfirmar">✓ Confirmar aprovação</button></div>');
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdConfirmar').addEventListener('click', async () => {
      const v = parseValor($('#mdValorAprovado').value);
      if (!(v >= 0)) { toast('Valor inválido.', 'erro'); return; }
      if (v > sol.valor) { toast('O valor aprovado não pode ser maior que o solicitado (' + fmtBRL(sol.valor) + ').', 'erro'); return; }
      try {
        await db.collection('solicitacoes').doc(sol.id).update({
          status: 'aprovada',
          valorAprovado: v,
          observacao: $('#mdObsAprovar').value.trim(),
          moderadoPor: perfil.nome,
          moderadoEm: FV.serverTimestamp()
        });
        toast('Aprovada: ' + fmtBRL(v), 'ok');
        fecharModal();
      } catch (e2) { toast(msgErroFirebase(e2), 'erro'); }
    });
  }

  function abrirNegar(sol) {
    abrirModal(
      '<h3>Negar solicitação</h3>' +
      '<p><b>' + esc(nomeDe(sol)) + '</b> — ' + esc(sol.categoria) + ' — ' +
      fmtBRL(sol.valor) + ' — ' + fmtData(sol.dataDespesa) + '</p>' +
      '<label>Motivo da negativa <b class="obrig">(obrigatório — o funcionário vai ler)</b>' +
      '<textarea id="mdObsNegar" rows="3" placeholder="Ex.: comprovante é print de pix, não cupom fiscal…"></textarea></label>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">Cancelar</button>' +
      '<button class="btn perigo" id="mdConfirmar">✕ Confirmar negativa</button></div>');
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdConfirmar').addEventListener('click', async () => {
      const obs = $('#mdObsNegar').value.trim();
      if (!obs) { toast('Escreva o motivo da negativa — é obrigatório.', 'erro'); return; }
      try {
        await db.collection('solicitacoes').doc(sol.id).update({
          status: 'negada',
          observacao: obs,
          moderadoPor: perfil.nome,
          moderadoEm: FV.serverTimestamp()
        });
        toast('Solicitação negada.', 'ok');
        fecharModal();
      } catch (e2) { toast(msgErroFirebase(e2), 'erro'); }
    });
  }

  function renderTotalizador() {
    const func = $('#fltFuncionario').value;
    const arr = todas
      .filter((s) => (!func || s.uid === func))
      .filter(filtroPeriodo);

    const porFunc = {};
    arr.forEach((s) => {
      const g = porFunc[s.uid] || (porFunc[s.uid] = {
        nome: nomeDe(s), pendQtd: 0, pendVal: 0, aprQtd: 0, aprVal: 0, negQtd: 0
      });
      if (s.status === 'pendente') { g.pendQtd++; g.pendVal += s.valor || 0; }
      if (s.status === 'aprovada') {
        g.aprQtd++;
        g.aprVal += typeof s.valorAprovado === 'number' ? s.valorAprovado : (s.valor || 0);
      }
      if (s.status === 'negada') g.negQtd++;
    });

    const grupos = Object.values(porFunc).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const el = $('#totalizador');
    if (!grupos.length) {
      el.innerHTML = '<div class="vazio">Sem dados no período selecionado.</div>';
      return;
    }
    const tot = grupos.reduce((t, g) => ({
      pendQtd: t.pendQtd + g.pendQtd, pendVal: t.pendVal + g.pendVal,
      aprQtd: t.aprQtd + g.aprQtd, aprVal: t.aprVal + g.aprVal, negQtd: t.negQtd + g.negQtd
    }), { pendQtd: 0, pendVal: 0, aprQtd: 0, aprVal: 0, negQtd: 0 });

    el.innerHTML = '<table><thead><tr>' +
      '<th>Funcionário</th><th class="num">Pend.</th><th class="num">R$ pendente</th>' +
      '<th class="num">Aprov.</th><th class="num">R$ a pagar</th><th class="num">Neg.</th>' +
      '</tr></thead><tbody>' +
      grupos.map((g) =>
        '<tr><td>' + esc(g.nome) + '</td>' +
        '<td class="num">' + g.pendQtd + '</td>' +
        '<td class="num">' + fmtBRL(g.pendVal) + '</td>' +
        '<td class="num">' + g.aprQtd + '</td>' +
        '<td class="num">' + fmtBRL(g.aprVal) + '</td>' +
        '<td class="num">' + g.negQtd + '</td></tr>').join('') +
      '<tr class="total-geral"><td>Total</td>' +
      '<td class="num">' + tot.pendQtd + '</td>' +
      '<td class="num">' + fmtBRL(tot.pendVal) + '</td>' +
      '<td class="num">' + tot.aprQtd + '</td>' +
      '<td class="num">' + fmtBRL(tot.aprVal) + '</td>' +
      '<td class="num">' + tot.negQtd + '</td></tr>' +
      '</tbody></table>';
  }

  // ============================================================
  // EQUIPE (moderador)
  // ============================================================
  $('#formAddEmail').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#addEmail').value.trim().toLowerCase();
    if (!email) return;
    try {
      await db.collection('config').doc('acesso')
        .set({ emails: FV.arrayUnion(email) }, { merge: true });
      $('#addEmail').value = '';
      toast('E-mail liberado: ' + email, 'ok');
    } catch (e2) { toast(msgErroFirebase(e2), 'erro'); }
  });

  function renderEquipe() {
    if (!ehMod()) return;
    $('#listaEmails').innerHTML = !emailsAcesso.length
      ? '<span class="mini">Nenhum e-mail liberado ainda.</span>'
      : emailsAcesso.slice().sort().map((em) =>
        '<span class="chip-email">' + esc(em) +
        '<button title="Remover" data-email="' + esc(em) + '">✕</button></span>').join('');

    $('#listaUsuarios').innerHTML = !usuarios.length
      ? '<span class="mini">Nenhum usuário ainda.</span>'
      : usuarios.map((u) =>
        '<div class="usuario-linha">' +
        '<div class="usuario-info"><b>' + esc(u.nome) +
        (u.id === perfil.uid ? ' <span class="mini">(você)</span>' : '') +
        '</b><span>' + esc(u.email) + '</span></div>' +
        '<select data-uid="' + u.id + '"' + (u.id === perfil.uid ? ' disabled' : '') + '>' +
        '<option value="funcionario"' + (u.papel === 'funcionario' ? ' selected' : '') + '>Funcionário</option>' +
        '<option value="moderador"' + (u.papel === 'moderador' ? ' selected' : '') + '>Moderador</option>' +
        '</select></div>').join('');
  }

  $('#listaEmails').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-email]');
    if (!btn) return;
    const email = btn.dataset.email;
    if (email === perfil.email) { toast('Você não pode remover o próprio e-mail.', 'erro'); return; }
    const usuario = usuarios.find((u) => u.email === email);
    abrirModal(
      '<h3>Remover acesso?</h3>' +
      '<p><b>' + esc(email) + '</b> não poderá mais criar conta' +
      (usuario ? ' e o perfil de <b>' + esc(usuario.nome) + '</b> será desativado' : '') + '.</p>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">Cancelar</button>' +
      '<button class="btn perigo" id="mdConfirmar">Remover</button></div>');
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdConfirmar').addEventListener('click', async () => {
      try {
        const batch = db.batch();
        batch.update(db.collection('config').doc('acesso'), { emails: FV.arrayRemove(email) });
        if (usuario) batch.delete(db.collection('usuarios').doc(usuario.id));
        await batch.commit();
        toast('Acesso removido.', 'ok');
      } catch (e2) { toast(msgErroFirebase(e2), 'erro'); }
      fecharModal();
    });
  });

  $('#listaUsuarios').addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-uid]');
    if (!sel) return;
    const uid = sel.dataset.uid;
    if (uid === perfil.uid) { renderEquipe(); return; }
    try {
      await db.collection('usuarios').doc(uid).update({ papel: sel.value });
      toast('Papel atualizado.', 'ok');
    } catch (e2) {
      toast(msgErroFirebase(e2), 'erro');
      renderEquipe();
    }
  });

})();
