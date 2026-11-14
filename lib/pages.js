'use strict';
// Textos padrão das páginas Termos, Reembolso e garantia, Privacidade e Perguntas frequentes.
// São modelos: REVISE antes de divulgar (idealmente com um advogado). O dono pode reescrever tudo em Painel > Páginas.
// Formato: "## Título" vira subtítulo, "- item" vira lista e linha em branco separa parágrafos.
const TERMS = `## 1. Sobre a loja
A {{loja}} vende produtos digitais (contas e serviços para Discord, arquivos e modelos para Roblox Studio) e serviços de animação e modelagem 3D. Ao criar uma conta ou fazer um pedido, você concorda com estes termos.

## 2. Sua conta
- Informe dados verdadeiros e mantenha sua senha em segredo. Tudo o que for feito na conta é de responsabilidade de quem a criou.
- Podemos suspender ou banir contas em caso de fraude, chargeback indevido, abuso do suporte ou tentativa de burlar a loja.

## 3. Compra e pagamento
- O pagamento é feito por PIX. A confirmação é automática assim que o banco avisa que o PIX caiu.
- Ao criar o pedido, o estoque fica reservado por um tempo limitado. Se o PIX não for pago nesse prazo, o pedido expira e o estoque volta para a loja.
- Pague sempre o valor exato do pedido. Valores diferentes podem exigir análise manual.

## 4. Entrega
- Itens em estoque e links de download ficam disponíveis no seu pedido logo após a confirmação do pagamento.
- Impulsos, farm de orbs e serviços são entregues manualmente. O prazo e o contato (Discord ou WhatsApp) são combinados com você depois do pagamento.
- Links de download podem ter prazo e limite de downloads, informados no pedido.

## 5. Uso dos produtos
- Contas, impulsos e serviços ligados a plataformas de terceiros (Discord, Roblox) seguem também as regras dessas plataformas. Você é responsável pelo uso que fizer deles.
- Arquivos e modelos são licenciados para o seu uso. Não é permitido revender, redistribuir ou publicar o material sem autorização.

## 6. Garantia e reembolso
Veja a página Reembolso e garantia.

## 7. Limitação de responsabilidade
Fazemos o possível para manter a loja no ar e as entregas corretas, mas não garantimos funcionamento ininterrupto nem nos responsabilizamos por mudanças feitas pelas plataformas de terceiros depois da entrega.

## 8. Alterações e contato
Podemos atualizar estes termos. A versão válida é a publicada nesta página. Dúvidas: {{contato}}.`;

const REFUND = `## Garantia
Cada produto informa na página dele se tem garantia e por quantos dias. A contagem começa quando a entrega é liberada (para entregas manuais, quando registramos a entrega no seu pedido).

Dentro do prazo, se o item chegar com defeito ou não funcionar como descrito, abra o pedido em Minha conta e use o botão Pedir reposição. Explique o problema e, se for o caso, marque quais itens falharam. Analisamos o pedido e, se aprovado, repomos o item ou combinamos a solução com você.

## O que a garantia cobre
- Item entregue que não funciona ou com dados incorretos no momento da entrega.
- Link de download quebrado ou arquivo corrompido.
- Serviço não entregue conforme combinado.

## O que a garantia não cobre
- Problemas causados depois da entrega por mudança de senha, alteração de dados, uso indevido ou ações da própria plataforma (Discord, Roblox) por motivos alheios ao produto.
- Pedidos fora do prazo de garantia informado no produto.

## Reembolso
Se não for possível repor ou resolver, devolvemos o valor pelo mesmo meio de pagamento (PIX). O prazo para o dinheiro voltar depende do banco.

Se você entende que tem direito ao prazo de arrependimento previsto no Código de Defesa do Consumidor, entre em contato em até 7 dias depois da compra: analisamos cada caso respeitando a lei.

## Como falar com a gente
Use Suporte no menu (com o pedido anexado) ou: {{contato}}.`;

const PRIVACY = `## Quais dados coletamos
- Nome, e-mail e senha da conta (a senha é guardada de forma criptografada, nunca em texto).
- Contato de Discord ou WhatsApp que você informar para combinar entregas.
- Histórico de pedidos, mensagens de suporte e avaliações.
- Endereço de IP, usado só para segurança (limite de tentativas e prevenção de abuso).
- CPF: é exigido pelo PIX, enviado ao provedor de pagamento só para gerar a cobrança e não fica guardado na loja.

## Para que usamos
Para criar e proteger sua conta, processar pagamentos, entregar produtos, dar suporte e prevenir fraudes. Não vendemos seus dados.

## Com quem compartilhamos
- MisticPay, para gerar e confirmar o PIX.
- Provedores de hospedagem e banco de dados (Vercel e Upstash), que armazenam o site e os dados.
- Avisos internos para a equipe da loja (por exemplo, no Discord), com código do pedido, nome e produto.

## Cookies
Usamos apenas um cookie essencial de sessão para manter você logado. Não usamos cookies de publicidade.

## Seus direitos (LGPD)
Você pode pedir acesso, correção ou exclusão dos seus dados, e tirar dúvidas sobre como são tratados, pelo contato: {{contato}}. Alguns dados de pedidos podem ser mantidos pelo prazo exigido por lei.`;

const FAQ = [
  ['Como funciona a compra?', 'Escolha o produto (ou monte um carrinho), informe o CPF de quem vai pagar e gere o PIX. Pague com o QR Code ou o Copia e Cola. A confirmação é automática e a entrega aparece no seu pedido.'],
  ['Quanto tempo leva a entrega?', 'Itens em estoque e links de download são liberados na hora, assim que o PIX é confirmado. Entregas manuais (impulsos, farm de orbs, serviços) são combinadas com você pelo Discord ou WhatsApp informado no pedido.'],
  ['Quais formas de pagamento vocês aceitam?', 'PIX, com confirmação automática.'],
  ['Meu pedido expirou. E agora?', 'O estoque fica reservado por um tempo limitado. Se o PIX não for pago nesse prazo, o pedido expira e você pode fazer um novo. Se pagou no último minuto, fale com o suporte: o pagamento é conferido.'],
  ['Paguei e o pedido não liberou.', 'A página do pedido confirma sozinha em poucos segundos. Se passar de alguns minutos, abra um ticket em Suporte com o código do pedido.'],
  ['Preciso informar meu CPF? Por quê?', 'O PIX exige o CPF de quem paga. Ele é usado só para gerar a cobrança no provedor de pagamento e não fica guardado na loja.'],
  ['Como funciona a garantia?', 'Cada produto mostra se tem garantia e por quantos dias. Se algo não funcionar dentro do prazo, abra o pedido e clique em Pedir reposição.'],
  ['Posso pedir reembolso?', 'Sim, nos casos descritos na página Reembolso e garantia. Abra um ticket em Suporte explicando o motivo.'],
  ['Esqueci minha senha.', 'Fale com o suporte pelo Discord ou WhatsApp: geramos uma senha temporária para você trocar em Minha conta.'],
  ['Como falo com o suporte?', 'Em Suporte (menu), abra um ticket, de preferência ligado ao pedido. Respondemos por lá e você acompanha a conversa.'],
];

const DEFAULT_PAGES = { terms: TERMS, refund: REFUND, privacy: PRIVACY, faq: FAQ };
const fill = (t, cfg) => {
  const c = (cfg && cfg.contacts) || {};
  const contato = [c.email, c.whatsapp && `WhatsApp ${c.whatsapp}`, c.discord].filter(Boolean).join(' · ') || 'pelos canais de suporte da loja';
  return String(t).replace(/\{\{loja\}\}/g, (cfg && cfg.storeName) || 'Loja').replace(/\{\{contato\}\}/g, contato);
};
// Texto salvo no painel; se estiver vazio, usa o padrão.
function resolvePages(cfg) {
  const o = (cfg && cfg.pages) || {};
  return {
    terms: fill(o.terms || DEFAULT_PAGES.terms, cfg), refund: fill(o.refund || DEFAULT_PAGES.refund, cfg), privacy: fill(o.privacy || DEFAULT_PAGES.privacy, cfg),
    faq: (Array.isArray(o.faq) && o.faq.length ? o.faq : DEFAULT_PAGES.faq).map((x) => (Array.isArray(x) ? { q: x[0], a: fill(x[1], cfg) } : { q: x.q, a: fill(x.a, cfg) })),
  };
}
module.exports = { DEFAULT_PAGES, resolvePages };
