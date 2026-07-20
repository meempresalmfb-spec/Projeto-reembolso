# 🧾 Reembolso de Viagem

Sistema web de prestação de contas de despesas de viagem para equipes de até ~20 funcionários + 2-3 moderadores.

- **Front-end:** HTML/CSS/JS puro, hospedado no **GitHub Pages** (grátis)
- **Dados e login:** **Firebase** (Firestore + Authentication) no plano gratuito (Spark)
- **Comprovantes:** a foto do cupom é comprimida no navegador e salva direto no Firestore (o plano gratuito do Firebase não inclui mais o Storage para projetos novos — por isso essa arquitetura)

## O que o sistema faz

| Perfil | Pode |
|---|---|
| **Funcionário** | Criar solicitações com comprovante, acompanhar status, ver o motivo quando negada. Vê **só as próprias** solicitações (garantido pelas regras do Firestore no servidor, não só pela interface). |
| **Moderador** | Ver tudo, aprovar/negar (negar **exige** observação), editar a aba Regras, filtrar por funcionário/status/período, ver o totalizador por funcionário e gerenciar quem pode criar conta (aba Equipe). |

Validações automáticas:
- Alimentação: alerta quando a soma do dia passa de R$ 120,00 e mostra o desconto que será aplicado (ex.: gastou R$ 126 → recebe R$ 120). O valor com desconto já vem sugerido para o moderador na aprovação.
- Combustível: valor calculado automaticamente (km × R$ 0,93).
- Uber Comfort: justificativa obrigatória (bloqueado no servidor também).
- Comprovante obrigatório: sem anexo a solicitação não envia (e as regras do servidor recusam solicitação sem comprovante).
- Limite diário de alimentação e valor do km são **parâmetros editáveis** pelo moderador na aba Regras (botão Editar), sem mexer em código.

---

## 1. Arquivos do projeto

```
index.html         ← a página do sistema
style.css          ← visual
app.js             ← lógica
firebase-config.js ← VOCÊ EDITA: credenciais do seu Firebase
firestore.rules    ← VOCÊ COLA no console do Firebase (segurança)
README.md          ← este guia
```

---

## 2. Configurar o Firebase (uma vez, ~10 minutos)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) com uma conta Google e clique em **Adicionar projeto**. Dê um nome (ex.: `reembolso-viagem`). Pode **desativar** o Google Analytics.

2. **Ativar o login por e-mail/senha:**
   No menu lateral, **Criação (Build) → Authentication → Vem começar (Get started) → E-mail/senha → Ativar → Salvar**.

3. **Criar o banco de dados:**
   **Criação (Build) → Firestore Database → Criar banco de dados**.
   - Local: `southamerica-east1 (São Paulo)`
   - Modo: **produção** (as regras do passo 4 cuidam da segurança)

4. **Colar as regras de segurança:**
   Ainda no Firestore, aba **Regras**: apague o que estiver lá, cole **todo o conteúdo do arquivo `firestore.rules`** e clique em **Publicar**.
   > São essas regras que garantem no servidor que funcionário só vê o que é dele, que só moderador aprova/nega e que negar exige observação.

5. **Liberar o primeiro e-mail (o seu, de moderador):**
   Na aba **Dados** do Firestore → **Iniciar coleção**:
   - ID da coleção: `config`
   - ID do documento: `acesso`
   - Campo: `emails` · tipo **array** · adicione uma string com **seu e-mail** (minúsculas)
   - Salvar.
   > Só e-mails dessa lista conseguem criar conta. Depois desse bootstrap, você adiciona os demais pela aba **Equipe** do próprio sistema.

6. **Pegar as credenciais do app web:**
   Engrenagem ⚙️ → **Configurações do projeto → Geral → Seus apps →** ícone **`</>`** (Web). Dê um apelido (ex.: `site`), **não** precisa marcar Hosting, clique em **Registrar app**.
   Vai aparecer um bloco `const firebaseConfig = { ... }`. Copie **só o objeto** (de `{` a `}`) e cole no arquivo **`firebase-config.js`**, substituindo o objeto de exemplo. Fica assim:

   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "AIzaSy...",
     authDomain: "reembolso-viagem.firebaseapp.com",
     projectId: "reembolso-viagem",
     storageBucket: "reembolso-viagem.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abc123"
   };
   ```

---

## 3. Publicar no GitHub Pages (uma vez, ~5 minutos)

1. Crie uma conta em [github.com](https://github.com) (se não tiver).
2. **Novo repositório**: nome ex.: `reembolso`, visibilidade **Public** (necessário para o Pages gratuito), sem README.
3. Envie os arquivos do projeto. O jeito mais simples sem linha de comando: dentro do repositório, **Add file → Upload files**, arraste `index.html`, `style.css`, `app.js` e `firebase-config.js` (já editado) e clique em **Commit changes**.
   > A `apiKey` do Firebase **pode** ficar pública — ela só identifica o projeto; a segurança vem das regras do Firestore e da lista de e-mails liberados.
4. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
5. Em 1-2 minutos o site fica no ar em:
   `https://SEU-USUARIO.github.io/reembolso/`

6. **Autorizar esse endereço no Firebase (importante!):**
   Firebase Console → **Authentication → Settings → Domínios autorizados → Adicionar domínio** → `SEU-USUARIO.github.io`.
   Sem isso, o login não funciona no site publicado.

---

## 4. Primeiro acesso (bootstrap do moderador)

1. Abra o site publicado → **Criar conta** → use o e-mail que você liberou no passo 2.5.
2. Sua conta nasce como *funcionário*. Para virar moderador:
   Firebase Console → **Firestore → Dados → coleção `usuarios`** → abra o seu documento → edite o campo `papel` de `funcionario` para **`moderador`** → salvar.
3. Recarregue o site. Agora você tem as abas **Painel** e **Equipe**.
4. Na aba **Equipe**, libere os e-mails do resto do time (e promova os outros 1-2 moderadores direto ali, sem console).
5. Cada funcionário acessa o link, cria a própria conta e já pode enviar solicitações.

> Passos 2 e 3 do console só acontecem **uma vez**, para o primeiro moderador. Todo o resto da gestão é pelo próprio sistema.

## 5. Rotina de uso

- **Funcionário:** aba **➕ Nova** → data, categoria, valor, foto do cupom → enviar. Acompanha em **🧾 Minhas** (se negada, o motivo aparece no card).
- **Moderador:** aba **✅ Painel** (o número no badge é a fila de pendentes) → abre o comprovante → **Aprovar** (pode ajustar o valor; o desconto de alimentação já vem sugerido) ou **Negar** (motivo obrigatório).
- **Fechamento nos dias 15/20/25/30:** no Painel, filtre o período e veja o **totalizador por funcionário** — a coluna "R$ a pagar" soma os valores aprovados.

## 6. Limites do plano gratuito (referência)

| Recurso | Limite/dia | Na prática (equipe de 20) |
|---|---|---|
| Leituras Firestore | 50.000 | Tranquilo |
| Escritas Firestore | 20.000 | Tranquilo |
| Armazenamento | 1 GB total | ~2.000 comprovantes (fotos comprimidas ficam com 200-600 KB) |

Dica de manutenção: uma vez por ano, exporte/anote o histórico antigo e exclua solicitações de anos fechados para liberar espaço.

## 7. Solução de problemas

| Sintoma | Causa provável |
|---|---|
| Tela "Firebase ainda não configurado" | `firebase-config.js` ainda com os valores `COLE_AQUI...` |
| "Seu e-mail ainda não foi liberado" | E-mail fora da lista `config/acesso` (aba Equipe, ou passo 2.5 no primeiro acesso) |
| Login não funciona no site publicado, mas o site abre | Faltou adicionar `SEU-USUARIO.github.io` nos Domínios autorizados (passo 3.6) |
| "Sem permissão para essa ação" | Regras do Firestore não publicadas (passo 2.4) ou usuário sem papel de moderador tentando moderar |
| Site não abre após publicar | Aguarde 1-2 min; confira se o arquivo se chama exatamente `index.html` e está na raiz do repositório |
