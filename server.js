import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const shopifyDomain = process.env.SHOPIFY_DOMAIN;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

// Middleware para manejar JSON
app.use(express.json());

// Ruta para manejar el webhook
app.post('/webhooks/customers/create', async (req, res) => {
  const customerId = req.body.id;

  // Consulta para obtener el valor de marketingState
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
    // Realiza la solicitud para obtener el marketingState
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

    // Consulta para actualizar el metafield con el marketingState
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

    // Realiza la solicitud para actualizar el metafield
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

// Inicia el servidor
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
