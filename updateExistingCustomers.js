import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const shopifyDomain = process.env.SHOPIFY_DOMAIN;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

// Función para retrasar la ejecución
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Función para manejar reintentos
const fetchWithRetry = async (url, options, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response;
    } catch (error) {
      console.error(`Error en el intento ${i + 1}:`, error);
      if (i === retries - 1) throw error;
      await delay(500); // Espera antes de reintentar
    }
  }
};

// Ajusta cómo se procesa el customerId para evitar duplicados
const processCustomer = async (customer) => {
  // Elimina la lógica redundante que agrega el prefijo de nuevo
  const customerId = customer.id;

  const queryGetMarketingState = `
    query {
      customer(id: "${customerId}") {
        emailMarketingConsent {
          marketingState
        }
      }
    }
  `;

  try {
    const responseGet = await fetchWithRetry(
      `https://${shopifyDomain}/admin/api/2024-10/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query: queryGetMarketingState }),
      }
    );

    const dataGet = await responseGet.json();

    if (!dataGet.data || !dataGet.data.customer) {
      console.error(`❌ Cliente no encontrado o datos inválidos para ID: ${customerId}`);
      console.error('📌 Respuesta de Shopify:', dataGet);
      return;
    }

    const marketingState = dataGet.data.customer.emailMarketingConsent?.marketingState;

    console.log(`📌 Marketing State obtenido para ${customerId}: ${marketingState}`);

    // Continúa con el resto del procesamiento...
  } catch (error) {
    console.error(`❌ Error procesando cliente ${customerId}:`, error);
  }
};

  

// Función para recorrer todos los clientes
export const processAllCustomers = async () => {
  let cursor = null;

  do {
    const query = `
      query {
        customers(first: 250, after: ${cursor ? `"${cursor}"` : null}) {
          edges {
            cursor
            node {
              id
              email
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    try {
      const response = await fetchWithRetry(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query }),
      });

      const data = await response.json();

      if (!data.data || !data.data.customers) {
        console.error('No se pudieron obtener clientes.');
        console.error('Respuesta completa:', data);
        break;
      }

      const customers = data.data.customers.edges;

      for (const customer of customers) {
        await processCustomer(customer.node); // Procesar cada cliente
        await delay(300); // Retraso entre solicitudes para evitar límites de velocidad
      }

      cursor = customers[customers.length - 1]?.cursor; // Actualizar el cursor
      const hasNextPage = data.data.customers.pageInfo.hasNextPage;

      if (!hasNextPage) break;
    } catch (error) {
      console.error('Error procesando clientes:', error);
      break; // Detener el procesamiento en caso de error
    }
  } while (cursor);

  console.log('Procesamiento de todos los clientes completado.');
};


// Guardar un producto en el metafield `favorites`
export const addFavoriteToCustomer = async (customerId, productId, variantId, productUrl) => {
  const queryGetFavorites = `
    query {
      customer(id: "gid://shopify/Customer/${customerId}") {
        metafield(namespace: "custom", key: "favorites") {
          id
          value
        }
      }
    }
  `;

  try {
      // Obtener los favoritos actuales
      const responseGet = await fetchWithRetry(
          `https://${shopifyDomain}/admin/api/2024-10/graphql.json`,
          {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'X-Shopify-Access-Token': accessToken,
              },
              body: JSON.stringify({ query: queryGetFavorites }),
          }
      );

      const dataGet = await responseGet.json();
      let currentFavorites = dataGet.data.customer.metafield
          ? JSON.parse(dataGet.data.customer.metafield.value || '[]')
          : [];

      // 📌 Verificar si el producto ya está en favoritos para evitar duplicados
      if (currentFavorites.some((fav) => fav.productId === productId)) {
          console.log(`⚠️ El producto ${productId} ya está en favoritos.`);
          return;
      }

      // 📌 Obtener la información del producto desde Shopify
      const productResponse = await fetch(`https://${shopifyDomain}/admin/api/2024-10/products/${productId}.json`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
      });
      

      const productData = await productResponse.json();
      console.log("📌 Respuesta de Shopify para el producto:", JSON.stringify(productData, null, 2)); 



      if (!productData.product) {
          console.error(`❌ No se encontró el producto ${productId} en Shopify.`);
          return;
      }

      const product = productData.product;
      const variant = product.variants.find(v => v.id == variantId) || product.variants[0];

      // 📌 Calcular el descuento
      const discount = variant.compare_at_price && variant.compare_at_price > variant.price
          ? Math.round((variant.compare_at_price - variant.price) * 100 / variant.compare_at_price)
          : null;

      // 📌 Nuevo objeto con toda la información
      const favorite = {
          productId,
          variantId,
          productUrl,
          title: product.title,
          imageUrl: product.images.length ? product.images[0].src : 'https://via.placeholder.com/150',
          price: variant.price,
          compareAtPrice: variant.compare_at_price || null,
          discount: discount,
          available: product.available
      };

      // 📌 Agregar el producto a favoritos
      currentFavorites.push(favorite);

      const queryUpdateFavorites = `
        mutation {
          customerUpdate(
            input: {
              id: "gid://shopify/Customer/${customerId}"
              metafields: [
                {
                  namespace: "custom"
                  key: "favorites"
                  value: "${JSON.stringify(currentFavorites).replace(/"/g, '\\"')}"
                  type: "json"
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

      const responseUpdate = await fetchWithRetry(
          `https://${shopifyDomain}/admin/api/2024-10/graphql.json`,
          {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'X-Shopify-Access-Token': accessToken,
              },
              body: JSON.stringify({ query: queryUpdateFavorites }),
          }
      );

      const dataUpdate = await responseUpdate.json();
      if (dataUpdate.data.customerUpdate.userErrors.length) {
          console.error('❌ Errores al actualizar el metafield:', dataUpdate.data.customerUpdate.userErrors);
      } else {
          console.log(`✅ Metafield actualizado con éxito para el cliente ${customerId}`);
      }
  } catch (error) {
      console.error(`❌ Error actualizando favoritos del cliente ${customerId}:`, error);
  }
};



// Leer los favoritos del cliente
export const getCustomerFavorites = async (customerId) => {
  const queryGetFavorites = `
    query {
      customer(id: "gid://shopify/Customer/${customerId}") {
        metafield(namespace: "custom", key: "favorites") {
          value
        }
      }
    }
  `;

  try {
    const response = await fetchWithRetry(
      `https://${shopifyDomain}/admin/api/2024-10/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query: queryGetFavorites }),
      }
    );

    const data = await response.json();
    return data.data.customer.metafield
      ? JSON.parse(data.data.customer.metafield.value)
      : [];
  } catch (error) {
    console.error(`Error obteniendo favoritos del cliente ${customerId}:`, error);
    return [];
  }
};





