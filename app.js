/* ============================================================
   Reembolso de Viagem — app.js
   Front-end estático (GitHub Pages) + Firebase Auth/Firestore.
   Comprovantes: imagem comprimida no navegador e salva em base64
   na coleção `comprovantes` (o plano gratuito não inclui Storage).
   Uma solicitação pode ter várias despesas do mesmo dia (lote):
   cada despesa é um doc próprio ligado pelo campo `loteId`, e o
   moderador aprova/nega cada uma individualmente.
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
  const MAX_ITENS = 10;              // despesas por solicitação (limite do batch)

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
- Lance as despesas aqui no sistema, na aba **Nova** — dá para adicionar várias despesas do mesmo dia numa única solicitação (ex.: café, almoço e jantar), cada uma com o próprio comprovante.
- A **descrição é obrigatória** em cada despesa (ex.: "almoço no evento de sábado").
- Cada despesa é avaliada individualmente: pode ser aprovada, aprovada parcialmente ou negada (negativas e aprovações parciais vêm com o motivo).
- Mantenha sua **chave PIX** cadastrada — é por ela que os reembolsos são pagos.

## 6. Datas de Pagamento
- Os pagamentos seguem ciclos de **7 dias úteis** após a solicitação.
- Datas de pagamento: dias **15, 20, 25 e 30**.`;

  // ---------- Estado ----------
  let usuarioAtual = null;
  let perfil = null;             // { uid, nome, email, papel, pix }
  let params = Object.assign({}, PARAMS_PADRAO);
  let regrasTexto = REGRAS_PADRAO;
  let regrasMeta = null;
  let minhas = [];
  let todas = [];
  let usuarios = [];
  let filaAberta = new Set();    // [RM] ids dos itens de pagamento ainda 'aguardando'
  let itens = [novoItem()];      // despesas da nova solicitação
  let unsubs = [];
  let cadastroEmAndamento = false;
  let urlModalAtual = null;
  let abaAtual = null;

  function novoItem() {
    return { categoria: '', subtipo: 'Uber X', km: '', valor: '', justificativa: '', descricao: '', comprovante: null };
  }

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
  // [RM] Timestamp do Firestore (ou Date) → "27/07/2026 14:32"
  function fmtDataHora(ts) {
    const d = ts && ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : null);
    if (!d) return '';
    return String(d.getDate()).padStart(2, '0') + '/' +
      String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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
  const ehParcial = (s) => s.status === 'aprovada' &&
    typeof s.valorAprovado === 'number' && s.valorAprovado < s.valor - 0.004;
  function rotuloDe(s) {
    if (s.status === 'pendente') return 'Pendente';
    if (s.status === 'negada') return 'Negada';
    if (s.status === 'cancelada') return 'Cancelada';
    return ehParcial(s) ? 'Aprovada parcial' : 'Aprovada';
  }
  const chipDe = (s) =>
    '<span class="chip chip-' + (ehParcial(s) ? 'parcial' : s.status) + '">' + rotuloDe(s) + '</span>';
  const sugeridoDe = (s) => typeof s.valorSugerido === 'number' ? s.valorSugerido : s.valor;
  const docsToArr = (snap) =>
    snap.docs.map((d) => Object.assign({ id: d.id }, d.data({ serverTimestamps: 'estimate' })));
  const ordCriado = (a, b) =>
    ((b.criadoEm && b.criadoEm.toMillis ? b.criadoEm.toMillis() : 0) -
     (a.criadoEm && a.criadoEm.toMillis ? a.criadoEm.toMillis() : 0));
  const ehMod = () => perfil && perfil.papel === 'moderador';
  const cent = (n) => Math.round(n * 100) / 100;

  // [RM] Decisão já tomada — elegível a revisão.
  const jaModerada = (s) => s.status === 'aprovada' || s.status === 'negada';
  // [RM] Enquanto o item da fila estiver 'aguardando', a decisão ainda
  // pode ser revista. Despesa sem pagamentoId (nunca entrou na fila, ou
  // doc anterior ao gancho M2) é sempre revisável. Item que saiu do
  // 'aguardando' = PIX já criado na Conta Simples ⇒ trava.
  // Fail-closed de propósito: se o listener da fila falhar, filaAberta
  // fica vazia e nenhuma aprovação com pagamentoId é liberada.
  const revisavel = (s) => !s.pagamentoId || filaAberta.has(s.pagamentoId);
  // [RM/B] Trava de autoria (arbitragem do Lucas, 2026-07-27): quem revê
  // é quem decidiu. As rules abrem exceção para o papel 'admin' — este
  // app ainda não conhece esse papel (ehMod() só reconhece 'moderador'),
  // então aqui a checagem é só de autoria; quando o admin entrar no app
  // de reembolso, basta somar o papel a esta linha.
  // Doc antigo (pré-M2) guarda o NOME em moderadoPor, nunca um uid —
  // cai no bloqueio e só admin resolve, pelo console ou pelo módulo novo.
  const souAutor = (s) => !!perfil && s.moderadoPor === perfil.uid;

  function nomeDe(sol) {
    const u = usuarios.find((x) => x.id === sol.uid);
    return (u && u.nome) || sol.nome || '—';
  }
  function pixDe(uid) {
    const u = usuarios.find((x) => x.id === uid);
    return (u && u.pix) || '';
  }
  // Agrupa solicitações enviadas juntas (mesmo loteId); doc antigo sem lote fica sozinho
  function agruparPorLote(arr) {
    const grupos = {};
    const ordem = [];
    arr.forEach((s) => {
      const k = s.loteId || s.id;
      if (!grupos[k]) { grupos[k] = []; ordem.push(k); }
      grupos[k].push(s);
    });
    return ordem.map((k) => grupos[k]);
  }
  function copiarTexto(txt) {
    const ok = () => toast('Copiado: ' + txt, 'ok');
    const falha = () => toast('Não consegui copiar — selecione e copie manualmente.', 'erro');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(ok, falha);
    } else {
      const ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); } catch (_) { falha(); }
      ta.remove();
    }
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
      'app/perfil-falhou': 'Sua conta foi criada, mas o perfil não ativou. Use "Entrar" com o mesmo e-mail e senha.'
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
    const pix = $('#cadPix').value.trim();
    if (!nome) { mostrarErroLogin('Informe seu nome completo.'); return; }
    if (!pix) { mostrarErroLogin('Informe sua chave PIX — é por ela que você recebe os reembolsos.'); return; }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    cadastroEmAndamento = true;
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, senha);
      try {
        await cred.user.updateProfile({ displayName: nome });
        await db.collection('usuarios').doc(cred.user.uid).set({
          nome: nome, email: email, pix: pix, papel: 'funcionario', criadoEm: FV.serverTimestamp()
        });
      } catch (errDoc) {
        // falha inesperada ao criar o perfil — o login completa depois
        throw { code: 'app/perfil-falhou' };
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
      minhas = []; todas = []; usuarios = [];
      itens = [novoItem()];
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
    if (!perfil.pix) abrirPixModal(true);
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
      renderPixCard();
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
      renderItens();
    }, () => {}));

    // Minhas solicitações (todos)
    unsubs.push(db.collection('solicitacoes').where('uid', '==', perfil.uid)
      .onSnapshot((s) => { minhas = docsToArr(s); renderMinhas(); },
        (e) => toast(msgErroFirebase(e), 'erro')));

    // Moderador: tudo + usuários
    if (ehMod()) {
      unsubs.push(db.collection('solicitacoes').onSnapshot((s) => {
        todas = docsToArr(s); renderPainel();
      }, (e) => toast(msgErroFirebase(e), 'erro')));
      unsubs.push(db.collection('usuarios').onSnapshot((s) => {
        usuarios = docsToArr(s).sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
        preencherFiltroFuncionarios(); renderPainel(); renderEquipe();
      }, () => {}));

      // [RM] Itens de reembolso ainda ABERTOS na fila de pagamento.
      // Serve só para saber se uma aprovação ainda pode ser revista —
      // o painel do moderador não mostra nenhum dado de pagamento.
      // Falha (rules antigas / coleção inexistente) deixa o Set vazio:
      // trava as revisões em vez de liberar (fail-closed).
      unsubs.push(db.collection('pagamentos')
        .where('tipo', '==', 'reembolso')
        .where('status', '==', 'aguardando')
        .onSnapshot((s) => {
          filaAberta = new Set(s.docs.map((d) => d.id));
          renderPainel();
        }, () => { filaAberta = new Set(); renderPainel(); }));
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
    renderItens();
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
  // CHAVE PIX
  // ============================================================
  function renderPixCard() {
    const el = $('#pixCard');
    if (!el || !perfil) return;
    if (perfil.pix) {
      el.innerHTML =
        '<span class="pix-rotulo">💠 Chave PIX para reembolso:</span> <b>' + esc(perfil.pix) + '</b>' +
        '<button class="btn" id="btnEditarPix">✏️ Alterar</button>';
    } else {
      el.innerHTML =
        '<span class="pix-rotulo">💠 Você ainda não cadastrou sua chave PIX.</span>' +
        '<button class="btn primario" id="btnEditarPix">Cadastrar PIX</button>';
    }
    el.hidden = false;
    $('#btnEditarPix').addEventListener('click', () => abrirPixModal(false));
  }

  function abrirPixModal(primeiroAcesso) {
    abrirModal(
      '<h3>💠 ' + (primeiroAcesso ? 'Cadastre sua chave PIX' : 'Minha chave PIX') + '</h3>' +
      (primeiroAcesso
        ? '<p>É por ela que os reembolsos aprovados são pagos. Ela fica visível para os moderadores.</p>' : '') +
      '<label>Chave PIX <span class="mini">(CPF, e-mail, telefone ou chave aleatória)</span>' +
      '<input type="text" id="mdPix" value="' + esc((perfil && perfil.pix) || '') + '"></label>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">' + (primeiroAcesso ? 'Agora não' : 'Cancelar') + '</button>' +
      '<button class="btn primario" id="mdSalvarPix">Salvar</button></div>');
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdSalvarPix').addEventListener('click', async () => {
      const pix = $('#mdPix').value.trim();
      if (!pix) { toast('Informe a chave PIX.', 'erro'); return; }
      try {
        await db.collection('usuarios').doc(perfil.uid).update({ pix: pix });
        perfil.pix = pix;
        renderPixCard();
        toast('Chave PIX salva!', 'ok');
        fecharModal();
      } catch (e2) { toast(msgErroFirebase(e2), 'erro'); }
    });
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
  // NOVA SOLICITAÇÃO (várias despesas do dia num só envio)
  // ============================================================
  const nvData = $('#nvData');
  const nvItensEl = $('#nvItens');
  const alimBox = $('#alimBox');

  const HINTS = {
    'Alimentação': () => 'Cupom fiscal obrigatório — print de pix/cartão NÃO vale. Limite do dia: ' + fmtBRL(params.limiteDiaAlimentacao) + '.',
    'Uber': () => 'Anexe o print com o endereço do deslocamento e o valor final. Uber X é o padrão; Comfort exige justificativa.',
    'Combustível': () => 'Anexe o print da rota no Maps. Valor calculado automaticamente: km × ' + fmtBRL(params.taxaKm) + '.',
    'Hospedagem': () => 'Airbnb deve ser alinhado previamente com a Lilian (café da manhã: R$ 40,00).',
    'Outros': () => 'Descreva a despesa e anexe o cupom fiscal.'
  };
  const CATEGORIAS = ['Alimentação', 'Uber', 'Combustível', 'Hospedagem', 'Outros'];

  function renderItens() {
    if (!nvItensEl) return;
    nvItensEl.innerHTML = itens.map((it, i) => {
      let html = '<div class="item-despesa">' +
        '<div class="item-topo"><span class="item-num">Despesa ' + (i + 1) + '</span>' +
        (itens.length > 1
          ? '<button type="button" class="btn perigo" data-acao="remover-item" data-idx="' + i + '">✕ Remover</button>'
          : '') +
        '</div>' +
        '<label>Categoria<select data-idx="' + i + '" data-campo="categoria">' +
        '<option value="">Selecione…</option>' +
        CATEGORIAS.map((c) => '<option' + (it.categoria === c ? ' selected' : '') + '>' + c + '</option>').join('') +
        '</select></label>';

      if (it.categoria && HINTS[it.categoria])
        html += '<p class="hint">' + esc(HINTS[it.categoria]()) + '</p>';

      if (it.categoria === 'Uber') {
        html += '<span class="rotulo">Categoria do Uber</span><div class="radios">' +
          ['Uber X', 'Uber Comfort'].map((s) =>
            '<label class="radio"><input type="radio" name="nvSubtipo' + i + '" value="' + s + '"' +
            (it.subtipo === s ? ' checked' : '') + ' data-idx="' + i + '" data-campo="subtipo"> ' + s + '</label>'
          ).join('') + '</div>';
      }
      if (it.categoria === 'Combustível') {
        html += '<label>Quilômetros rodados' +
          '<input type="text" inputmode="decimal" placeholder="ex.: 15,7" value="' + esc(it.km) + '"' +
          ' data-idx="' + i + '" data-campo="km"></label>' +
          '<p class="hint">' + esc(fmtBRL(params.taxaKm)) + ' por km — o valor é calculado automaticamente.</p>';
      }

      html += '<label>Valor (R$)' +
        '<input type="text" inputmode="decimal" placeholder="ex.: 60,00" value="' + esc(it.valor) + '"' +
        ' data-idx="' + i + '" data-campo="valor"' +
        (it.categoria === 'Combustível' ? ' readonly' : '') + '></label>';

      if (it.categoria === 'Uber' && it.subtipo === 'Uber Comfort') {
        html += '<label>Justificativa <b class="obrig">(obrigatória para Uber Comfort)</b>' +
          '<textarea rows="2" placeholder="Ex.: sem carros no Uber X, reunião com horário rígido…"' +
          ' data-idx="' + i + '" data-campo="justificativa">' + esc(it.justificativa) + '</textarea></label>';
      }

      html += '<label>Descrição <b class="obrig">(obrigatória)</b>' +
        '<input type="text" placeholder="ex.: almoço no evento de sábado" value="' + esc(it.descricao) + '"' +
        ' data-idx="' + i + '" data-campo="descricao"></label>';

      html += '<span class="rotulo">Comprovante <b class="obrig">(obrigatório — cupom fiscal)</b></span>';
      if (it.comprovante) {
        const kb = Math.round(it.comprovante.dados.length * 3 / 4 / 1024);
        html += '<div class="preview">' +
          (it.comprovante.mime === 'application/pdf'
            ? '<span class="pdf-icone">📄</span>'
            : '<img src="' + it.comprovante.dados + '" alt="comprovante">') +
          '<div class="preview-info"><b>' + esc(it.comprovante.nome) + '</b>' +
          '<span class="mini">' + kb + ' KB · pronto para envio</span></div>' +
          '<button type="button" class="btn perigo" data-acao="remover-arq" data-idx="' + i + '">✕</button></div>';
      } else {
        html += '<label class="upload">' +
          '<input type="file" accept="image/*,application/pdf" hidden data-idx="' + i + '" data-campo="arquivo">' +
          '<span>📎 Tirar foto ou anexar arquivo</span></label>';
      }

      html += '</div>';
      return html;
    }).join('');
  }

  nvItensEl.addEventListener('input', (e) => {
    const el = e.target;
    const idx = parseInt(el.dataset.idx, 10);
    const campo = el.dataset.campo;
    if (isNaN(idx) || !campo || !itens[idx]) return;
    if (campo === 'km') {
      itens[idx].km = el.value;
      const km = parseValor(el.value);
      itens[idx].valor = (km > 0) ? fmtNum(Math.round(km * params.taxaKm * 100) / 100) : '';
      const valorInput = nvItensEl.querySelector('input[data-idx="' + idx + '"][data-campo="valor"]');
      if (valorInput) valorInput.value = itens[idx].valor;
    } else if (campo === 'valor' || campo === 'justificativa' || campo === 'descricao') {
      itens[idx][campo] = el.value;
    }
    if (campo === 'valor') checarAlimentacaoDebounced();
  });

  nvItensEl.addEventListener('change', async (e) => {
    const el = e.target;
    const idx = parseInt(el.dataset.idx, 10);
    const campo = el.dataset.campo;
    if (isNaN(idx) || !campo || !itens[idx]) return;
    if (campo === 'categoria') {
      itens[idx].categoria = el.value;
      if (el.value === 'Combustível') { itens[idx].valor = ''; itens[idx].km = ''; }
      renderItens();
      checarAlimentacaoDebounced();
    } else if (campo === 'subtipo') {
      itens[idx].subtipo = el.value;
      renderItens();
    } else if (campo === 'arquivo') {
      const file = el.files[0];
      if (!file) return;
      const span = el.parentElement.querySelector('span');
      if (span) span.textContent = '⏳ Processando arquivo…';
      try {
        itens[idx].comprovante = await processarArquivo(file);
      } catch (err) {
        itens[idx].comprovante = null;
        toast(err.message, 'erro');
      }
      renderItens();
    }
  });

  nvItensEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    if (btn.dataset.acao === 'remover-item') {
      itens.splice(idx, 1);
      if (!itens.length) itens.push(novoItem());
      renderItens();
      checarAlimentacaoDebounced();
    }
    if (btn.dataset.acao === 'remover-arq' && itens[idx]) {
      itens[idx].comprovante = null;
      renderItens();
    }
  });

  $('#btnAddItem').addEventListener('click', () => {
    if (itens.length >= MAX_ITENS) {
      toast('Máximo de ' + MAX_ITENS + ' despesas por solicitação — envie esta e crie outra.', 'erro');
      return;
    }
    itens.push(novoItem());
    renderItens();
  });

  // --- Validação automática de alimentação (limite do dia, somando os itens) ---
  async function checarAlimentacao() {
    alimBox.hidden = true;
    const dataDesp = nvData.value;
    const alim = [];
    itens.forEach((it, i) => {
      if (it.categoria === 'Alimentação') {
        const v = parseValor(it.valor);
        if (v > 0) alim.push({ idx: i, valor: v });
      }
    });
    if (!dataDesp || !alim.length) return null;

    const snap = await db.collection('solicitacoes')
      .where('uid', '==', perfil.uid)
      .where('categoria', '==', 'Alimentação')
      .where('dataDespesa', '==', dataDesp)
      .get();
    // [RM] 'cancelada' entra junto com 'negada': despesa cancelada não
    // consome o limite diário de alimentação.
    const anteriores = snap.docs.map((d) => d.data())
      .filter((d) => d.status !== 'negada' && d.status !== 'cancelada');
    const efetivo = (d) => d.status === 'aprovada'
      ? (typeof d.valorAprovado === 'number' ? d.valorAprovado : d.valor)
      : (typeof d.valorSugerido === 'number' ? d.valorSugerido : d.valor);
    const somaAnterior = Math.round(anteriores.reduce((s, d) => s + efetivo(d), 0) * 100) / 100;

    const limite = params.limiteDiaAlimentacao;
    let disponivel = Math.max(0, Math.round((limite - somaAnterior) * 100) / 100);
    const porIdx = {};
    let somaNovos = 0, descontoTotal = 0;
    alim.forEach((a) => {
      const considerado = Math.round(Math.min(a.valor, disponivel) * 100) / 100;
      disponivel = Math.round((disponivel - considerado) * 100) / 100;
      porIdx[a.idx] = { considerado: considerado, desconto: Math.round((a.valor - considerado) * 100) / 100 };
      somaNovos = Math.round((somaNovos + a.valor) * 100) / 100;
      descontoTotal = Math.round((descontoTotal + a.valor - considerado) * 100) / 100;
    });
    const somaDia = Math.round((somaAnterior + somaNovos) * 100) / 100;

    if (descontoTotal > 0) {
      alimBox.className = 'aviso';
      alimBox.innerHTML =
        '⚠️ <b>Limite diário de alimentação ultrapassado.</b><br>' +
        'Dia ' + fmtData(dataDesp) + ': ' +
        (somaAnterior > 0 ? 'já lançado ' + fmtBRL(somaAnterior) + ' + ' : '') +
        'alimentação desta solicitação ' + fmtBRL(somaNovos) + ' = <b>' + fmtBRL(somaDia) +
        '</b> (limite ' + fmtBRL(limite) + ').<br>Desconto automático: <b>' + fmtBRL(descontoTotal) +
        '</b> → você recebe <b>' + fmtBRL(Math.round((somaNovos - descontoTotal) * 100) / 100) +
        '</b> de alimentação nesta solicitação.';
      alimBox.hidden = false;
    } else if (somaAnterior > 0) {
      alimBox.className = 'aviso ok';
      alimBox.innerHTML = 'ℹ️ Já lançado ' + fmtBRL(somaAnterior) + ' de alimentação em ' +
        fmtData(dataDesp) + '. Com esta solicitação: ' + fmtBRL(somaDia) +
        ' — dentro do limite de ' + fmtBRL(limite) + '.';
      alimBox.hidden = false;
    }
    return { porIdx: porIdx, somaDia: somaDia, descontoTotal: descontoTotal };
  }
  const checarAlimentacaoDebounced = debounce(() => {
    checarAlimentacao().catch(() => {});
  }, 500);
  nvData.addEventListener('change', checarAlimentacaoDebounced);

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

  // --- Envio (um doc por despesa, todos ligados pelo mesmo loteId) ---
  $('#formNova').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnEnviar');
    const dataDesp = nvData.value;

    if (!dataDesp) { toast('Informe a data da despesa.', 'erro'); return; }
    if (dataDesp > hojeISO()) { toast('A data da despesa não pode ser futura.', 'erro'); return; }

    for (let i = 0; i < itens.length; i++) {
      const it = itens[i];
      const rot = itens.length > 1 ? 'Despesa ' + (i + 1) + ': ' : '';
      if (!it.categoria) { toast(rot + 'selecione a categoria.', 'erro'); return; }
      if (it.categoria === 'Combustível') {
        const km = parseValor(it.km);
        if (!(km > 0)) { toast(rot + 'informe os km rodados.', 'erro'); return; }
        it.valor = fmtNum(Math.round(km * params.taxaKm * 100) / 100);
      }
      if (!(parseValor(it.valor) > 0)) { toast(rot + 'informe um valor válido.', 'erro'); return; }
      if (it.categoria === 'Uber' && it.subtipo === 'Uber Comfort' && !it.justificativa.trim()) {
        toast(rot + 'Uber Comfort exige justificativa — explique a exceção.', 'erro'); return;
      }
      if (!it.descricao.trim()) { toast(rot + 'a descrição é obrigatória.', 'erro'); return; }
      if (!it.comprovante) { toast(rot + 'anexe o comprovante — sem cupom fiscal não há reembolso.', 'erro'); return; }
    }

    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const alim = await checarAlimentacao();
      const loteId = db.collection('solicitacoes').doc().id;
      const batch = db.batch();
      itens.forEach((it, i) => {
        const id = db.collection('solicitacoes').doc().id;
        const valor = parseValor(it.valor);
        const a = alim && alim.porIdx[i] ? alim.porIdx[i] : null;
        batch.set(db.collection('comprovantes').doc(id), {
          uid: perfil.uid, dados: it.comprovante.dados, mime: it.comprovante.mime,
          nome: it.comprovante.nome, criadoEm: FV.serverTimestamp()
        });
        batch.set(db.collection('solicitacoes').doc(id), {
          uid: perfil.uid,
          nome: perfil.nome,
          loteId: loteId,
          dataDespesa: dataDesp,
          categoria: it.categoria,
          subtipo: it.categoria === 'Uber' ? it.subtipo : null,
          km: it.categoria === 'Combustível' ? parseValor(it.km) : null,
          valor: valor,
          descricao: it.descricao.trim(),
          justificativa: (it.categoria === 'Uber' && it.subtipo === 'Uber Comfort') ? it.justificativa.trim() : '',
          status: 'pendente',
          observacao: '',
          valorSugerido: a ? a.considerado : valor,
          alimDesconto: a ? a.desconto : 0,
          alimTotalDia: a ? alim.somaDia : null,
          comprovanteMime: it.comprovante.mime,
          criadoEm: FV.serverTimestamp()
        });
      });
      await batch.commit();

      toast(itens.length > 1
        ? 'Solicitação enviada com ' + itens.length + ' despesas! Acompanhe em "Minhas".'
        : 'Solicitação enviada! Acompanhe em "Minhas".', 'ok');
      e.target.reset();
      itens = [novoItem()];
      renderItens();
      alimBox.hidden = true;
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
    renderPixCard();
    const lista = $('#listaMinhas');
    const arr = minhas.slice().sort(ordCriado);
    if (!arr.length) {
      lista.innerHTML = '<div class="cartao vazio">Nenhuma solicitação ainda.<br>Crie a primeira na aba ➕ Nova.</div>';
      return;
    }
    lista.innerHTML = agruparPorLote(arr).map((g) => {
      const total = g.reduce((t, s) => t + (s.valor || 0), 0);
      const cab = g.length > 1
        ? '<div class="grupo-cab"><b>Solicitação de ' + fmtData(g[0].dataDespesa) + '</b>' +
          '<span class="mini">' + g.length + ' despesas · ' + fmtBRL(total) + '</span></div>'
        : '';
      return '<div class="cartao sol">' + cab +
        g.map((s) => itemMinhasHTML(s)).join('<hr class="sol-sep">') + '</div>';
    }).join('');
  }

  function itemMinhasHTML(s) {
    let extras = '';
    if (s.status === 'pendente' && s.alimDesconto > 0)
      extras += '<div class="sol-alerta">⚠️ Sujeita a desconto de ' + fmtBRL(s.alimDesconto) +
        ' (limite do dia) → reembolso previsto ' + fmtBRL(s.valorSugerido) + '</div>';
    if (s.status === 'aprovada')
      extras += '<div class="sol-obs-ok">✓ Aprovada' + (ehParcial(s) ? ' parcialmente' : '') +
        ': <b>' + fmtBRL(s.valorAprovado) + '</b>' +
        (ehParcial(s) ? ' <span class="mini">(solicitado ' + fmtBRL(s.valor) + ')</span>' : '') +
        (s.observacao ? '<br>' + esc(s.observacao) : '') + '</div>';
    if (s.status === 'negada')
      extras += '<div class="sol-obs"><b>Motivo da negativa:</b> ' + esc(s.observacao || '—') + '</div>';
    // [RM] Cancelada pelo moderador (substitui a exclusão física).
    if (s.status === 'cancelada')
      extras += '<div class="sol-obs"><b>Cancelada pelo moderador:</b> ' + esc(s.observacao || '—') + '</div>';
    // [RM] Aviso de decisão revista — o funcionário precisa saber que o
    // que ele leu antes mudou (a trilha completa fica no painel).
    if (Array.isArray(s.historicoModeracao) && s.historicoModeracao.length)
      extras += '<div class="sol-info mini">↻ Decisão revista ' +
        (s.historicoModeracao.length > 1 ? s.historicoModeracao.length + ' vezes' : '1 vez') +
        (s.moderadoEm && s.moderadoEm.toDate ? ' · última em ' + fmtDataHora(s.moderadoEm) : '') + '</div>';
    return '<div class="sol-item">' +
      '<div class="sol-topo">' + chipDe(s) + '<b>' + fmtBRL(s.valor) + '</b></div>' +
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
  }

  $('#listaMinhas').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    if (btn.dataset.acao === 'ver') verComprovante(btn.dataset.id);
    if (btn.dataset.acao === 'excluir') confirmarExcluir(btn.dataset.id);
  });

  function confirmarExcluir(id) {
    abrirModal(
      '<h3>Excluir despesa?</h3>' +
      '<p>A despesa e o comprovante serão apagados. Essa ação não pode ser desfeita.</p>' +
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
        toast('Despesa excluída.', 'ok');
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
    if (!arr.length) {
      lista.innerHTML = '<div class="cartao vazio">Nada por aqui com esses filtros. 🎉</div>';
      renderTotalizador();
      return;
    }

    lista.innerHTML = agruparPorLote(arr).map((g) => {
      const pix = pixDe(g[0].uid);
      const chaveLote = g[0].loteId || g[0].id;
      const totalLote = g[0].loteId ? todas.filter((s) => s.loteId === g[0].loteId).length : 1;
      const pend = g.filter((s) => s.status === 'pendente');
      let cab = '<div class="sol-nome">' + esc(nomeDe(g[0])) + '</div>' +
        '<div class="pix-linha">' + (pix
          ? '💠 PIX: <b>' + esc(pix) + '</b><button class="btn btn-copiar" data-acao="copiar-pix" data-pix="' +
            esc(pix) + '">⧉ copiar</button>'
          : '💠 PIX não cadastrado') + '</div>';
      if (totalLote > 1)
        cab += '<div class="sol-info">Solicitação de ' + fmtData(g[0].dataDespesa) + ' com ' + totalLote +
          ' despesas' + (g.length < totalLote ? ' — mostrando ' + g.length + ' (filtro de status)' : '') + '</div>';
      const rodape = pend.length > 1
        ? '<div class="sol-botoes lote-botoes"><button class="btn sucesso" data-acao="aprovar-lote" data-lote="' +
          chaveLote + '">✓ Aprovar as ' + pend.length + ' pendentes</button></div>'
        : '';
      return '<div class="cartao sol">' + cab +
        g.map((s) => itemPainelHTML(s)).join('<hr class="sol-sep">') + rodape + '</div>';
    }).join('');

    renderTotalizador();
  }

  function itemPainelHTML(s) {
    return '<div class="sol-item">' +
      '<div class="sol-topo">' + chipDe(s) + '<b>' + fmtBRL(s.valor) + '</b></div>' +
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
        ? '<div class="sol-obs-ok">✓ Aprovada' + (ehParcial(s) ? ' parcialmente' : '') +
          ': <b>' + fmtBRL(s.valorAprovado) + '</b>' +
          (ehParcial(s) ? ' <span class="mini">(solicitado ' + fmtBRL(s.valor) + ')</span>' : '') +
          (s.moderadoPor ? ' · por ' + esc(nomeModeradoPor(s.moderadoPor)) : '') +
          (s.observacao ? '<br>' + esc(s.observacao) : '') + '</div>' : '') +
      (s.status === 'negada'
        ? '<div class="sol-obs"><b>Negada' + (s.moderadoPor ? ' por ' + esc(nomeModeradoPor(s.moderadoPor)) : '') +
          ':</b> ' + esc(s.observacao) + '</div>' : '') +
      (s.status === 'cancelada'
        ? '<div class="sol-obs"><b>Cancelada' + (s.moderadoPor ? ' por ' + esc(nomeModeradoPor(s.moderadoPor)) : '') +
          ':</b> ' + esc(s.observacao || '—') + '</div>' : '') +
      histModeracaoHTML(s) +
      '<div class="sol-botoes">' +
      '<button class="btn" data-acao="ver" data-id="' + s.id + '">📄 Comprovante</button>' +
      (s.status === 'pendente'
        ? '<button class="btn sucesso" data-acao="aprovar" data-id="' + s.id + '">✓ Aprovar</button>' +
          '<button class="btn perigo" data-acao="negar" data-id="' + s.id + '">✕ Negar</button>' +
          '<button class="btn" data-acao="cancelar" data-id="' + s.id + '">🚫 Cancelar</button>'
        : '') +
      // [RM] Decisão já tomada: rever ou cancelar. Duas travas, nesta
      // ordem — o pagamento que já saiu vale mais que a autoria.
      (jaModerada(s)
        ? (!revisavel(s)
          ? '<span class="sol-travada">🔒 Pagamento já enviado ao BPO — ajuste só por estorno na Conta Simples</span>'
          : !souAutor(s)
          ? '<span class="sol-travada">🔒 Quem decidiu foi ' + esc(nomeModeradoPor(s.moderadoPor)) +
            ' — só essa pessoa (ou um admin) pode rever</span>'
          : '<button class="btn" data-acao="rever" data-id="' + s.id + '">✏️ Rever decisão</button>' +
            '<button class="btn" data-acao="cancelar" data-id="' + s.id + '">🚫 Cancelar</button>')
        : '') +
      '</div></div>';
  }

  // [RM] Trilha de decisões — só o painel do moderador mostra completa.
  // Cada entrada é um snapshot da decisão ANTERIOR, empilhada no
  // momento em que ela foi substituída.
  function histModeracaoHTML(s) {
    const h = Array.isArray(s.historicoModeracao) ? s.historicoModeracao : [];
    if (!h.length) return '';
    const rot = (d) => d.status === 'aprovada' ? 'Aprovada'
      : d.status === 'negada' ? 'Negada'
      : d.status === 'cancelada' ? 'Cancelada' : 'Pendente';
    return '<details class="sol-hist"><summary>↻ Histórico de decisões (' + h.length + ')</summary>' +
      h.map((d) => '<div class="sol-hist-item"><b>' + esc(rot(d)) + '</b>' +
        (typeof d.valorAprovado === 'number' ? ' · ' + fmtBRL(d.valorAprovado) : '') +
        ' · ' + esc(nomeModeradoPor(d.por)) +
        (d.em ? ' · ' + fmtDataHora(d.em) : '') +
        (d.observacao ? '<br><span class="mini">' + esc(d.observacao) + '</span>' : '') +
        '</div>').join('') + '</details>';
  }

  $('#listaPainel').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    const acao = btn.dataset.acao;
    if (acao === 'copiar-pix') { copiarTexto(btn.dataset.pix); return; }
    if (acao === 'aprovar-lote') { abrirAprovarLote(btn.dataset.lote); return; }
    const sol = todas.find((s) => s.id === btn.dataset.id);
    if (acao === 'ver') verComprovante(btn.dataset.id);
    if (acao === 'aprovar' && sol) abrirAprovar(sol);
    if (acao === 'negar' && sol) abrirNegar(sol);
    if (acao === 'rever' && sol) abrirRever(sol);       // [RM]
    if (acao === 'cancelar' && sol) abrirCancelar(sol); // [RM]
  });

  // ============================================================
  // [M2] GANCHO RF-1 — a aprovação alimenta a fila de pagamento
  // (coleção `pagamentos`) na MESMA transaction que grava a
  // aprovação. Falha na fila = falha na aprovação (atômico).
  // ============================================================

  // [M2/P8] moderadoPor agora guarda o UID do moderador (trilha
  // confiável nas rules). Docs ANTIGOS guardam o nome — se o valor
  // não for uid de um usuário conhecido, exibe como está.
  function nomeModeradoPor(v) {
    if (!v) return '';
    const u = usuarios.find((x) => x.id === v);
    return (u && u.nome) || v;
  }

  function erroFila(codigo) {
    const e = new Error(codigo);
    e.codigo = codigo;
    return e;
  }
  function msgErroFila(e) {
    if (e && e.codigo === 'JA_MODERADA')
      return 'Essa despesa já foi moderada — o painel atualiza sozinho.';
    if (e && e.codigo === 'SEM_CADASTRO')
      return 'Funcionário sem cadastro ativo — aprovação cancelada.';
    if (e && e.codigo === 'LOTE_MISTO')
      return 'Erro interno: despesas de funcionários diferentes na mesma aprovação.';
    // [RM] códigos da revisão de decisão
    if (e && e.codigo === 'PAGAMENTO_ENVIADO')
      return 'O pagamento dessa despesa já saiu para o BPO — não dá para revisar aqui. ' +
        'A correção é por estorno na Conta Simples.';
    if (e && e.codigo === 'JA_CANCELADA')
      return 'Essa despesa já está cancelada.';
    if (e && e.codigo === 'AINDA_PENDENTE')
      return 'Essa despesa ainda está pendente — use Aprovar ou Negar.';
    if (e && e.codigo === 'SUMIU')
      return 'Despesa não encontrada — o painel atualiza sozinho.';
    if (e && e.codigo === 'NAO_E_AUTOR')
      return 'Quem tomou essa decisão foi outro moderador — só essa pessoa (ou um admin) pode revê-la.';
    return msgErroFirebase(e);
  }

  // Item ABERTO (aguardando) da fila para o funcionário. A busca é
  // FORA da transaction (o SDK web não faz query dentro de
  // transaction) — a transaction re-lê o doc e revalida o status
  // antes de agregar (edge §10: se virou 'enviado', abre item novo).
  async function acharItemFilaAberto(uid) {
    const q = await db.collection('pagamentos')
      .where('tipo', '==', 'reembolso')
      .where('uidFuncionario', '==', uid)
      .where('status', '==', 'aguardando')
      .limit(1).get();
    return q.empty ? null : q.docs[0].ref;
  }

  // Aprova 1..N despesas do MESMO funcionário e alimenta a fila:
  // agrega no item 'aguardando' existente ou cria um novo (§6).
  // Regras duras:
  // - transaction (nunca batch): re-lê solicitações, cadastro e item
  //   da fila; corrida → retry automático do SDK;
  // - pix lido FRESCO de usuarios/{uid} DENTRO da transaction —
  //   nunca de cache; sem pix ⇒ chavePix null (aprovação prossegue);
  // - item 'enviado'/'pago' NUNCA é alterado — abre item novo;
  // - total aprovado R$ 0 → fila intocada (nada a pagar).
  async function aprovarComFila(itensAprovar) {
    const uidFav = itensAprovar[0].uid;
    const refCandidata = await acharItemFilaAberto(uidFav);
    await db.runTransaction(async (tx) => {
      // ---- leituras (todas antes de qualquer escrita) ----
      const solRefs = itensAprovar.map((it) => db.collection('solicitacoes').doc(it.id));
      const solSnaps = [];
      for (let i = 0; i < solRefs.length; i++) solSnaps.push(await tx.get(solRefs[i]));
      solSnaps.forEach((s) => {
        if (!s.exists || s.data().status !== 'pendente') throw erroFila('JA_MODERADA');
        if (s.data().uid !== uidFav) throw erroFila('LOTE_MISTO');
      });
      const userSnap = await tx.get(db.collection('usuarios').doc(uidFav));
      if (!userSnap.exists) throw erroFila('SEM_CADASTRO');
      const pixFresco = userSnap.data().pix ? String(userSnap.data().pix) : null;
      const nomeFresco = userSnap.data().nome || solSnaps[0].data().nome || '—';

      let filaSnap = null;
      if (refCandidata) filaSnap = await tx.get(refCandidata);
      const dFila = filaSnap && filaSnap.exists ? filaSnap.data() : null;
      const agregavel = !!(dFila && dFila.tipo === 'reembolso' &&
        dFila.uidFuncionario === uidFav && dFila.status === 'aguardando');

      const total = Math.round(itensAprovar.reduce((t, it) => t + it.valorAprovado, 0) * 100) / 100;
      const ids = itensAprovar.map((it) => it.id);

      // ---- escritas ----
      let pagamentoId = null;
      if (total > 0 && agregavel) {
        pagamentoId = refCandidata.id;
        tx.update(refCandidata, {
          valor: Math.round((dFila.valor + total) * 100) / 100,
          solicitacaoIds: FV.arrayUnion.apply(FV, ids),
          chavePix: pixFresco
        });
      } else if (total > 0) {
        const novoRef = db.collection('pagamentos').doc();
        pagamentoId = novoRef.id;
        tx.set(novoRef, {
          tipo: 'reembolso',
          status: 'aguardando',
          valor: total,
          uidFuncionario: uidFav,
          nomeFavorecido: nomeFresco,
          chavePix: pixFresco,
          solicitacaoIds: ids,
          criadoPor: perfil.uid,
          criadoEm: FV.serverTimestamp()
        });
      }
      itensAprovar.forEach((it, i) => {
        const campos = {
          status: 'aprovada',
          valorAprovado: it.valorAprovado,
          observacao: it.observacao,
          moderadoPor: perfil.uid,           // [M2/P8] uid, não nome
          moderadoEm: FV.serverTimestamp()
        };
        if (pagamentoId) campos.pagamentoId = pagamentoId;
        tx.update(solRefs[i], campos);
      });
    });
  }

  function abrirAprovar(sol) {
    const sugerido = sugeridoDe(sol);
    abrirModal(
      '<h3>Aprovar despesa</h3>' +
      '<p><b>' + esc(nomeDe(sol)) + '</b> — ' + esc(sol.categoria) +
      (sol.subtipo ? ' (' + esc(sol.subtipo) + ')' : '') + ' — ' + fmtData(sol.dataDespesa) + '</p>' +
      (sol.descricao ? '<p class="mini">' + esc(sol.descricao) + '</p>' : '') +
      '<p>Valor solicitado: <b>' + fmtBRL(sol.valor) + '</b></p>' +
      (sol.alimDesconto > 0
        ? '<div class="aviso">⚠️ Limite diário de alimentação ultrapassado. Desconto sugerido: <b>' +
          fmtBRL(sol.alimDesconto) + '</b> → reembolso sugerido <b>' + fmtBRL(sugerido) + '</b>.</div>'
        : '') +
      '<label>Valor a reembolsar (R$)' +
      '<input type="text" id="mdValorAprovado" inputmode="decimal" value="' + fmtNum(sugerido) + '"></label>' +
      '<label>Observação <span class="mini">(obrigatória se aprovar menos que o solicitado — fica visível para o funcionário)</span>' +
      '<textarea id="mdObsAprovar" rows="2"></textarea></label>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">Cancelar</button>' +
      '<button class="btn sucesso" id="mdConfirmar">✓ Confirmar aprovação</button></div>');
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdConfirmar').addEventListener('click', async () => {
      const v = parseValor($('#mdValorAprovado').value);
      const obs = $('#mdObsAprovar').value.trim();
      if (!(v >= 0)) { toast('Valor inválido.', 'erro'); return; }
      if (v > sol.valor) { toast('O valor aprovado não pode ser maior que o solicitado (' + fmtBRL(sol.valor) + ').', 'erro'); return; }
      if (v < sol.valor && v !== sugerido && !obs) {
        toast('Aprovação parcial exige observação — explique o motivo para o funcionário.', 'erro');
        $('#mdObsAprovar').focus();
        return;
      }
      try {
        // [M2] aprovação + fila na MESMA transaction (RF-1)
        await aprovarComFila([{ id: sol.id, uid: sol.uid, valorAprovado: v, observacao: obs }]);
        toast('Aprovada: ' + fmtBRL(v), 'ok');
        fecharModal();
      } catch (e2) { toast(msgErroFila(e2), 'erro'); }
    });
  }

  function abrirAprovarLote(chaveLote) {
    const pend = todas.filter((s) => (s.loteId || s.id) === chaveLote && s.status === 'pendente');
    if (!pend.length) return;
    const total = pend.reduce((t, s) => t + sugeridoDe(s), 0);
    abrirModal(
      '<h3>Aprovar todas as pendentes</h3>' +
      '<p><b>' + esc(nomeDe(pend[0])) + '</b> — solicitação de ' + fmtData(pend[0].dataDespesa) + '</p>' +
      '<ul class="lote-lista">' + pend.map((s) =>
        '<li>' + esc(s.categoria) + (s.subtipo ? ' (' + esc(s.subtipo) + ')' : '') +
        (s.descricao ? ' — ' + esc(s.descricao) : '') + ': <b>' + fmtBRL(sugeridoDe(s)) + '</b>' +
        (s.alimDesconto > 0
          ? ' <span class="mini">(desconto do limite do dia: ' + fmtBRL(s.alimDesconto) + ')</span>' : '') +
        '</li>').join('') + '</ul>' +
      '<p>Total a aprovar: <b>' + fmtBRL(Math.round(total * 100) / 100) + '</b></p>' +
      '<p class="mini">Cada despesa é aprovada pelo valor sugerido. Para ajustar o valor ou negar uma delas, use os botões da própria despesa.</p>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">Cancelar</button>' +
      '<button class="btn sucesso" id="mdConfirmar">✓ Aprovar ' + pend.length + ' despesas</button></div>');
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdConfirmar').addEventListener('click', async () => {
      try {
        // [M2] lote inteiro numa transaction ÚNICA (era batch):
        // aprova as N despesas e alimenta a fila UMA vez — todas as
        // despesas do lote são do mesmo funcionário, então agregam
        // no MESMO item (uma transação evita contenção entre elas)
        await aprovarComFila(pend.map((s) => ({
          id: s.id, uid: s.uid, valorAprovado: sugeridoDe(s), observacao: ''
        })));
        toast(pend.length + ' despesas aprovadas.', 'ok');
        fecharModal();
      } catch (e2) { toast(msgErroFila(e2), 'erro'); }
    });
  }

  function abrirNegar(sol) {
    abrirModal(
      '<h3>Negar despesa</h3>' +
      '<p><b>' + esc(nomeDe(sol)) + '</b> — ' + esc(sol.categoria) + ' — ' +
      fmtBRL(sol.valor) + ' — ' + fmtData(sol.dataDespesa) + '</p>' +
      (sol.descricao ? '<p class="mini">' + esc(sol.descricao) + '</p>' : '') +
      '<p class="mini">Só esta despesa será negada — as outras da mesma solicitação não são afetadas.</p>' +
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
          moderadoPor: perfil.uid,           // [M2/P8] uid, não nome
          moderadoEm: FV.serverTimestamp()
        });
        toast('Despesa negada.', 'ok');
        fecharModal();
      } catch (e2) { toast(msgErroFirebase(e2), 'erro'); }
    });
  }

  // ============================================================
  // [RM] REVISÃO DE DECISÃO JÁ TOMADA
  // Mesma disciplina do gancho RF-1: transaction única, TODAS as
  // leituras antes de qualquer escrita, item da fila só é tocado
  // enquanto 'aguardando'. A decisão anterior é empilhada em
  // historicoModeracao — nenhuma decisão se perde.
  // ============================================================

  // Fotografia da decisão vigente, para empilhar no histórico.
  // O timestamp reaproveita o moderadoEm do servidor da decisão que
  // está saindo; serverTimestamp() NÃO funciona dentro de elemento de
  // array, então o fallback é o relógio do cliente.
  function snapshotDecisao(d) {
    const e = {
      status: d.status,
      observacao: d.observacao || '',
      por: d.moderadoPor || '',
      em: d.moderadoEm || firebase.firestore.Timestamp.now()
    };
    if (typeof d.valorAprovado === 'number') e.valorAprovado = d.valorAprovado;
    return e;
  }

  // dec: { status: 'aprovada'|'negada'|'cancelada', valorAprovado, observacao }
  async function remoderar(sol, dec) {
    const entraNaFila = dec.status === 'aprovada' && dec.valorAprovado > 0;
    const jaTemItemAberto = !!sol.pagamentoId && filaAberta.has(sol.pagamentoId);
    // Só procura item de DESTINO quando a despesa não está num item
    // aberto — se está, o ajuste é no próprio item (não migra de item).
    const refCandidata = (entraNaFila && !jaTemItemAberto)
      ? await acharItemFilaAberto(sol.uid) : null;

    await db.runTransaction(async (tx) => {
      // ---- leituras (todas antes de qualquer escrita) ----
      const solRef = db.collection('solicitacoes').doc(sol.id);
      const solSnap = await tx.get(solRef);
      if (!solSnap.exists) throw erroFila('SUMIU');
      const at = solSnap.data();
      if (at.status === 'cancelada') throw erroFila('JA_CANCELADA');
      if (at.status === 'pendente' && dec.status !== 'cancelada') throw erroFila('AINDA_PENDENTE');
      // [RM/B] Autoria revalidada no dado FRESCO: entre abrir o modal e
      // confirmar, outro moderador pode ter revisado a mesma despesa.
      // (Espelha a trava das rules; a exceção de admin de lá não vale
      // aqui porque este app ainda não conhece o papel 'admin'.)
      if (at.status !== 'pendente' && at.moderadoPor !== perfil.uid)
        throw erroFila('NAO_E_AUTOR');

      const pagIdAtual = at.pagamentoId || null;
      let velhoRef = null, velhoSnap = null;
      if (pagIdAtual) {
        velhoRef = db.collection('pagamentos').doc(pagIdAtual);
        velhoSnap = await tx.get(velhoRef);
      }
      const velho = velhoSnap && velhoSnap.exists ? velhoSnap.data() : null;
      // Trava dura revalidada no servidor: item fora de 'aguardando'
      // significa PIX já criado na Conta Simples — nada se mexe.
      // ('cancelado' passa: o BPO já tirou o item, a despesa ficou solta.)
      if (velho && velho.status !== 'aguardando' && velho.status !== 'cancelado')
        throw erroFila('PAGAMENTO_ENVIADO');
      const velhoAberto = !!(velho && velho.status === 'aguardando');

      let destinoSnap = null;
      if (refCandidata) destinoSnap = await tx.get(refCandidata);
      // Cadastro lido FRESCO sempre que a fila for tocada: o snapshot
      // chavePix fica amarrado ao cadastro vigente (mesma amarra do
      // gancho RF-1 / rev. 4 das rules).
      let userSnap = null;
      if (velhoAberto || entraNaFila) {
        userSnap = await tx.get(db.collection('usuarios').doc(sol.uid));
        if (!userSnap.exists) throw erroFila('SEM_CADASTRO');
      }
      // ---- fim das leituras ----
      const pixFresco = userSnap && userSnap.data().pix ? String(userSnap.data().pix) : null;

      const v0 = at.status === 'aprovada' && typeof at.valorAprovado === 'number'
        ? at.valorAprovado : 0;
      const v1 = entraNaFila ? dec.valorAprovado : 0;
      let pagamentoIdFinal = null;

      if (velhoAberto && entraNaFila) {
        // (a) segue aprovada e já está num item aberto → só o delta
        const novoValor = cent(velho.valor - v0 + v1);
        if (novoValor <= 0) {
          tx.update(velhoRef, {
            status: 'cancelado',
            canceladoPor: perfil.uid,
            motivoCancelamento: 'Aprovação revista pelo moderador — item sem valor a pagar'
          });
        } else {
          pagamentoIdFinal = pagIdAtual;
          tx.update(velhoRef, { valor: novoValor, chavePix: pixFresco });
        }
      } else if (velhoAberto) {
        // (b) sai da fila (virou negada/cancelada, ou valor foi a zero)
        const restante = (velho.solicitacaoIds || []).filter((x) => x !== sol.id);
        const novoValor = cent(velho.valor - v0);
        if (!restante.length || novoValor <= 0) {
          tx.update(velhoRef, {
            status: 'cancelado',
            canceladoPor: perfil.uid,
            motivoCancelamento: 'Aprovação revista pelo moderador — item sem despesas a pagar'
          });
        } else {
          tx.update(velhoRef, {
            valor: novoValor, solicitacaoIds: restante, chavePix: pixFresco
          });
        }
      }

      if (entraNaFila && !velhoAberto) {
        // (c) reentrada na fila: agrega no item aberto ou cria um novo
        const dDest = destinoSnap && destinoSnap.exists ? destinoSnap.data() : null;
        const agregavel = !!(dDest && dDest.tipo === 'reembolso' &&
          dDest.uidFuncionario === sol.uid && dDest.status === 'aguardando');
        if (agregavel) {
          pagamentoIdFinal = refCandidata.id;
          tx.update(refCandidata, {
            valor: cent(dDest.valor + v1),
            solicitacaoIds: FV.arrayUnion(sol.id),
            chavePix: pixFresco
          });
        } else {
          const novoRef = db.collection('pagamentos').doc();
          pagamentoIdFinal = novoRef.id;
          tx.set(novoRef, {
            tipo: 'reembolso',
            status: 'aguardando',
            valor: v1,
            uidFuncionario: sol.uid,
            nomeFavorecido: userSnap.data().nome || at.nome || '—',
            chavePix: pixFresco,
            solicitacaoIds: [sol.id],
            criadoPor: perfil.uid,
            criadoEm: FV.serverTimestamp()
          });
        }
      }

      // ---- a despesa ----
      const campos = {
        status: dec.status,
        valorAprovado: dec.status === 'aprovada' ? dec.valorAprovado : 0,
        observacao: dec.observacao || '',
        moderadoPor: perfil.uid,
        moderadoEm: FV.serverTimestamp(),
        // append explícito (não arrayUnion): dentro da transaction o
        // valor lido é o corrente, e duas decisões idênticas não podem
        // colapsar num elemento só
        historicoModeracao: (at.historicoModeracao || []).concat([snapshotDecisao(at)]),
        pagamentoId: pagamentoIdFinal || FV.delete()
      };
      tx.update(solRef, campos);
    });
  }

  function abrirRever(sol) {
    const sugerido = sugeridoDe(sol);
    const vAtual = sol.status === 'aprovada' && typeof sol.valorAprovado === 'number'
      ? sol.valorAprovado : sugerido;
    abrirModal(
      '<h3>Rever decisão</h3>' +
      '<p><b>' + esc(nomeDe(sol)) + '</b> — ' + esc(sol.categoria) +
      (sol.subtipo ? ' (' + esc(sol.subtipo) + ')' : '') + ' — ' + fmtData(sol.dataDespesa) + '</p>' +
      (sol.descricao ? '<p class="mini">' + esc(sol.descricao) + '</p>' : '') +
      '<p>Valor solicitado: <b>' + fmtBRL(sol.valor) + '</b></p>' +
      '<div class="aviso">Decisão atual: <b>' + esc(rotuloDe(sol)) + '</b>' +
      (sol.status === 'aprovada' ? ' — ' + fmtBRL(sol.valorAprovado) : '') +
      (sol.observacao ? '<br>' + esc(sol.observacao) : '') +
      '<br><span class="mini">Ela vai para o histórico e o funcionário verá que a decisão foi revista.</span></div>' +
      '<label>Nova decisão' +
      '<select id="mdNovoStatus">' +
      '<option value="aprovada"' + (sol.status === 'aprovada' ? ' selected' : '') + '>Aprovar</option>' +
      '<option value="negada"' + (sol.status === 'negada' ? ' selected' : '') + '>Negar</option>' +
      '</select></label>' +
      '<label id="mdLinhaValor">Valor a reembolsar (R$)' +
      '<input type="text" id="mdValorRever" inputmode="decimal" value="' + fmtNum(vAtual) + '"></label>' +
      '<label>Motivo da revisão <b class="obrig">(obrigatório — o funcionário vai ler)</b>' +
      '<textarea id="mdObsRever" rows="3" placeholder="Ex.: comprovante reenviado legível — aprovação corrigida…"></textarea></label>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">Fechar</button>' +
      '<button class="btn sucesso" id="mdConfirmar">✓ Salvar revisão</button></div>');
    const selStatus = $('#mdNovoStatus');
    const sincronizar = () => { $('#mdLinhaValor').hidden = selStatus.value !== 'aprovada'; };
    selStatus.addEventListener('change', sincronizar);
    sincronizar();
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdConfirmar').addEventListener('click', async () => {
      const novo = selStatus.value;
      const obs = $('#mdObsRever').value.trim();
      // Motivo SEMPRE obrigatório: decisão já comunicada ao funcionário
      // só muda com explicação — inclusive quando o valor sobe.
      if (!obs) {
        toast('Escreva o motivo da revisão — é obrigatório.', 'erro');
        $('#mdObsRever').focus();
        return;
      }
      let v = 0;
      if (novo === 'aprovada') {
        v = parseValor($('#mdValorRever').value);
        if (!(v >= 0)) { toast('Valor inválido.', 'erro'); return; }
        if (v > sol.valor) {
          toast('O valor aprovado não pode ser maior que o solicitado (' + fmtBRL(sol.valor) + ').', 'erro');
          return;
        }
      }
      const btn = $('#mdConfirmar');
      btn.disabled = true;
      try {
        await remoderar(sol, { status: novo, valorAprovado: v, observacao: obs });
        toast(novo === 'aprovada' ? 'Revisada — aprovada: ' + fmtBRL(v) : 'Revisada — negada.', 'ok');
        fecharModal();
      } catch (e2) { btn.disabled = false; toast(msgErroFila(e2), 'erro'); }
    });
  }

  function abrirCancelar(sol) {
    const naFila = sol.status === 'aprovada' && !!sol.pagamentoId;
    abrirModal(
      '<h3>Cancelar despesa</h3>' +
      '<p><b>' + esc(nomeDe(sol)) + '</b> — ' + esc(sol.categoria) + ' — ' +
      fmtBRL(sol.valor) + ' — ' + fmtData(sol.dataDespesa) + '</p>' +
      (sol.descricao ? '<p class="mini">' + esc(sol.descricao) + '</p>' : '') +
      '<div class="aviso">A despesa sai do totalizador e da fila de pagamento, mas <b>continua guardada</b> ' +
      'com o comprovante para auditoria. Só esta despesa é afetada.' +
      (naFila ? '<br>O valor também é retirado do item de pagamento em aberto.' : '') +
      '<br><span class="mini">Cancelamento não tem volta — se for engano, o funcionário reenvia a despesa.</span></div>' +
      '<label>Motivo do cancelamento <b class="obrig">(obrigatório — o funcionário vai ler)</b>' +
      '<textarea id="mdObsCancelar" rows="3" placeholder="Ex.: lançamento duplicado — enviado duas vezes…"></textarea></label>' +
      '<div class="linha-botoes">' +
      '<button class="btn" id="mdCancelar">Fechar</button>' +
      '<button class="btn perigo" id="mdConfirmar">🚫 Confirmar cancelamento</button></div>');
    $('#mdCancelar').addEventListener('click', fecharModal);
    $('#mdConfirmar').addEventListener('click', async () => {
      const obs = $('#mdObsCancelar').value.trim();
      if (!obs) {
        toast('Escreva o motivo do cancelamento — é obrigatório.', 'erro');
        $('#mdObsCancelar').focus();
        return;
      }
      const btn = $('#mdConfirmar');
      btn.disabled = true;
      try {
        await remoderar(sol, { status: 'cancelada', valorAprovado: 0, observacao: obs });
        toast('Despesa cancelada.', 'ok');
        fecharModal();
      } catch (e2) { btn.disabled = false; toast(msgErroFila(e2), 'erro'); }
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
        nome: nomeDe(s), pix: pixDe(s.uid), pendQtd: 0, pendVal: 0, aprQtd: 0, aprVal: 0,
        negQtd: 0, cancQtd: 0
      });
      if (s.status === 'pendente') { g.pendQtd++; g.pendVal += s.valor || 0; }
      if (s.status === 'aprovada') {
        g.aprQtd++;
        g.aprVal += typeof s.valorAprovado === 'number' ? s.valorAprovado : (s.valor || 0);
      }
      if (s.status === 'negada') g.negQtd++;
      // [RM] cancelada não soma em lugar nenhum — só é contada, para
      // não sumir do painel sem deixar rastro
      if (s.status === 'cancelada') g.cancQtd++;
    });

    const grupos = Object.values(porFunc).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const el = $('#totalizador');
    if (!grupos.length) {
      el.innerHTML = '<div class="vazio">Sem dados no período selecionado.</div>';
      return;
    }
    const tot = grupos.reduce((t, g) => ({
      pendQtd: t.pendQtd + g.pendQtd, pendVal: t.pendVal + g.pendVal,
      aprQtd: t.aprQtd + g.aprQtd, aprVal: t.aprVal + g.aprVal, negQtd: t.negQtd + g.negQtd,
      cancQtd: t.cancQtd + g.cancQtd
    }), { pendQtd: 0, pendVal: 0, aprQtd: 0, aprVal: 0, negQtd: 0, cancQtd: 0 });

    el.innerHTML = '<table><thead><tr>' +
      '<th>Funcionário</th><th>PIX</th><th class="num">Pend.</th><th class="num">R$ pendente</th>' +
      '<th class="num">Aprov.</th><th class="num">R$ a pagar</th><th class="num">Neg.</th>' +
      '<th class="num">Canc.</th>' +
      '</tr></thead><tbody>' +
      grupos.map((g) =>
        '<tr><td>' + esc(g.nome) + '</td>' +
        '<td>' + (g.pix
          ? esc(g.pix) + ' <button class="btn btn-copiar" data-pix="' + esc(g.pix) + '">⧉</button>'
          : '<span class="mini">—</span>') + '</td>' +
        '<td class="num">' + g.pendQtd + '</td>' +
        '<td class="num">' + fmtBRL(g.pendVal) + '</td>' +
        '<td class="num">' + g.aprQtd + '</td>' +
        '<td class="num">' + fmtBRL(g.aprVal) + '</td>' +
        '<td class="num">' + g.negQtd + '</td>' +
        '<td class="num">' + g.cancQtd + '</td></tr>').join('') +
      '<tr class="total-geral"><td>Total</td><td></td>' +
      '<td class="num">' + tot.pendQtd + '</td>' +
      '<td class="num">' + fmtBRL(tot.pendVal) + '</td>' +
      '<td class="num">' + tot.aprQtd + '</td>' +
      '<td class="num">' + fmtBRL(tot.aprVal) + '</td>' +
      '<td class="num">' + tot.negQtd + '</td>' +
      '<td class="num">' + tot.cancQtd + '</td></tr>' +
      '</tbody></table>';
  }

  $('#totalizador').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pix]');
    if (btn) copiarTexto(btn.dataset.pix);
  });

  // ============================================================
  // EQUIPE (moderador)
  // ============================================================
  function renderEquipe() {
    if (!ehMod()) return;
    $('#listaUsuarios').innerHTML = !usuarios.length
      ? '<span class="mini">Nenhum usuário ainda.</span>'
      : usuarios.map((u) =>
        '<div class="usuario-linha">' +
        '<div class="usuario-info"><b>' + esc(u.nome) +
        (u.id === perfil.uid ? ' <span class="mini">(você)</span>' : '') +
        '</b><span>' + esc(u.email) +
        (u.pix ? ' · 💠 ' + esc(u.pix) : ' · 💠 sem PIX') + '</span></div>' +
        '<select data-uid="' + u.id + '"' + (u.id === perfil.uid ? ' disabled' : '') + '>' +
        '<option value="funcionario"' + (u.papel === 'funcionario' ? ' selected' : '') + '>Funcionário</option>' +
        '<option value="moderador"' + (u.papel === 'moderador' ? ' selected' : '') + '>Moderador</option>' +
        '</select></div>').join('');
  }

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
