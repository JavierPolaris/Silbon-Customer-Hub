import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const shopifyDomain = process.env.SHOPIFY_DOMAIN;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

// Ruta para manejar el webhook
app.post('/webhooks/customers/create', async (req, res) => {
    const customerId = req.body.id;
  
    const query = `
      mutation {
        customerUpdate(
          input: {
            id: "gid://shopify/Customer/${customerId}"
            metafields: [
              {
                namespace: "custom"
                key: "marketing_state"
                value: "SUBSCRIBED"
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
  
    try {
      const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query }),
      });
  
      const data = await response.json();
      console.log('Metafield updated:', data);
      res.status(200).send('Webhook processed');
    } catch (error) {
      console.error('Error updating metafield:', error);
      res.status(500).send('Internal server error');
    }
  }); 
   
  // Inicia el servidor
  app.listen(3000, () => {
    console.log('Server running on port 3000');
  });  

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
