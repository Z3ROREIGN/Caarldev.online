# Loja Caarldev: guia rápido

O site agora tem 3 partes (**Discord**, **Roblox** e **Portfólio**) mais uma parte **Outros**, com login, cadastro, painel admin, estoque, cupons e pedidos. Tudo roda no seu projeto atual do Vercel, no mesmo banco Redis (Upstash) do Wine. Não precisa de servidor novo.

## Como colocar no ar (5 minutos)

1. Suba esta pasta para o GitHub (substitui os arquivos do projeto) e deixe o Vercel publicar.
2. No Vercel: **Settings → Environment Variables**, crie:
   - `ADMIN_EMAIL`: o seu e-mail. Quem criar conta com ele já vira admin. Pode ter vários, separados por vírgula.
   - `SESSION_SECRET`: uma senha longa e aleatória. Gere com `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
   - `MISTICPAY_CLIENT_ID` e `MISTICPAY_CLIENT_SECRET`: a chave de acesso da MisticPay (`pk_...` e `sk_...`). Crie em **API → Chaves de Acesso** no painel da MisticPay, marcando os escopos `TRANSACTION_CREATE` e `TRANSACTION_READ` (só esses). O `sk_` aparece uma vez só: copie na hora.
   - O banco Redis (`KV_REST_API_URL` e `KV_REST_API_TOKEN`) conectado pela aba Storage do Vercel.
   - Opcional: `SITE_URL` (ex.: `https://seusite.com`). Só precisa se você usa domínio próprio e o endereço do webhook sair errado; por padrão o site usa o domínio do projeto no Vercel.
3. Se na MisticPay você usa **IPs autorizados**, deixe a lista vazia (o Vercel não tem IP fixo). Faça **Redeploy**.
4. Abra o site → **Criar conta** com o e-mail do `ADMIN_EMAIL`. O botão **Painel** aparece no menu.
5. No painel → **Configurações**: preencha os contatos (e, se quiser, o texto mostrado ao cliente no PIX). Depois cadastre os produtos. A chave que recebe o dinheiro fica na sua conta da MisticPay.

> Crie a sua conta admin logo depois do primeiro deploy. O e-mail não é verificado, então enquanto ninguém criar a conta com ele, qualquer pessoa poderia tentar se cadastrar com o seu e-mail.

## O que tem em cada parte

| Parte | O que é |
|---|---|
| **Discord** | Contas, impulsos (boosts), farm de orbs e o que você criar |
| **Roblox** | Arquivos Rbxl e modelos para Studio lite |
| **Outros** | Qualquer produto diferente |
| **Portfólio** | Seus trabalhos 3D, serviços e formulário de contato (as mensagens caem no painel) |

As categorias já vêm criadas, mas você cria, renomeia, esconde, reordena e apaga em **Painel → Categorias**. Os nomes das 3 partes e as frases de apoio também mudam em **Configurações**.

## Painel admin

- **Visão geral**: receita total, hoje, 7 e 30 dias, ticket médio, gráfico de 30 dias, mais vendidos, receita por parte, status dos pedidos, estoque baixo e pedidos que precisam de atenção.
- **Pedidos**: filtro por status e busca, confirmar pagamento, registrar entrega manual, cancelar, reembolsar (com opção de devolver ao estoque), nota interna, histórico e exportação em CSV.
- **Produtos**: criar, editar, apagar, esconder, destacar, preço antigo riscado, imagem, etiquetas e limite por pedido.
- **Estoque**: adicionar itens (uma linha por unidade), remover, limpar ou controlar por quantidade.
- **Categorias**, **Cupons** (% ou valor fixo, limite de usos, pedido mínimo, validade, só para uma parte), **Portfólio** (trabalhos com imagem ou vídeo), **Mensagens**, **Configurações** (texto do PIX, aviso no topo do site, manutenção, fechar cadastros, tempo de reserva) e **Registros** (tudo que os admins fizeram).
- **Usuários**: buscar, **banir** (com motivo; derruba a sessão na hora), desbanir, tornar ou remover admin, gerar nova senha e apagar conta.

## Como cada produto é entregue

Ao criar o produto você escolhe:

- **Itens em estoque**: cada linha é uma unidade (por exemplo `usuario:senha`). A compra reserva as linhas e o cliente só vê depois que o pagamento é confirmado.
- **Link de download**: para Rbxl e modelos. O link fica escondido até o pagamento.
- **Entrega manual**: impulsos, farm de orbs e serviços. Depois de confirmar o pagamento você escreve a entrega no pedido ou combina pelo Discord do cliente.

## Fluxo de compra (PIX automático, MisticPay)

1. O cliente escolhe o produto, informa o **CPF de quem vai pagar** (o PIX exige) e clica em **Comprar agora**.
2. O estoque fica reservado (60 min por padrão) e o site gera o PIX na MisticPay: QR Code e Copia e Cola aparecem na página do pedido.
3. O cliente paga. A MisticPay avisa o site em `/api/webhook`, o site **confere o pagamento direto na MisticPay** (não confia no aviso) e libera a entrega sozinho. A página do pedido atualiza em segundos, sem ninguém clicar em nada.
4. Se o aviso atrasar ou falhar, a própria página do pedido confirma sozinha (consulta a MisticPay a cada poucos segundos). Pedido sem pagamento expira e o estoque volta; se o PIX for pago no último minuto, o pedido é liberado em vez de expirar.

O CPF só vai para a MisticPay para gerar a cobrança; o site não guarda.

**Quando você precisa agir** (aparece em *Precisa de atenção* e no pedido, em vermelho): PIX pago com valor menor que o pedido, pago depois de o cliente cancelar, pago depois de expirar sem estoque, reembolso ou MED (infração) avisado pela MisticPay. Nesses casos nada é entregue sozinho. O botão **Confirmar pagamento** do painel continua existindo para casos manuais. Reembolso do dinheiro é feito no painel da MisticPay; no site, use **Reembolsar** para marcar o pedido.

**Não existe ambiente de testes na MisticPay.** Depois de publicar, faça uma compra real de um produto barato (R$ 1 a R$ 2) e confira que o pedido libera sozinho.

## Segurança já incluída

O webhook nunca libera nada pelo que recebe: sempre pergunta à MisticPay se a cobrança está paga e se o valor cobre o pedido. Senhas com scrypt, sessão em cookie assinado (HttpOnly, Secure), limite de tentativas de login/cadastro/pedidos, bloqueio de requisições de outros sites, ban com efeito imediato, links de imagem restritos a http(s), exportação CSV protegida contra fórmulas e cabeçalhos de segurança (CSP) no `vercel.json`.

## Testar no seu computador

```
npm run dev      # http://localhost:3000 com banco falso em memória (admin: dono@teste.com)
npm test         # testes automáticos da loja e do pagamento (MisticPay simulada)
```

## Arquivos novos

`index.html` e `app.js` (site), `store.css` (visual da loja), `api/store.js` (API única, mantém você abaixo do limite de funções do plano gratuito), `api/webhook.js` (aviso da MisticPay), `lib/shop.js`, `lib/auth.js`, `lib/util.js` (regras de negócio), `lib/misticpay.js` (API da MisticPay) e `teste/loja.test.js` + `teste/misticpay.test.js`.

## Novidades da versão 2

**Compra e entrega**
- **Carrinho** com até 10 produtos diferentes e um único PIX. Cada item é entregue do seu jeito (itens, download ou manual); o pedido vira "Entregue" quando todos foram entregues.
- **Termos obrigatórios** no checkout (a data do aceite fica no pedido).
- **Downloads protegidos**: o link do arquivo não aparece no pedido. O botão passa por `/api/store?r=download`, que confere o dono, o prazo e o limite de downloads (Configurações > Downloads). No painel, "Renovar prazo e downloads" libera de novo. Quem baixa ainda consegue ver o destino final; para proteção total, hospede o arquivo em armazenamento privado.
- **Garantia e reposição**: no produto, "Garantia (dias)". O cliente pede reposição no pedido (marcando os itens com defeito); o pedido cai em Tickets e você aprova (itens novos saem do estoque e aparecem no pedido) ou nega.
- **Suporte por tickets** (cliente e painel), com ou sem pedido ligado.

**Vitrine**
- **Avaliações** só de quem comprou, com nota média nos cartões, resposta da loja e moderação (Painel > Avaliações). Melhores avaliações na página inicial.
- **Favoritos**; se estava esgotado e voltou, aparece "Voltou ao estoque!" em Minha conta (sem e-mail).
- **Galeria, vídeo (YouTube ou .mp4) e "O que vem incluso"** em cada produto.
- **Termos de uso, Reembolso e garantia, Privacidade e FAQ**: textos-modelo editáveis em Painel > Páginas. **Revise antes de divulgar.**
- **Orçamento de serviços 3D** no portfólio (tipo, prazo, faixa de orçamento, referência), com status no painel.

**Painel**
- **Relatórios** (7/30/90 dias ou mês, comparação com o período anterior, conversão, receita por produto/categoria).
- **Produtos**: seleção em massa (mostrar/ocultar, destaque, categoria, reajuste de preço, apagar), duplicar, importar estoque de .txt/.csv.
- **Equipe com permissões**: Usuários > Cargo > Equipe. Só pedidos, tickets, estoque etc. conforme você marcar; pagamento, reembolso, usuários e configurações continuam só do admin.
- **Cupons**: limite por cliente, só primeira compra, e **afiliados** (comissão sobre vendas pagas e registro de pagamentos).
- **Filtro por data** nos pedidos; exportar pedidos, usuários e registros em CSV.
- **Backup e restauração** (Painel > Backup).
- **Avisos no Discord** (webhook): pedido pago, entrega manual pendente, pedido que precisa de atenção, estoque baixo, tickets, orçamentos.

**Segurança**
- **Verificação em duas etapas (2FA)** com app autenticador e 8 códigos de recuperação (Minha conta). Ative na conta de admin.
- **Bloqueio por conta**: 10 erros de senha/código em 15 minutos travam o login daquela conta por 15 minutos, mesmo com ataques de IPs diferentes.
- **ADMIN_SETUP_KEY** (opcional, recomendado): sem verificação de e-mail, esta chave impede que outra pessoa crie a conta do administrador antes de você. Defina no Vercel e informe ao criar a conta do `ADMIN_EMAIL`.

**Busca e compartilhamento**
- Páginas `/p/<produto>` e `/s/<parte>` com prévia bonita (Discord, WhatsApp) e dados estruturados; `/sitemap.xml` e `/robots.txt` automáticos. Use o botão "Copiar link do produto" para divulgar.
- Fundo em vídeo leve (`assets/fundo.webm` e `.mp4`, ~300 KB) no lugar do GIF de 20 MB.

**Não incluído de propósito**: recuperar senha por e-mail, verificação de e-mail e e-mails de compra (precisam de um serviço de e-mail). Enquanto isso, quem esquece a senha fala com o suporte e você gera uma senha temporária em Usuários.

## Dica de desempenho

O fundo agora é um vídeo de ~300 KB (`assets/fundo.webm`/`.mp4`). O arquivo `fundo.gif` original foi removido do projeto: se quiser trocar o fundo, converta o novo GIF com `ffmpeg -i fundo.gif -c:v libvpx-vp9 -crf 38 -an assets/fundo.webm`.

## Carteira e API (Minha conta)

**Minha conta** agora é uma área com seções: Visão geral, **Carteira**, Pedidos, Favoritos, Segurança, **Chaves de API** e Perfil. O saldo aparece no menu do topo.

### O que o cliente faz na carteira

| Ação | Como funciona | Tarifa (padrão) |
|---|---|---|
| **Recarregar** | Gera um PIX pela MisticPay (pede o CPF, que não é guardado). Quando o PIX é pago, o saldo entra sozinho (webhook ou a própria página confere). | sem taxa |
| **Pagar compras** | No carrinho e na página do produto, escolha "Saldo da carteira". A entrega sai na hora, sem CPF. | sem taxa |
| **Transferir** | Pelo e-mail da outra conta. Pede a senha (e o código do 2FA, se ativo). Quem envia paga **valor + R$ 0,50**; quem recebe leva **valor - R$ 0,50**. | R$ 0,50 + R$ 0,50 |
| **Sacar** | PIX para uma chave do cliente (CPF, CNPJ, e-mail, telefone ou aleatória). Sai do saldo o valor pedido; no PIX chega o valor menos **5% + R$ 0,50**. | 5% + R$ 0,50 |

Exemplos: transferir R$ 10,00 → o remetente perde R$ 10,50 e o destinatário recebe R$ 9,50 (a loja fica com R$ 1,00). Sacar R$ 20,00 → taxa R$ 1,50 → chegam R$ 18,50 no PIX.

Todas as tarifas, mínimos, limite de saque por dia e o modo de saque mudam em **Painel → Configurações → Carteira**.

### Saques: você aprova (padrão) ou automático

O saque usa `POST /api/transactions/withdraw` da MisticPay, o mesmo cliente (`lib/misticpay.js`) e a mesma chave das cobranças.

- **Manual (padrão):** o saque cai em **Painel → Carteiras**; você confere e clica **Aprovar e enviar PIX** (pede a sua senha). **Recusar** devolve o valor ao cliente.
- **Automático:** o PIX é pedido à MisticPay na hora. Se a conta MisticPay da loja estiver sem saldo, o pedido não se perde: fica pendente e você recebe um aviso.
- **O saque entra numa fila.** A MisticPay responde `QUEUED`: o pedido vira **Na fila da MisticPay** e só passa a **Enviado** quando ela conclui (webhook `RETIRADA` ou o botão "Conferir agora"; o site sempre confirma com `/transactions/check`, nunca confia no corpo do webhook). Se a MisticPay marcar `FALHA`, ou o banco de destino **devolver** o PIX, o valor volta sozinho para a carteira do cliente e a taxa é desfeita.
- **Nunca duplica PIX:** cada saque vai com um `X-Idempotency-Key` próprio. Se a resposta ficar incerta (queda de rede, erro 500) o saque vai para **Conferir na MisticPay** e **Tentar de novo** é seguro. Também dá para marcar como enviado ou estornar.
- Recusa de dados pela MisticPay (chave PIX inválida, valor...) devolve o saldo na hora.
- **Chave de acesso:** além de `TRANSACTION_CREATE` e `TRANSACTION_READ`, crie a chave com o escopo **`WITHDRAW_CREATE`**. Marque também **`BALANCE_READ`** (opcional) para ver o saldo da MisticPay no painel Carteiras. O escopo não pode ser editado depois: é preciso criar outra chave e trocar as variáveis na Vercel.
- **IPs autorizados:** se você restringiu a conta por IP na MisticPay (API → IPs autorizados), os saques e consultas vindos da Vercel recebem `401`, porque os IPs da Vercel mudam. Deixe a lista vazia.
- A MisticPay cobra a taxa dela em cada saque. Confira que os 5% + R$ 0,50 do cliente cobrem essa taxa. Não há ambiente de teste: faça os primeiros saques com valor baixo.
- O saldo das carteiras é dinheiro de clientes que está na sua conta MisticPay: mantenha lá pelo menos esse valor para conseguir pagar os saques.

### Painel → Carteiras

Saldo total nas carteiras, taxas arrecadadas, saques para analisar e já tratados, busca por cliente e **ajuste manual de saldo** (crédito ou débito, com motivo que aparece no extrato do cliente; pede a sua senha). Não dá para apagar uma conta que ainda tem saldo. Reembolsar um pedido pago com saldo devolve o valor à carteira do cliente sozinho.

### API pública

Em **Minha conta → Chaves de API** o cliente cria chaves (até 5) com permissões separadas: `leitura`, `recarga`, `transferencia`. A chave aparece uma vez, só o hash fica guardado, e pode ser revogada a qualquer momento. Envie `Authorization: Bearer cdk_...`. Valores em **reais**. Limite de 60 chamadas por minuto por chave. Dá para desligar tudo em Configurações → Carteira.

| Método e rota | Permissão | O que faz |
|---|---|---|
| `GET /api/v1/saldo` | leitura | saldo atual |
| `GET /api/v1/extrato?pagina=0` | leitura | movimentações (30 por página) |
| `POST /api/v1/recarga` `{"valor": 25.5, "cpf": "..."}` | recarga | gera PIX de recarga |
| `GET /api/v1/recarga?id=...` | recarga | estado da recarga |
| `POST /api/v1/transferir` `{"para": "email", "valor": 10, "nota": "..."}` | transferencia | transfere (com as mesmas taxas) |

```
curl "https://seusite.com/api/v1/saldo" -H "Authorization: Bearer cdk_SUA_CHAVE"
```

A API roda dentro de `api/store.js` (rewrite `/api/v1/*` no `vercel.json`), então o número de funções do Vercel não muda.

### Segurança da carteira

O saldo é um número inteiro no Redis alterado só com operações atômicas (`INCRBY`/`DECRBY`): pedidos simultâneos nunca gastam mais que o saldo. Recarga só credita depois de a MisticPay confirmar o PIX (o corpo do webhook nunca é confiado) e só uma vez. Transferência, saque e criação de chave pedem a senha e, com 2FA ativo, o código. Há limite de tentativas em tudo, e o backup do painel inclui os saldos.
