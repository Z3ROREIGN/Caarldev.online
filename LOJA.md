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
