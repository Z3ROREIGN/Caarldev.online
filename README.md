# Caarldev: loja + portfólio (Vercel)

Site estático (`index.html`, `app.js`) com API em funções do Vercel. Pagamento por **PIX automático via MisticPay** (https://docs.misticpay.com). Guia completo de instalação e uso em **LOJA.md**; relay Wine em **LEIA-ME.md**.

## Rotas
- `GET|POST /api/store?r=<rota>`: API da loja (contas, produtos, pedidos, painel admin).
- `POST /api/webhook`: a MisticPay avisa aqui (depósito, reembolso, MED). O corpo do aviso **não é confiado**: o site consulta a MisticPay com a sua chave e só libera se a cobrança estiver `COMPLETO` e o valor cobrir o pedido. Aviso de pedido desconhecido ou de saque é ignorado com 200; falha ao processar devolve 500 (a MisticPay tenta de novo).
- `/api/wine/*`: relay entre o bot e os PCs.

## Variáveis de ambiente (Vercel)
| Variável | Para quê |
|---|---|
| `MISTICPAY_CLIENT_ID`, `MISTICPAY_CLIENT_SECRET` | Chave de acesso da MisticPay (`pk_`/`sk_`) com escopos `TRANSACTION_CREATE` e `TRANSACTION_READ` |
| `ADMIN_EMAIL`, `SESSION_SECRET` | Admin e assinatura do login |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis (Upstash) |
| `SITE_URL` (opcional) | Endereço público, se o domínio do webhook sair errado |
| `WINE_BOT_TOKEN`, `WINE_NODE_TOKEN` | Relay Wine |

O endereço do webhook é enviado a cada cobrança (`projectWebhook`), então não precisa cadastrar nada no painel da MisticPay.

## Testes
`npm test` (Node 18+; não usa rede, a MisticPay é simulada em `teste/mp-mock.js`). `npm run dev` abre a loja local com banco falso e PIX simulado que “paga” sozinho depois de 20 s.
