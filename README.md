# VaultPay → Discord (site no Vercel)

Recebe os webhooks do PagVault/VaultPay, confere a assinatura (HMAC-SHA256) e guarda os eventos para o bot do Discord buscar.

## Rotas
- `POST /api/webhook` — o PagVault envia aqui. Assinatura inválida → 401 (nada é guardado, só o motivo fica no diagnóstico).
- `GET /api/events?after=N` — só o bot (`Authorization: Bearer INBOX_SECRET`).

## Instalar (GitHub + Vercel)
1. Crie um repositório no GitHub e envie **o conteúdo desta pasta** (`api/`, `lib/`, `package.json`...) na raiz do repositório.
2. No Vercel: *Add New → Project* e importe o repositório (sem framework, sem build).
3. No projeto do Vercel, conecte um banco **Redis (Upstash)** pela aba *Storage*/*Marketplace*. Ele cria as variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_*`); o código aceita as duas.
4. Em *Settings → Environment Variables*, crie `INBOX_SECRET` com uma senha longa e aleatória (40+ caracteres). A mesma senha vai no bot.
5. Faça *Redeploy*. Seu endereço será algo como `https://seu-projeto.vercel.app` (esse é o `INBOX_URL` do bot).
6. No Discord, como administrador: `/assinatura webhook` → copie o segredo mostrado → crie `WEBHOOK_SECRET` no Vercel → *Redeploy* → `/assinatura webhook_teste` → `/assinatura diagnostico`.

## Segurança
- A assinatura é conferida com os bytes originais do corpo e comparação em tempo constante; sem `WEBHOOK_SECRET`, timestamp ou assinatura válidos, o evento é rejeitado.
- Eventos repetidos (reenvio do PagVault) são ignorados.
- Os eventos têm dados de compradores: não compartilhe o `INBOX_SECRET`.

## Testes
`node --test` (Node 18+; não usa rede).
