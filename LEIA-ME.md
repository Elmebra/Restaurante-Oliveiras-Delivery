# Oliveira's Delivery — v2.0

Pedidos online de marmita e feijoada: o cliente abre um **link**, monta o pedido, paga por **Pix** (ou na entrega) e o pedido **sai impresso** na cozinha.
O restaurante não muda a rotina interna: balança, comandas e caixa **não existem** nesta versão (estão na v1.0 "Salão Completo").

```
Cliente (link /c/) ──► Planilha Google (Apps Script) ──► aparelho da cozinha ──► impressora
        ▲                                                        │
        └── cardápio e preços ◄── Painel do dono ◄───────────────┘
```

## O que o cliente vê (página `/c/`)
1. Cardápio de hoje, tamanhos, acompanhamentos, bebidas.
2. Dados de entrega (nome, telefone, rua, número, bairro…) — **ficam salvos no celular dele**, sem criar conta; no próximo pedido já vêm preenchidos e há o botão "Pedir o mesmo de novo".
3. Forma de pagamento: **Pix** (mostra o *Pix copia e cola* com o valor exato), **dinheiro** (com troco) ou **cartão na entrega**.
4. Depois de enviar: código do pedido (ex.: `WK7Q`) e botão para mandar o **comprovante do Pix pelo WhatsApp** do restaurante.
5. A mensagem automática do WhatsApp com o link é configurada no próprio WhatsApp Business (passo 7).

## Instalação (uma vez)
### 1) Hospedar (GitHub Pages)
Crie/atualize o repositório e envie **TODO** o conteúdo desta pasta (`index.html` na raiz e a pasta `c/`). Settings > Pages > Deploy from a branch > main / (root).
Endereços: app do restaurante `https://SEU-USUARIO.github.io/REPO/` · página do cliente `https://SEU-USUARIO.github.io/REPO/c/`.
Ao enviar versão nova, aumente o número em `VERSION` no `sw.js` e em `c/sw.js`.

### 2) Planilha + servidor (Google Apps Script)
1. Crie uma planilha **nova** (não reuse a da v1.0) em sheets.google.com. Arquivo > Configurações > **Fuso horário: Brasília**.
2. Extensões > Apps Script. Apague o código e cole `apps-script/Code.gs`.
3. Troque `var TOKEN = 'TROQUE-ESTA-SENHA';` por uma senha sua. Salve.
4. Implantar > Nova implantação > **App da Web** > Executar como: **Eu** · Quem pode acessar: **Qualquer pessoa** > Implantar. Autorize e **copie o URL** (termina em `/exec`).
   - "Qualquer pessoa" é necessário para o cliente conseguir pedir. O servidor só entrega o cardápio e valida cada pedido (preços recalculados no servidor, limite de pedidos por telefone, só pratos do dia). A senha protege tudo que é do restaurante.
5. Se mudar o `Code.gs`: Implantar > Gerenciar implantações > lápis > Nova versão.

### 3) Ligar o app do restaurante
No aparelho da cozinha: Painel > **Dados** > Sincronização: cole o URL e a senha > Conectar. Repita nos outros aparelhos (expedição, dono).

### 4) Ligar a página do cliente
Painel > **Loja online** mostra uma linha pronta. No arquivo `c/config.js` deixe exatamente essa linha (`export default { scriptUrl: '...' };`) e envie de novo ao GitHub.

### 5) Dados da loja (Painel > Loja online)
Nome, **WhatsApp** que recebe os comprovantes, **chave Pix**, nome e cidade do recebedor. Preços, cardápio por dia da semana e bebidas ficam nas outras abas — o cliente sempre vê o que está lá.
O botão **Aberta/Fechada** abre e fecha a página na hora.

### 6) Impressão automática (Bematech MP-4200 TH, USB)
1. Instale o driver, deixe a impressora como **padrão** do Windows (papel 80 mm).
2. Atalho do Chrome: `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --app=https://SEU-USUARIO.github.io/REPO/#/cozinha`
3. Painel > Dados > Impressão: ligue "Imprimir sozinho pedidos novos". Painel > **Loja online**: ligue **"Receber pedidos online neste aparelho"**. Só **um** aparelho (o da impressora) deve ficar com isto ligado, e a janela precisa ficar aberta.
4. Chegou pedido: toca um bipe, aparece na fila e o cupom sai. O cupom traz o **código**, os M-001…, endereço, forma de pagamento e "AGUARDANDO COMPROVANTE" quando é Pix.

### 7) WhatsApp: mensagem automática com o link
No celular do restaurante use o **WhatsApp Business** (gratuito): Ferramentas > **Mensagem de saudação**, e cole o texto pronto de Painel > Loja online > "Mensagem automática". Assim, quando o cliente chama, recebe o link sozinho. (Sem API paga; o atendimento conversado automático fica para uma versão futura.)

## Rotina do dia
1. Cliente pede → cupom sai → cozinha monta e marca "Pronto" (cada marmita tem M-xxx para escrever na tampa).
2. **Pix:** o cliente manda o comprovante no WhatsApp com o código. Na Expedição, marque "Comprovante do PIX recebido" — só então libera o despacho.
3. Expedição escolhe o motoboy; depois "Entregue". O Painel mostra faturamento, pedidos online x balcão, formas de pagamento e custo dos motoboys.
4. Pedido por telefone/WhatsApp: botão **+** na Cozinha lança manualmente.

## Licença / período de teste
- Primeiro uso = início de **14 dias de teste** (aviso no topo). Depois, o app mostra a tela "Licença vencida" (os dados ficam salvos; há botão de backup).
- Ativar: Painel > Dados > Licença, ou na própria tela de bloqueio.
- Gerar chave (no seu computador): `node tools/gerar-chave.mjs +30` (30 dias) ou `node tools/gerar-chave.mjs 20261231`.
- **Antes de entregar a um cliente, troque `SECRET` em `js/license.js`** por uma frase só sua.
- A validade também é publicada na planilha: **a página do cliente fecha sozinha no servidor** quando vence, e limpar o aparelho não zera o teste (a planilha lembra o 1º uso).
- Limite honesto: a trava no app roda no aparelho e não é à prova de quem entende de programação. O que garante de verdade é a planilha/Apps Script estar na **sua** conta enquanto o cliente não pagou. Ao fechar negócio, mova para a conta do dono (LGPD: o restaurante é o controlador dos dados dos clientes).

## Privacidade (LGPD)
A página do cliente informa que os dados servem só para a entrega e ficam no restaurante e, se o cliente marcar, no celular dele; há botão **Apagar meus dados deste celular**. Os pedidos ficam na planilha: defina por quanto tempo guardar e apague os antigos. Não é aconselhamento jurídico.

## Documento fiscal
O cupom é **comanda**, com a frase "NÃO É DOCUMENTO FISCAL". NFC-e/cupom fiscal é responsabilidade do restaurante e **não** é emitido por este sistema.

## Testes
`node --test tests/*.test.js` — regras, sincronização com vários aparelhos, servidor (Code.gs rodando de verdade), Pix (CRC), licença e o fluxo cliente → cozinha → cupom.
Local: `python3 -m http.server 8080` → http://localhost:8080 (app) e http://localhost:8080/c/ (cliente; precisa do `scriptUrl` em `c/config.js`).

## Versões
- **v1.0 "Salão Completo"**: balança, comandas, caixa, cozinha, expedição, painel (pasta `oliveiras-v1.0-salao-completo`).
- **v2.0 "Delivery"** (esta): só delivery/retirada com página de pedido, Pix, impressão automática, licença.
- **v3.0 (ideia)**: pagamento online (Pix/cartão por gateway com confirmação automática) e robô de conversa no WhatsApp pela API oficial.
