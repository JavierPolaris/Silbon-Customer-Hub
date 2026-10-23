import express from 'express';
import dotenv from 'dotenv';
import { processAllCustomers, addFavoriteToCustomer, getCustomerFavorites } from './updateExistingCustomers.js';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const shopifyDomain = process.env.SHOPIFY_DOMAIN;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

// Middleware para manejar JSON
app.use(express.json());
/*
 * CORS por lista blanca. Antes era origin: "*": cualquier web podia llamar a
 * esta API desde el navegador. Los mercados de silbonshop.com van por
 * subcarpeta, asi que comparten origen. Se amplia sin tocar codigo con
 * CORS_ALLOWED_ORIGINS (separado por comas). Sin cabecera Origin (webhooks,
 * curl, servidor a servidor) se deja pasar.
 */
const DEFAULT_ORIGINS = ["https://www.silbonshop.com", "https://silbonshop.com"];
export const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      cb(null, ALLOWED_ORIGINS.includes(origin));
    },
  })
);




// El registro del webhook customers/create ya no se hace al arrancar (en Lambda
// correria en cada arranque en frio y borraria/recrearia la suscripcion cada
// vez). Se ejecuta a mano una vez: node scripts/register-webhook.mjs <URL>.


// Ruta para añadir un producto a favoritos
app.post('/favorites/add', async (req, res) => {
  console.log("📌 Recibido en /favorites/add:", req.body);

  let { customerId, productId, variantId, productUrl } = req.body;

  // Convertimos productId a formato GID si es necesario
  if (productId.startsWith("gid://shopify/Product/")) {
    productId = productId.split("/").pop(); // Extrae solo el número
  }
  

  if (!customerId || !productId || !variantId || !productUrl) {
    console.error("❌ Faltan datos requeridos:", req.body);
    return res.status(400).json({ error: 'Faltan datos requeridos.' });
  }

  console.log(`📌 Procesando favorito: Producto ID: ${productId}, Variant ID: ${variantId}`);

  try {
    // addFavoriteToCustomer(customerId, productId, variantId, productUrl): antes se le
    // pasaba un objeto como productId y la petición a /products/[object Object].json fallaba.
    await addFavoriteToCustomer(customerId, productId, variantId, productUrl);
    res.status(200).json({ message: 'Producto añadido a favoritos.' });
  } catch (error) {
    console.error('❌ Error añadiendo producto a favoritos:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

app.post('/favorites/remove', async (req, res) => {
  try {
    const { customerId, productId, variantId } = req.body;
    if (!customerId || !productId) {
      return res.status(400).json({ error: 'Faltan datos requeridos.' });
    }

    // Leer favoritos actuales
    const queryGet = `
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          metafield(namespace: "custom", key: "favorites") { value }
        }
      }
    `;
    const getResp = await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: queryGet }),
    });
    const getJson = await getResp.json();
    let arr = getJson?.data?.customer?.metafield?.value ? JSON.parse(getJson.data.customer.metafield.value) : [];

    // Filtrar
    arr = arr.filter(f => !(String(f.productId) === String(productId) && (!variantId || String(f.variantId) === String(variantId))));

    // Guardar
    const queryUpdate = `
      mutation {
        customerUpdate(
          input: {
            id: "gid://shopify/Customer/${customerId}"
            metafields: [{
              namespace: "custom",
              key: "favorites",
              value: "${JSON.stringify(arr).replace(/"/g, '\\"')}",
              type: "json"
            }]
          }
        ) {
          userErrors { field message }
        }
      }
    `;
    const updResp = await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: queryUpdate }),
    });
    const updJson = await updResp.json();

    if (updJson?.data?.customerUpdate?.userErrors?.length) {
      return res.status(400).json({ error: 'Shopify error', details: updJson.data.customerUpdate.userErrors });
    }

    res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno.' });
  }
});



// Ruta para obtener los favoritos del cliente
app.get('/favorites', async (req, res) => {
  const { customerId } = req.query;

  if (!customerId) {
    return res.status(400).json({ error: 'Faltan datos requeridos.' });
  }

  try {
    const favorites = await getCustomerFavorites(customerId);
    res.status(200).json({ favorites });
  } catch (error) {
    console.error('Error obteniendo favoritos del cliente:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Ruta para servir el favicon desde la raíz del proyecto
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.ico'));
});

// Ruta para manejar el webhook de Shopify
app.post('/webhooks/customers/create', async (req, res) => {
  console.log("📌 Webhook recibido en /webhooks/customers/create");

  const customerId = req.body.id;

  if (!customerId) {
    console.error("❌ No se recibió customerId en el webhook.");
    return res.status(400).json({ error: "Faltan datos del cliente en el webhook." });
  }

  console.log(`📌 ID del cliente recibido: ${customerId}`);

  try {
    const response = await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: `
          query {
            customer(id: "gid://shopify/Customer/${customerId}") {
              email
            }
          }
        `,
      }),
    });

    const data = await response.json();
    console.log("📌 Respuesta de Shopify:", data);

    if (!data.data.customer) {
      return res.status(404).json({ error: "Cliente no encontrado en Shopify." });
    }

    res.status(200).json({ message: "Webhook procesado correctamente." });
  } catch (error) {
    console.error("❌ Error procesando webhook:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// Ruta por defecto para capturar solicitudes no manejadas
app.use((req, res) => {
  res.status(404).send('Ruta no encontrada. Verifica la URL.');
});
// Inicia el servidor solo fuera de Lambda (server/lambda.mjs importa la app).
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export { app };
