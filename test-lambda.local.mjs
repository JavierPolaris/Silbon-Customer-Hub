// test-lambda.local.mjs
// Invoca el handler de Lambda con eventos sintéticos de API Gateway HTTP API
// (payload v2), sin red: fetch queda interceptado con un mock de la Admin API
// de Shopify y cualquier URL no prevista hace fallar la prueba.
//
//   npm run test:lambda

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Variables de mentira. Sin SECRETS_SSM_PREFIX el cargador no toca SSM.
// AWS_LAMBDA_FUNCTION_NAME evita que server.js abra un puerto.
delete process.env.SECRETS_SSM_PREFIX;
Object.assign(process.env, {
  AWS_LAMBDA_FUNCTION_NAME: 'test-local',
  SHOPIFY_DOMAIN: 'ejemplo.myshopify.com',
  SHOPIFY_ACCESS_TOKEN: 'shpat_de_mentira',
});

// Mock de Shopify: un cliente con dos favoritos y un producto.
const calls = [];
const storedFavorites = [
  { productId: '111', variantId: '1111', productUrl: '/products/uno' },
  { productId: '222', variantId: '2222', productUrl: '/products/dos' },
];
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  calls.push({ url: u, method: options.method || 'GET', body: options.body });
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

  if (u === 'https://ejemplo.myshopify.com/admin/api/2024-10/graphql.json') {
    assert.equal(options.headers['X-Shopify-Access-Token'], 'shpat_de_mentira');
    const { query } = JSON.parse(options.body);
    if (query.includes('customerUpdate')) {
      return json({ data: { customerUpdate: { customer: { id: 'gid://shopify/Customer/1' }, userErrors: [] } } });
    }
    if (query.includes('metafield(namespace: "custom", key: "favorites")')) {
      return json({ data: { customer: { metafield: { id: 'gid://shopify/Metafield/1', value: JSON.stringify(storedFavorites) } } } });
    }
    if (query.includes('customer(id:') && query.includes('email')) {
      return json({ data: { customer: { email: 'cliente@example.com' } } });
    }
  }
  if (u === 'https://ejemplo.myshopify.com/admin/api/2024-10/products/333.json') {
    return json({
      product: {
        title: 'Producto tres', available: true,
        images: [{ src: 'https://cdn.example/tres.jpg' }],
        variants: [{ id: 3333, price: '10.00', compare_at_price: '20.00' }],
      },
    });
  }
  throw new Error(`fetch no previsto en la prueba: ${options.method || 'GET'} ${u}`);
};

const { handler } = await import('./server/lambda.mjs');

function makeEvent({ method, path, headers = {}, body, query = '' }) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: query,
    headers: { host: 'pruebas.execute-api.eu-central-1.amazonaws.com', ...headers },
    queryStringParameters: query ? Object.fromEntries(new URLSearchParams(query)) : undefined,
    requestContext: {
      accountId: '123456789012',
      apiId: 'pruebas',
      domainName: 'pruebas.execute-api.eu-central-1.amazonaws.com',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: crypto.randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded: false,
  };
}

const context = { awsRequestId: 'local', getRemainingTimeInMillis: () => 10000 };
let failures = 0;
async function check(name, fn) {
  calls.length = 0;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

console.log('Pruebas del handler de Lambda (sin red):');

await check('GET /favorites?customerId=1 -> 200 { favorites: [...] } como hoy', async () => {
  const res = await handler(makeEvent({ method: 'GET', path: '/favorites', query: 'customerId=1' }), context);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { favorites: storedFavorites });
});

await check('GET /favorites sin customerId -> 400', async () => {
  const res = await handler(makeEvent({ method: 'GET', path: '/favorites' }), context);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'Faltan datos requeridos.' });
  assert.equal(calls.length, 0);
});

await check('POST /favorites/add con body válido -> 200 y llama al mock de Shopify', async () => {
  const body = JSON.stringify({
    customerId: '1', productId: 'gid://shopify/Product/333', variantId: '3333', productUrl: '/products/tres',
  });
  const res = await handler(
    makeEvent({
      method: 'POST', path: '/favorites/add',
      headers: { 'content-type': 'application/json', origin: 'https://www.silbonshop.com' },
      body,
    }),
    context
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { message: 'Producto añadido a favoritos.' });
  assert.equal(res.headers['access-control-allow-origin'], 'https://www.silbonshop.com');
  assert.ok(calls.some((c) => c.url.endsWith('/products/333.json')), 'esperaba la consulta del producto 333');
  const update = calls.find((c) => c.body && JSON.parse(c.body).query.includes('customerUpdate'));
  assert.ok(update, 'esperaba customerUpdate con el favorito nuevo');
  assert.ok(JSON.parse(update.body).query.includes('Producto tres'), 'el favorito nuevo debía llevar el título del producto');
});

await check('POST /favorites/add sin datos -> 400 sin llamar a Shopify', async () => {
  const res = await handler(
    makeEvent({
      method: 'POST', path: '/favorites/add',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: '1', productId: '333' }),
    }),
    context
  );
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

await check('POST /favorites/remove -> 200 { success: true } y guarda la lista filtrada', async () => {
  const res = await handler(
    makeEvent({
      method: 'POST', path: '/favorites/remove',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: '1', productId: '111' }),
    }),
    context
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { success: true });
  const update = calls.find((c) => c.body && JSON.parse(c.body).query.includes('customerUpdate'));
  assert.ok(update, 'esperaba customerUpdate');
  assert.ok(!JSON.parse(update.body).query.includes('/products/uno'), 'el favorito 111 debía desaparecer');
  assert.ok(JSON.parse(update.body).query.includes('/products/dos'), 'el favorito 222 debía quedarse');
});

await check('OPTIONS preflight desde silbonshop.com -> Allow-Origin; otro origen no', async () => {
  const ok = await handler(
    makeEvent({
      method: 'OPTIONS', path: '/favorites/add',
      headers: { origin: 'https://www.silbonshop.com', 'access-control-request-method': 'POST' },
    }),
    context
  );
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://www.silbonshop.com');
  const bad = await handler(
    makeEvent({
      method: 'OPTIONS', path: '/favorites/add',
      headers: { origin: 'https://malo.example', 'access-control-request-method': 'POST' },
    }),
    context
  );
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
});

await check('POST /webhooks/customers/create con id -> 200 y consulta el cliente', async () => {
  const res = await handler(
    makeEvent({
      method: 'POST', path: '/webhooks/customers/create',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, email: 'cliente@example.com' }),
    }),
    context
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { message: 'Webhook procesado correctamente.' });
  assert.equal(calls.length, 1);
});

await check('Ruta desconocida -> 404', async () => {
  const res = await handler(makeEvent({ method: 'GET', path: '/no-existe' }), context);
  assert.equal(res.statusCode, 404);
});

if (failures > 0) {
  console.log(`\n${failures} prueba(s) fallida(s).`);
  process.exit(1);
}
console.log('\nTodo correcto.');
