# Wine Relay

Relay HTTP para comunicação entre o bot e os PCs, usando Redis REST (Upstash/Vercel KV).

## Instalação

1. Publique estes arquivos no projeto Vercel.
2. Conecte um Redis compatível com Upstash e configure as variáveis de ambiente:
   - `WINE_BOT_TOKEN`: token longo e aleatório do bot.
   - `WINE_NODE_TOKEN`: outro token longo e aleatório para os PCs.
   - Redis: `KV_REST_API_URL` + `KV_REST_API_TOKEN` ou `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
3. Os dois tokens devem ser diferentes e não devem reutilizar segredos de outros serviços.
4. Faça redeploy após configurar as variáveis.

## Rotas

- `GET /api/wine/health`: verifica Redis e configuração dos tokens.
- `POST /api/wine/connect`: PC inicia uma sessão.
- `POST /api/wine/up`: PC envia mensagens ao bot.
- `GET /api/wine/down?wait=N`: PC busca comandos do bot.
- `POST /api/wine/leave`: PC encerra a sessão.
- `GET /api/wine/pull?wait=N&max=N`: bot busca mensagens dos PCs.
- `POST /api/wine/push`: bot envia comandos a um PC.
- `GET /api/wine/state`: bot consulta os PCs online.

## Teste local

Requer Node.js 18 ou superior:

```sh
node teste/local.js
node teste/smoke.js
```

Para testar contra o deploy:

```sh
node teste/smoke.js https://SEU-SITE.com BOT_TOKEN NODE_TOKEN
```

Consulte os comentários dos arquivos e os exemplos de ambiente para detalhes do protocolo.
