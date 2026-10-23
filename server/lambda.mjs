// server/lambda.mjs
// Handler de AWS Lambda para API Gateway HTTP API (payload v2).
//
// serverless-http convierte el evento de API Gateway en un req/res de Node y
// se lo pasa a la app de Express tal cual. Las rutas y las respuestas son las
// mismas que en Vercel.
//
// Orden importante: los secretos se cargan ANTES de importar server.js, porque
// server.js y updateExistingCustomers.js leen process.env.SHOPIFY_ACCESS_TOKEN
// al evaluarse el módulo (constantes en la cabecera), no en cada petición.

import serverless from 'serverless-http';
import { loadSecrets } from './secrets.mjs';

await loadSecrets();
const { app } = await import('../server.js');

export const handler = serverless(app);
