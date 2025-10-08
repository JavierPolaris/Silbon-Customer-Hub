import express from 'express';
import fetch from 'node-fetch';
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
app.use(cors({ origin: '*' }));




// Función para registrar el webhook
// Función para eliminar webhooks existentes antes de registrar uno nuevo
const deleteExistingWebhooks = async () => {
  const query = `
    query {
      webhookSubscriptions(first: 100, topics: [CUSTOMERS_CREATE])
 {
        edges {
          node {
            id
            callbackUrl
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    const webhooks = data.data.webhookSubscriptions.edges;

    for (const webhook of webhooks) {
      console.log(`📌 Eliminando webhook con ID: ${webhook.node.id} - URL: ${webhook.node.callbackUrl}`);
      await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({
          query: `
            mutation {
              webhookSubscriptionDelete(id: "${webhook.node.id}") {
                deletedWebhookSubscriptionId
                userErrors {
                  field
                  message
                }
              }
            }
          `,
        }),
      });
    }

    console.log("✅ Webhooks existentes eliminados correctamente.");
  } catch (error) {
    console.error("❌ Error al eliminar webhooks:", error);
  }
};

// Modificar la función de registrar webhook para eliminar antes de registrar
const registerWebhook = async () => {
  await deleteExistingWebhooks(); // Primero eliminamos los webhooks antiguos

 const baseUrl = process.env.WEBHOOK_BASE_URL 
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`);

const webhookEndpoint = `${baseUrl}/webhooks/customers/create`;


  const query = `
    mutation {
      webhookSubscriptionCreate(
        topic: CUSTOMERS_CREATE,
        webhookSubscription: {
          format: JSON,
          callbackUrl: "${webhookEndpoint}"
        }
      ) {
        userErrors {
          field
          message
        }
        webhookSubscription {
          id
        }
      }
    }
  `;

  try {
    const response = await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    console.log('📌 Respuesta de registro de webhook:', JSON.stringify(data, null, 2));

    if (data.errors || data.data.webhookSubscriptionCreate.userErrors.length) {
      console.error('❌ Error al registrar webhook:', JSON.stringify(data.data.webhookSubscriptionCreate.userErrors, null, 2));
    } else {
      console.log('✅ Webhook registrado con éxito:', data.data.webhookSubscriptionCreate.webhookSubscription.id);
    }
  } catch (error) {
    console.error('❌ Error al registrar webhook:', error);
  }
};

// Ejecutar el registro del webhook
registerWebhook();


// Ruta para añadir un producto a favoritos
app.post('/favorites/add', async (req, res) => {
  console.log("📌 Token usado:", accessToken);

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

  const favorite = { productId, variantId, productUrl };

  try {
    await addFavoriteToCustomer(customerId, favorite);
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
// Inicia el servidor
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
