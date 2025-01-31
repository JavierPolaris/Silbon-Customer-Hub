import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { processAllCustomers } from './updateExistingCustomers.js'; // Importa tu código existente

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const shopifyDomain = process.env.SHOPIFY_DOMAIN;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

// Middleware para manejar JSON
app.use(express.json());

// Función para registrar el webhook
const registerWebhook = async () => {
  const webhookEndpoint = `https://${process.env.VERCEL_URL || 'your-vercel-app.vercel.app'}/webhooks/customers/create`;

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
    console.log('Webhook registration response:', data);

    if (data.errors || data.data.webhookSubscriptionCreate.userErrors.length) {
      console.error('Error registering webhook:', data);
    } else {
      console.log('Webhook registered successfully:', data.data.webhookSubscriptionCreate.webhookSubscription.id);
    }
  } catch (error) {
    console.error('Error registering webhook:', error);
  }
};

// Llama a la función para registrar el webhook
registerWebhook();

// Ruta para manejar el webhook
app.post('/webhooks/customers/create', async (req, res) => {
  const customerId = req.body.id;

  const queryGetMarketingState = `
    query {
      customer(id: "gid://shopify/Customer/${customerId}") {
        emailMarketingConsent {
          marketingState
        }
      }
    }
  `;

  try {
    const responseGet = await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: queryGetMarketingState }),
    });

    const dataGet = await responseGet.json();
    const marketingState = dataGet.data.customer.emailMarketingConsent.marketingState;

    console.log(`Marketing State obtenido: ${marketingState}`);

    const queryUpdateMetafield = `
      mutation {
        customerUpdate(
          input: {
            id: "gid://shopify/Customer/${customerId}"
            metafields: [
              {
                namespace: "custom"
                key: "marketing_state"
                value: "${marketingState}"
                type: "single_line_text_field"
              }
            ]
          }
        ) {
          customer {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const responseUpdate = await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: queryUpdateMetafield }),
    });

    const dataUpdate = await responseUpdate.json();
    console.log('Metafield actualizado:', dataUpdate);

    res.status(200).send('Webhook processed and metafield updated');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Internal server error');
  }
});

// Ruta para añadir un producto a favoritos
app.post('/favorites/add', async (req, res) => {
  const { customerId, productId, variantId, productUrl } = req.body;

  if (!customerId || !productId || !variantId || !productUrl) {
    return res.status(400).json({ error: 'Faltan datos requeridos.' });
  }

  const favorite = { productId, variantId, productUrl };
  try {
    await addFavoriteToCustomer(customerId, favorite);
    res.status(200).json({ message: 'Producto añadido a favoritos.' });
  } catch (error) {
    console.error('Error añadiendo producto a favoritos:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
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


// Inicia el servidor
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
