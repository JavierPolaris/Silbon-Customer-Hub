// scripts/register-webhook.mjs
// Registra en Shopify el webhook customers/create apuntando a esta API.
// Antes lo hacía server.js en cada arranque (borraba TODAS las suscripciones
// a CUSTOMERS_CREATE de la app y creaba una nueva). Ahora se ejecuta a mano,
// una vez, tras el primer despliegue o si cambia la URL:
//
//   node scripts/register-webhook.mjs https://favoritos.silbon.es
//
// Lee SHOPIFY_DOMAIN y SHOPIFY_ACCESS_TOKEN del entorno (.env sirve) o, si
// hay SECRETS_SSM_PREFIX (p. ej. /silbon/favoritos), el token de SSM.
// Mismas consultas y mutaciones que tenía server.js; solo cambia dónde viven.

import dotenv from 'dotenv';
import { loadSecrets } from '../server/secrets.mjs';

dotenv.config();
await loadSecrets();

const baseUrl = (process.argv[2] || process.env.WEBHOOK_BASE_URL || '').replace(/\/+$/, '');
const shopifyDomain = process.env.SHOPIFY_DOMAIN;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

if (!baseUrl || !shopifyDomain || !accessToken) {
  console.error('Uso: node scripts/register-webhook.mjs <URL base de la API>');
  console.error('Hacen falta SHOPIFY_DOMAIN y SHOPIFY_ACCESS_TOKEN (entorno o SSM).');
  process.exit(1);
}

const endpoint = `https://${shopifyDomain}/admin/api/2024-10/graphql.json`;

async function graphql(query) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query }),
  });
  return response.json();
}

// 1. Eliminar las suscripciones existentes de esta app a CUSTOMERS_CREATE
const existing = await graphql(`
  query {
    webhookSubscriptions(first: 100, topics: [CUSTOMERS_CREATE]) {
      edges { node { id endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
    }
  }
`);
for (const { node } of existing?.data?.webhookSubscriptions?.edges || []) {
  console.log(`Eliminando ${node.id} -> ${node.endpoint?.callbackUrl || '?'}`);
  const del = await graphql(`
    mutation { webhookSubscriptionDelete(id: "${node.id}") { deletedWebhookSubscriptionId userErrors { field message } } }
  `);
  const errors = del?.data?.webhookSubscriptionDelete?.userErrors || [];
  if (errors.length) console.error('  Error al eliminar:', JSON.stringify(errors));
}

// 2. Crear la nueva
const callbackUrl = `${baseUrl}/webhooks/customers/create`;
const created = await graphql(`
  mutation {
    webhookSubscriptionCreate(
      topic: CUSTOMERS_CREATE,
      webhookSubscription: { format: JSON, callbackUrl: "${callbackUrl}" }
    ) {
      userErrors { field message }
      webhookSubscription { id }
    }
  }
`);
const result = created?.data?.webhookSubscriptionCreate;
if (!result || created.errors || result.userErrors.length) {
  console.error('Error al registrar el webhook:', JSON.stringify(created, null, 2));
  process.exit(1);
}
console.log(`Webhook registrado: ${result.webhookSubscription.id} -> ${callbackUrl}`);
